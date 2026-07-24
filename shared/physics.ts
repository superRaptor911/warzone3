import {
  TILE, PLAYER_RADIUS, PLAYER_SPEED, SPRINT_MULT,
  STAMINA_MAX, STAMINA_DRAIN, STAMINA_REGEN, STAMINA_MIN_TO_SPRINT,
} from './constants.ts';
import { T_FLOOR, type Grid } from './maps.ts';
import type { MoveKeys, Vec2 } from './types.ts';

export interface SprintState { stamina?: number; sprinting?: boolean }

// Advance the sprint/stamina state of an entity. Returns whether it is
// sprinting this step. Deterministic — runs identically in server sim and
// client prediction, so it must be fed the raw "wants to sprint" input.
export function tickSprint(ent: SprintState, wantSprint: boolean, dt: number): boolean {
  if (ent.stamina == null) { ent.stamina = STAMINA_MAX; ent.sprinting = false; }
  const threshold = ent.sprinting ? 1 : STAMINA_MIN_TO_SPRINT;
  ent.sprinting = !!wantSprint && ent.stamina >= threshold;
  if (ent.sprinting) ent.stamina = Math.max(0, ent.stamina - STAMINA_DRAIN * dt);
  else ent.stamina = Math.min(STAMINA_MAX, ent.stamina + STAMINA_REGEN * dt);
  return ent.sprinting;
}

// Push a circle at (x,y) out of any solid tiles it overlaps, along one axis.
// Deterministic and cheap; identical on client (prediction) and server.
export function resolveCircleAxis(grid: Grid, x: number, y: number, r: number, axis: 'x' | 'y'): number {
  const minTx = Math.floor((x - r) / TILE), maxTx = Math.floor((x + r) / TILE);
  const minTy = Math.floor((y - r) / TILE), maxTy = Math.floor((y + r) / TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (grid.get(tx, ty) === T_FLOOR) continue;
      const rx0 = tx * TILE, ry0 = ty * TILE, rx1 = rx0 + TILE, ry1 = ry0 + TILE;
      // closest point on rect to circle center
      const cx = Math.max(rx0, Math.min(x, rx1));
      const cy = Math.max(ry0, Math.min(y, ry1));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy >= r * r) continue;
      if (axis === 'x') {
        x = x < (rx0 + rx1) / 2 ? rx0 - r : rx1 + r;
      } else {
        y = y < (ry0 + ry1) / 2 ? ry0 - r : ry1 + r;
      }
    }
  }
  return axis === 'x' ? x : y;
}

// Move an entity with WASD-style input. Mutates ent and returns whether it moved.
export function stepMove(
  grid: Grid, ent: Vec2, keys: MoveKeys, sprint: boolean, dt: number,
  speed: number = PLAYER_SPEED, radius: number = PLAYER_RADIUS,
): boolean {
  let dx = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  let dy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
  const moving = dx !== 0 || dy !== 0;
  if (moving) {
    const len = Math.hypot(dx, dy);
    const v = speed * (sprint ? SPRINT_MULT : 1);
    dx = (dx / len) * v * dt;
    dy = (dy / len) * v * dt;
    ent.x += dx;
    ent.x = resolveCircleAxis(grid, ent.x, ent.y, radius, 'x');
    ent.y += dy;
    ent.y = resolveCircleAxis(grid, ent.x, ent.y, radius, 'y');
    // clamp inside world
    ent.x = Math.max(radius, Math.min(grid.pxW() - radius, ent.x));
    ent.y = Math.max(radius, Math.min(grid.pxH() - radius, ent.y));
  }
  return moving;
}

// Straight-line movement toward a point (used by zombies/bots steering).
export function stepToward(grid: Grid, ent: Vec2, tx: number, ty: number, speed: number, dt: number, radius: number): void {
  const dx = tx - ent.x, dy = ty - ent.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return;
  const step = Math.min(d, speed * dt);
  ent.x += (dx / d) * step;
  ent.x = resolveCircleAxis(grid, ent.x, ent.y, radius, 'x');
  ent.y += (dy / d) * step;
  ent.y = resolveCircleAxis(grid, ent.x, ent.y, radius, 'y');
  ent.x = Math.max(radius, Math.min(grid.pxW() - radius, ent.x));
  ent.y = Math.max(radius, Math.min(grid.pxH() - radius, ent.y));
}

export function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
