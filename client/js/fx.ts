import type { WeaponId } from '../../shared/weapons.ts';

interface Spark { x: number; y: number; vx: number; vy: number; life: number; ttl: number; color: string; size: number }
interface Tracer { x0: number; y0: number; x1: number; y1: number; life: number; ttl: number; w: number }
interface FloatText { x: number; y: number; vy: number; life: number; ttl: number; text: string; color: string }
interface Flash { x: number; y: number; angle: number; life: number; ttl: number }
interface Corpse { x: number; y: number; kind: 'player' | 'zombie'; life: number; ttl: number; rot: number }
interface Glow { x: number; y: number; life: number; ttl: number; radius: number; color: string }
interface Shell { x: number; y: number; vx: number; vy: number; rot: number; vr: number; life: number; ttl: number }
interface Smoke { x: number; y: number; vx: number; vy: number; size: number; life: number; ttl: number }

// Particles, tracers, damage numbers, corpses, screenshake.
export class Fx {
  sparks: Spark[] = [];
  tracers: Tracer[] = [];
  floats: FloatText[] = [];
  flashes: Flash[] = [];
  corpses: Corpse[] = [];
  glows: Glow[] = [];   // light pulses (muzzle flashes lighting the room)
  shells: Shell[] = []; // ejected casings, rest on the floor then fade
  smoke: Smoke[] = [];  // muzzle smoke puffs
  shake = 0;

  addShake(amt: number): void { this.shake = Math.min(18, this.shake + amt); }

  tracer(x0: number, y0: number, x1: number, y1: number, weapon: WeaponId): void {
    const w = weapon === 'sniper' ? 3 : weapon === 'shotgun' ? 1.2 : 2;
    this.tracers.push({ x0, y0, x1, y1, life: 0.09, ttl: 0.09, w });
  }

  muzzle(x: number, y: number, angle: number): void {
    this.flashes.push({ x, y, angle, life: 0.055, ttl: 0.055 });
    // light pulse outlives the visual flash so the strobe reads
    this.glows.push({ x, y, life: 0.18, ttl: 0.18, radius: 300, color: '#ffc964' });
    // casing ejects sideways, tumbles, rests on the floor
    const ej = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const ev = 90 + Math.random() * 70;
    this.shells.push({
      x, y, vx: Math.cos(ej) * ev, vy: Math.sin(ej) * ev,
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 24, life: 20, ttl: 20,
    });
    for (let i = 0; i < 2; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5;
      const v = 30 + Math.random() * 50;
      this.smoke.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        size: 5 + Math.random() * 4, life: 0.9 + Math.random() * 0.4, ttl: 1.3,
      });
    }
  }

  sparksAt(x: number, y: number, color: string, n = 5, speed = 160): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.sparks.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.25 + Math.random() * 0.2, ttl: 0.45, color,
        size: 1.5 + Math.random() * 2,
      });
    }
  }

  blood(x: number, y: number, n = 7): void { this.sparksAt(x, y, '#a41f14', n, 130); }

  damageNum(x: number, y: number, amt: number): void {
    this.floats.push({
      x: x + (Math.random() * 20 - 10), y: y - 12,
      vy: -55, life: 0.8, ttl: 0.8, text: String(amt), color: '#ffd75e',
    });
  }

  corpse(x: number, y: number, kind: 'player' | 'zombie'): void {
    this.corpses.push({ x, y, kind, life: 8, ttl: 8, rot: Math.random() * Math.PI * 2 });
  }

  /** Bomber detonation: the biggest light pulse in the game, a two-tone spark
   *  burst and a ring of smoke. Sized against BLAST_RADIUS by eye — the fx is
   *  spectacle, the damage circle is the server's. */
  boom(x: number, y: number): void {
    this.glows.push({ x, y, life: 0.4, ttl: 0.4, radius: 480, color: '#ffb054' });
    this.sparksAt(x, y, '#ffc964', 16, 420);
    this.sparksAt(x, y, '#e8483f', 8, 260);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.4;
      const v = 120 + Math.random() * 80;
      this.smoke.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        size: 9 + Math.random() * 6, life: 1.1 + Math.random() * 0.4, ttl: 1.5,
      });
    }
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 40);
    const tick = <T extends { life: number }>(arr: T[], fn?: (p: T) => void) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        p.life -= dt;
        if (p.life <= 0) { arr.splice(i, 1); continue; }
        fn?.(p);
      }
    };
    tick(this.sparks, (p) => {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.86; p.vy *= 0.86;
    });
    tick(this.tracers);
    tick(this.floats, (p) => { p.y += p.vy * dt; p.vy *= 0.92; });
    tick(this.flashes);
    tick(this.corpses);
    tick(this.glows);
    tick(this.shells, (p) => {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.82; p.vy *= 0.82;
      p.rot += p.vr * dt; p.vr *= 0.9;
    });
    tick(this.smoke, (p) => {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.9; p.vy *= 0.9;
      p.size += 26 * dt;
    });
  }

  shakeOffset(): { x: number; y: number } {
    if (this.shake <= 0) return { x: 0, y: 0 };
    return {
      x: (Math.random() * 2 - 1) * this.shake,
      y: (Math.random() * 2 - 1) * this.shake,
    };
  }
}
