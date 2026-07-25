import type { Snapshot, WelcomeMsg } from '../../shared/types.ts';

// WebSocket client wrapper.
const PING_EVERY_MS = 1000;

export class Net {
  ws: WebSocket | null = null;
  onWelcome: ((m: WelcomeMsg) => void) | null = null;
  onSnap: ((s: Snapshot, when: number) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  connected = false;
  ping = 0;          // smoothed RTT in ms, 0 until the first pong
  nextPingAt = 0;    // perf-clock time of the next probe

  connect(joinMsg: object): void {
    this.ping = 0;
    this.nextPingAt = 0;
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
        const rtt = performance.now() - m.ts;
        this.ping = this.ping === 0 ? rtt : this.ping * 0.7 + rtt * 0.3;
      } else if (m.t === 'full') { this.connected = false; this.onClose?.('Room is full'); }
    };
    this.ws.onclose = () => {
      if (this.connected) { this.connected = false; this.onClose?.('Disconnected from server'); }
      else this.onClose?.('Could not connect');
    };
    this.ws.onerror = () => {};
  }

  send(obj: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // Driven from the render loop (no interval to leak across reconnects): sends
  // one RTT probe per second, carrying the perf-clock time it left.
  pingTick(now: number): void {
    if (now < this.nextPingAt) return;
    this.nextPingAt = now + PING_EVERY_MS;
    this.send({ t: 'ping', ts: now });
  }

  close(): void { this.connected = false; this.ws?.close(); }
}
