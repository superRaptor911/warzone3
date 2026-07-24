import type { Snapshot, WelcomeMsg } from '../../shared/types.ts';

// WebSocket client wrapper.
export class Net {
  ws: WebSocket | null = null;
  onWelcome: ((m: WelcomeMsg) => void) | null = null;
  onSnap: ((s: Snapshot, when: number) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  connected = false;

  connect(joinMsg: object): void {
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
      else if (m.t === 'full') { this.connected = false; this.onClose?.('Room is full'); }
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

  close(): void { this.connected = false; this.ws?.close(); }
}
