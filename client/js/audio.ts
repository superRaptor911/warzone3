interface ShotCfg { nDur: number; nGain: number; f0: number; fDur: number; thump: number }

const SHOT_CFG: Record<string, ShotCfg> = {
  pistol: { nDur: 0.09, nGain: 0.5, f0: 220, fDur: 0.07, thump: 0.25 },
  smg: { nDur: 0.06, nGain: 0.38, f0: 260, fDur: 0.05, thump: 0.18 },
  rifle: { nDur: 0.1, nGain: 0.55, f0: 190, fDur: 0.09, thump: 0.3 },
  shotgun: { nDur: 0.18, nGain: 0.8, f0: 130, fDur: 0.16, thump: 0.5 },
  sniper: { nDur: 0.25, nGain: 0.9, f0: 100, fDur: 0.22, thump: 0.6 },
};

// Procedurally synthesized sounds via WebAudio — no assets needed.
export class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;

  ensure(): void {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // gain/pan from world offset relative to camera center
  spatial(dx: number, dy: number): { gain: number; pan: number } {
    const d = Math.hypot(dx, dy);
    const gain = Math.max(0.06, 1 - d / 1000);
    const pan = Math.max(-0.8, Math.min(0.8, dx / 700));
    return { gain, pan };
  }

  node(gain: number, pan = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p); p.connect(this.master!);
    return g;
  }

  noiseBuf(dur: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  shot(weapon: string, gain = 1, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const cfg = SHOT_CFG[weapon] || { nDur: 0.08, nGain: 0.5, f0: 200, fDur: 0.08, thump: 0.25 };

    // crack (filtered noise)
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf(cfg.nDur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass'; bp.frequency.value = 3200;
    const g = this.node(cfg.nGain * gain, pan);
    g.gain.setValueAtTime(cfg.nGain * gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + cfg.nDur);
    src.connect(bp); bp.connect(g);
    src.start(t);
    // thump (sine drop)
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(cfg.f0, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + cfg.fDur);
    const og = this.node(cfg.thump * gain, pan);
    og.gain.setValueAtTime(cfg.thump * gain, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + cfg.fDur);
    osc.connect(og);
    osc.start(t); osc.stop(t + cfg.fDur + 0.02);
  }

  click(gain = 0.3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1800;
    const g = this.node(gain);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(g); osc.start(t); osc.stop(t + 0.04);
  }

  hitmarker(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.05);
    const g = this.node(0.25);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g); osc.start(t); osc.stop(t + 0.07);
  }

  hurt(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.15);
    const g = this.node(0.35);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g); osc.start(t); osc.stop(t + 0.16);
  }

  growl(gain: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f = 55 + Math.random() * 40;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * 0.7, t + 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 300;
    const g = this.node(gain * 0.4, pan);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * 0.4, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(lp); lp.connect(g);
    osc.start(t); osc.stop(t + 0.5);
  }

  zdie(gain: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf(0.15);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = this.node(gain * 0.5, pan);
    g.gain.setValueAtTime(gain * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    src.connect(lp); lp.connect(g); src.start(t);
  }

  waveHorn(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = i === 0 ? 220 : 165;
      const g = this.node(0.16);
      g.gain.setValueAtTime(0.0001, t + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.16, t + i * 0.35 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.35 + 0.32);
      osc.connect(g); osc.start(t + i * 0.35); osc.stop(t + i * 0.35 + 0.35);
    }
  }

  cash(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [i, f] of [[0, 880], [1, 1320]].values()) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = f;
      const g = this.node(0.18);
      g.gain.setValueAtTime(0.18, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.09);
      osc.connect(g); osc.start(t + i * 0.07); osc.stop(t + i * 0.07 + 0.1);
    }
  }
}
