// Mobile aim assist: a bounded angular pull toward whichever enemy is nearest
// the crosshair.
//
// Pure — no DOM, no Pixi — like view.ts and stick.ts, so test/matchflow.ts can
// exercise it under Node against a real Grid. Touch-only and entirely
// client-side: it adjusts the angle the client was going to send anyway, so
// server/ and shared/ stay untouched and mobile keeps sharing rooms with
// desktop.
//
// WHY it is needed, and why the strength is proportional to distance rather
// than flat. A target's angular size falls off as 1/distance, while the thumb's
// noise floor does not: after the aim ease (`tickAimSmooth`) a finger still
// leaves ~2° of residual wobble. Measured against the real radii —
//
//     distance   player   walker   brute
//        150px    12.9°    12.2°   16.7°
//        500px     3.9°     3.7°    5.0°
//        800px     2.4°     2.3°    3.2°   <- rifle range
//       1800px     1.1°     1.0°    1.4°   <- sniper range
//
// — a target past ~500px is *narrower than the wobble*, so no amount of thumb
// steadiness holds a crosshair on it. Up close the opposite is true: a 12.9°
// target needs no help at all. The pull is therefore scaled by how badly the
// target needs it (`ASSIST_NEED` over the target's angular width), which lands
// near 0 at knife range and near 1 at sniper range. One rule, no per-weapon
// tables, and it stays correct if the radii in shared/constants.ts ever change.

import type { HitCircle } from '../../shared/hitscan.ts';
import type { Grid } from '../../shared/maps.ts';

const DEG = Math.PI / 180;

/** Half-angle of the cone searched for targets. Outside it there is no pull. */
export const ASSIST_CONE = 18 * DEG;

/**
 * The angular error the pull is sized to erase: the residual wobble left by
 * `tickAimSmooth` (~2°). A target wider than this is hittable by hand and gets
 * proportionally less help; a narrower one gets the full pull, because at that
 * size the wobble alone is enough to miss.
 */
export const ASSIST_NEED = 2 * DEG;

/**
 * Target stickiness. A candidate within `ASSIST_STICK_TOL` of last frame's
 * choice has its score multiplied by `ASSIST_STICK_BONUS`, so it keeps the pull
 * unless something is clearly better. Without this an Outbreak swarm puts two
 * zombies at similar angles either side of the crosshair and the pull changes
 * sign every frame — the same chattering the fire gate needed hysteresis for.
 */
export const ASSIST_STICK_TOL = 6 * DEG;
export const ASSIST_STICK_BONUS = 0.6;

/** Mutable state for tickAimAssist; one per client. */
export interface Assist {
  a: number;    // world angle of the target the pull last chose
  has: boolean; // ...and whether there was one
}

export function newAssist(): Assist {
  return { a: 0, has: false };
}

/** Forget the current target, so nothing is sticky when aiming resumes. */
export function releaseAssist(st: Assist): void {
  st.has = false;
}

/** Wrap to (-PI, PI]. */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/**
 * The strongest bend this can ever apply, in radians.
 *
 * The pull is `err * (1 - |err| / ASSIST_CONE)`, which is zero when the aim is
 * already on the target, zero at the edge of the cone, and peaks halfway
 * between at exactly `ASSIST_CONE / 4`. That shape is the whole design: a
 * nearly-complete correction for the small errors wobble produces, and a mere
 * nudge for the large errors that mean the player is pointing somewhere else.
 * Because the bound is analytic there is no clamp to tune, and the assist
 * provably cannot become a lock — a deliberate thumb always wins.
 */
export const ASSIST_MAX_PULL = ASSIST_CONE / 4;

/**
 * Adjust `aim` toward the best target and return the new angle. Call only while
 * the stick is actually engaged: with the thumb off the pads there is no aiming
 * to assist, and a pull there would drift the crosshair while merely running.
 *
 * `range` should be the equipped weapon's range, so the pull never helps with a
 * shot that could not land — a shotgun is assisted to 420px and a sniper to
 * 1800px with no separate tuning.
 */
export function tickAimAssist(
  st: Assist,
  aim: number,
  px: number, py: number,
  targets: readonly HitCircle[],
  range: number,
  grid: Grid,
): number {
  let bestScore = Infinity, bestErr = 0, bestAngle = 0, bestHalf = 0, found = false;
  for (const t of targets) {
    const dx = t.x - px, dy = t.y - py;
    const d = Math.hypot(dx, dy);
    if (d > range || d < 1e-3) continue;
    const angle = Math.atan2(dy, dx);
    const err = wrapPi(angle - aim);
    const ae = Math.abs(err);
    if (ae > ASSIST_CONE) continue;
    let score = ae;
    if (st.has && Math.abs(wrapPi(angle - st.a)) < ASSIST_STICK_TOL) score *= ASSIST_STICK_BONUS;
    if (score >= bestScore) continue;
    // LOS last: it is the only expensive test here, so it runs only for a
    // candidate that would actually win. Never assist through a wall — that
    // would hand mobile information the renderer deliberately withholds.
    if (!grid.los(px, py, t.x, t.y)) continue;
    bestScore = score; bestErr = err; bestAngle = angle;
    bestHalf = Math.atan2(t.radius, d);
    found = true;
  }
  if (!found) {
    st.has = false;
    return aim;
  }
  st.a = bestAngle;
  st.has = true;
  // how much this target needs help: 1 once it is narrower than the wobble,
  // falling toward 0 as it fills the screen
  const need = Math.min(1, ASSIST_NEED / (bestHalf * 2));
  const falloff = 1 - Math.abs(bestErr) / ASSIST_CONE;
  return wrapPi(aim + bestErr * falloff * need);
}
