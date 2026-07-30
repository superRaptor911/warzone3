import { INTERP_DELAY_MS, STAMINA_MAX } from '../../shared/constants.ts';
import { moveSpeed, stepMove, tickSprint } from '../../shared/physics.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import type { Grid } from '../../shared/maps.ts';
import type { GlobSnap, MoveKeys, PlayerSnap, Snapshot, Vec2, ZombieSnap } from '../../shared/types.ts';

// Input as recorded for prediction (always fully populated, unlike the wire type).
export interface PredInput { seq: number; dt: number; keys: MoveKeys; sprint: boolean }

interface PredState { x: number; y: number; stamina: number; sprinting: boolean }

// One deterministic prediction step, mirroring server applyInput movement.
// `speed` is the held weapon's moveSpeed — taken from the snapshot's `w`, so
// a just-sent swap predicts the old gun's speed for one RTT (sub-2px, decays
// through the normal correction).
function simStep(grid: Grid, ent: PredState, input: PredInput, speed: number): void {
  const k = input.keys;
  const wantsMove = !!(k.w || k.a || k.s || k.d);
  const sprinting = tickSprint(ent, input.sprint && wantsMove, input.dt);
  stepMove(grid, ent, k, sprinting, input.dt, speed);
}

// Holds snapshot buffer, server-clock sync, entity interpolation, and
// client-side prediction (with smoothed reconciliation) for the local player.
export class GameState {
  grid: Grid;
  myId: number;
  snaps: Snapshot[] = [];
  clockOffset: number | null = null; // serverNow - perfNow
  pending: PredInput[] = [];         // unacked inputs
  pred: PredState | null = null;     // predicted local pos
  corr = { x: 0, y: 0 };             // visual error offset, decays to 0
  latest: Snapshot | null = null;
  self: PlayerSnap | null = null;    // my entry in latest snapshot

  constructor(grid: Grid, myId: number) {
    this.grid = grid;
    this.myId = myId;
  }

  addSnapshot(s: Snapshot, recvPerfNow: number): void {
    const off = s.now - recvPerfNow;
    this.clockOffset = this.clockOffset === null ? off : this.clockOffset * 0.9 + off * 0.1;
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    this.latest = s;
    this.self = s.players.find(p => p.id === this.myId) || null;

    if (this.self) {
      // reconcile: rewind to server pos, replay unacked inputs
      this.pending = this.pending.filter(i => i.seq > (s.ack ?? 0));
      const prevRender = this.pred
        ? { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y } : null;
      const p: PredState = {
        x: this.self.x, y: this.self.y,
        stamina: s.self ? s.self.stam : STAMINA_MAX,
        sprinting: !!(s.self && s.self.spg),
      };
      if (this.self.alive) {
        const spd = moveSpeed(WEAPONS[this.self.w]);
        for (const i of this.pending) simStep(this.grid, p, i, spd);
      }
      this.pred = p;
      if (prevRender && this.self.alive) {
        this.corr.x = Math.max(-60, Math.min(60, prevRender.x - p.x));
        this.corr.y = Math.max(-60, Math.min(60, prevRender.y - p.y));
        if (Math.hypot(this.corr.x, this.corr.y) > 55) this.corr = { x: 0, y: 0 }; // hard snap
      } else this.corr = { x: 0, y: 0 };
    }
  }

  // Called every frame with the input actually sent to the server.
  predict(input: PredInput): void {
    if (!this.pred || !this.self || !this.self.alive) return;
    this.pending.push(input);
    if (this.pending.length > 120) this.pending.shift();
    simStep(this.grid, this.pred, input, moveSpeed(WEAPONS[this.self.w]));
  }

  // Smoothed render position for local player.
  myPos(dt: number): Vec2 | null {
    if (!this.pred) return null;
    const decay = Math.exp(-dt * 11);
    this.corr.x *= decay; this.corr.y *= decay;
    return { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y };
  }

  renderTime(): number {
    if (this.clockOffset === null) return 0;
    return performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  // Interpolated remote entities at render time.
  interpolated(): { players: PlayerSnap[]; zombies: ZombieSnap[]; globs: GlobSnap[] } {
    const rt = this.renderTime();
    const s = this.snaps;
    if (!s.length) return { players: [], zombies: [], globs: [] };
    let a = s[0], b = s[s.length - 1];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].now <= rt) { a = s[i]; b = s[i + 1] || s[i]; break; }
    }
    const t = b.now > a.now ? Math.min(1.3, (rt - a.now) / (b.now - a.now)) : 1;
    // `|| []` on the acid arrays: an older server's snapshot simply lacks them,
    // and the world should stay playable rather than die in the interpolator —
    // the same tolerance Grid.deserialize extends to a missing `mat`.
    return {
      players: lerpEntities(a.players, b.players, t),
      zombies: lerpEntities(
        a.mode === 'zombie' ? a.zombies : [],
        b.mode === 'zombie' ? b.zombies : [], t),
      globs: lerpPoints(
        a.mode === 'zombie' ? a.globs || [] : [],
        b.mode === 'zombie' ? b.globs || [] : [], t),
    };
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Positions only — for things with no aim to wrap (acid globs).
function lerpPoints<T extends { id: number; x: number; y: number }>(
  listA: T[], listB: T[], t: number,
): T[] {
  const byId = new Map<number, T>();
  for (const e of listA) byId.set(e.id, e);
  const out: T[] = [];
  for (const b of listB) {
    const a = byId.get(b.id);
    out.push(a ? { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : { ...b });
  }
  return out;
}

function lerpEntities<T extends { id: number; x: number; y: number; aim: number; alive?: 0 | 1 }>(
  listA: T[], listB: T[], t: number,
): T[] {
  const byId = new Map<number, T>();
  for (const e of listA) byId.set(e.id, e);
  const out: T[] = [];
  for (const b of listB) {
    const a = byId.get(b.id);
    if (a && a.alive === b.alive) {
      out.push({
        ...b,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        aim: lerpAngle(a.aim, b.aim, t),
      });
    } else out.push({ ...b });
  }
  return out;
}
