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

// One pellet. `pierce` is how many extra bodies the round passes through
// (weapons.ts): hits are the first pierce+1 bodies along the ray in distance
// order, each with its own hit distance so the caller can apply falloff and
// per-body decay. Walls always stop the round — bodies past the wall never
// hit, whatever pierce remains. `dist` is where the pellet ends (the wall, its
// range, or the near edge of the body that exhausted the pierce), which is
// what the tracer draws. Pure geometry on purpose: damage decay stays with the
// caller, because the client mirror has no authoritative HP and a pellet whose
// reach depended on it could not be predicted. (dx, dy) must be unit length.
export function castPellet<T extends HitCircle>(
  grid: Grid, ox: number, oy: number, dx: number, dy: number, range: number,
  targets: readonly T[], pierce = 0,
): { dist: number; hits: { tgt: T; dist: number }[] } {
  const wallDist = grid.raycast(ox, oy, dx, dy, range);
  const along: { tgt: T; dist: number }[] = [];
  for (const tgt of targets) {
    const d = rayCircle(ox, oy, dx, dy, tgt.x, tgt.y, tgt.radius);
    if (d !== null && d < wallDist) along.push({ tgt, dist: d });
  }
  along.sort((a, b) => a.dist - b.dist);
  const hits = along.slice(0, pierce + 1);
  const stopped = along.length > pierce; // more bodies than the round can pass
  return { dist: stopped ? hits[hits.length - 1].dist : wallDist, hits };
}
