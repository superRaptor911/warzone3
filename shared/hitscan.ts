// Ray-vs-circle hitscan, shared so the server's authoritative shot resolution
// and the client's local gun-feel mirror stop pellets on the same things.
// Walls come from the grid DDA raycast; bodies are circles at their collision
// radius (shared/constants.ts) — a tracer that ignores them visibly punches
// through enemies.
import type { Grid } from './maps.ts';

// Anything a pellet can stop on: the server's Target and the client's
// interpolated snapshot entities both widen to this.
export interface HitCircle { x: number; y: number; radius: number }

// Distance along the ray to the first intersection with the circle, or null if
// it misses / is behind the origin.
export function rayCircle(
  ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number,
): number | null {
  const mx = cx - ox, my = cy - oy;
  const t = mx * dx + my * dy;
  if (t < 0) return null;
  const closestSq = mx * mx + my * my - t * t;
  if (closestSq > r * r) return null;
  const back = Math.sqrt(r * r - closestSq);
  const hit = t - back;
  return hit >= 0 ? hit : 0;
}

// One pellet: travels to the nearer of the first wall and the first target
// circle. (dx, dy) must be unit length.
export function castPellet<T extends HitCircle>(
  grid: Grid, ox: number, oy: number, dx: number, dy: number, range: number, targets: readonly T[],
): { dist: number; hit: T | null } {
  let dist = grid.raycast(ox, oy, dx, dy, range);
  let hit: T | null = null;
  for (const tgt of targets) {
    const d = rayCircle(ox, oy, dx, dy, tgt.x, tgt.y, tgt.radius);
    if (d !== null && d < dist) { dist = d; hit = tgt; }
  }
  return { dist, hit };
}
