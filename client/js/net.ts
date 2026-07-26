import type { Snapshot, WelcomeMsg } from '../../shared/types.ts';

// WebSocket client wrapper.
const PING_EVERY_MS = 1000;

export class Net {
  ws: WebSocket | null = null;
  onWelcome: ((m: WelcomeMsg) => void) | null = null;
  onSnap: ((s: Snapshot, when: number) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  connected = false;
  // Smoothed RTT in ms, negative until the first pong. 0 has to stay a *valid*
  // reading, not the "no data yet" sentinel: on a LAN the real RTT is a
  // fraction of a millisecond, and conflating the two made the readout show
  // "— ms" on a link that was in fact working perfectly.
  ping = -1;
  nextPingAt = 0;    // perf-clock time of the next probe
  /**
   * Set by quit(). Without it an intentional exit reports "Could not connect":
   * closing the socket clears `connected` before `onclose` runs, which is
   * exactly the state a failed dial leaves behind.
   */
  quitting = false;
  /**
   * What a deliberate quit should report. Empty for a player leaving on purpose
   * (nothing to say); set when we are the ones aborting and the player needs to
   * know why — a caller cannot just write the message itself after calling
   * quit(), because `onclose` fires a task later and would overwrite it.
   */
  private quitReason = '';

  connect(joinMsg: object): void {
    this.ping = -1;
    this.nextPingAt = 0;
    this.quitting = false;
    this.quitReason = '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}`);
    this.ws.onopen = () => {
      this.connected = true;
      this.send(joinMsg);
    };
    this.ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome' && this.onWelcome) this.onWelcome(m);
      else if (m.t === 'snap' && this.onSnap) this.onSnap(m, performance.now());
      else if (m.t === 'pong') {
        // Clamp at 0 rather than trusting the subtraction: the two samples come
        // from one clock, but nothing in the platform guarantees the send stamp
        // isn't quantised ahead of the receive one, and a negative reading is
        // indistinguishable from "no pong yet" downstream.
        const rtt = Math.max(0, performance.now() - m.ts);
        if (!Number.isFinite(rtt)) return;
        this.ping = this.ping < 0 ? rtt : this.ping * 0.7 + rtt * 0.3;
      } else if (m.t === 'full') { this.connected = false; this.onClose?.('Room is full'); }
      // Callsigns are claimed once and owned, so a first join can be refused.
      // The menu checks availability before connecting, which leaves this for
      // the race (two sockets claiming one name in the same millisecond) and for
      // a client that skipped the check.
      else if (m.t === 'namebad') {
        this.connected = false;
        this.onClose?.(m.why === 'reserved'
          ? 'That callsign is reserved'
          : 'That callsign was just taken — pick another');
      }
    };
    this.ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      // '' when the player left on purpose; a reason when WE aborted the match.
      if (this.quitting) this.onClose?.(this.quitReason);
      else if (was) this.onClose?.('Disconnected from server');
      else this.onClose?.('Could not connect');
    };
    this.ws.onerror = () => {};
  }

  send(obj: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // Driven from the render loop (no interval to leak across reconnects): sends
  // one RTT probe per second, carrying the perf-clock time it left.
  //
  // `now` schedules the probe but must NOT be the stamp: it is the rAF frame
  // timestamp — the frame's *start*, which trails performance.now() by 1-17ms
  // in the render loop (measured) and, being vsync-derived, is not guaranteed
  // to trail it at all on every engine. The pong is measured against
  // performance.now(), so stamp with the same clock and mix nothing in.
  pingTick(now: number): void {
    if (now < this.nextPingAt) return;
    this.nextPingAt = now + PING_EVERY_MS;
    this.send({ t: 'ping', ts: performance.now() });
  }

  /**
   * Leave on purpose. The server's own `close` handler frees the slot and emits
   * the `leave` event, so there is nothing to send first.
   *
   * `reason` is for the case where the client is aborting rather than the player
   * leaving — it reaches onClose instead of the silent ''. Pass it here rather
   * than writing the menu text after calling quit(): `onclose` runs a task later
   * and would overwrite anything written in the meantime.
   */
  quit(reason = ''): void { this.quitting = true; this.quitReason = reason; this.ws?.close(); }
}
