// Thumbstick math and the semi-auto fire cadence.
//
// Pure functions and plain state objects — no DOM, no Pixi — so test/matchflow.ts
// can exercise the parts that are actually easy to get wrong (sector
// boundaries, the deadzone, edge synthesis) under Node.

import type { MoveKeys } from '../../shared/types.ts';

/** Screen px from a stick's origin to full deflection. */
export const STICK_R = 52;

/** Fraction of STICK_R below which a stick reads as centred. */
export const DEAD_ZONE = 0.25;

/**
 * Fire thresholds for the aim stick, well above DEAD_ZONE on purpose: the two
 * jobs the right thumb does are separate. Inside FIRE_ON the stick only turns
 * you — line a shot up, track a runner, check a corner — and firing starts at
 * the outer ring, which the thumb has to reach for deliberately. A single
 * threshold made every nudge a shot, so aiming without firing was impossible.
 *
 * FIRE_OFF is lower than FIRE_ON (hysteresis, ~15% of travel). Without the gap
 * a thumb resting near the boundary flickers the flag every frame, and since
 * semi-autos are pulsed at their fire interval that reads as the gun going off
 * at random. Latching means "committed to fire" survives small wobble, while a
 * genuine pull back to aiming still releases well before the deadzone.
 */
export const FIRE_ON = 0.7;
export const FIRE_OFF = 0.55;

/** Mutable state for tickFireGate; one per client. */
export interface FireGate { on: boolean }

export function newFireGate(): FireGate {
  return { on: false };
}

/**
 * Latching threshold: does this aim-stick deflection mean "fire"? Deflection
 * alone decides, so this is safe to call from a pointer event rather than a
 * frame (no dt, no wall clock). A lifted thumb reports 0 and always releases.
 */
export function tickFireGate(st: FireGate, deflect: number): boolean {
  st.on = deflect >= (st.on ? FIRE_OFF : FIRE_ON);
  return st.on;
}

/**
 * Aim easing time constants, at DEAD_ZONE and at the rim, linear between.
 *
 * A floating stick's angular sensitivity is 1/radius, and the radius is tiny
 * near the origin: 1px of thumb is 4.41° at the deadzone edge (13px) but only
 * 1.10° at the rim (52px). A finger's contact centroid wanders 1–3px on its own
 * as the pad deforms, so small deflections turned ~13° of pure noise into an
 * instant snap of the body and a 15px jump of the crosshair — the aim looked
 * like it was flinching.
 *
 * Easing suppresses exactly that and little else, because noise is a *small*
 * error that keeps reversing sign while a deliberate sweep is a *large* error
 * that does not: the same filter that flattens a 13° wobble to ~2° still crosses
 * 90° in 233ms. Scaling tau by deflection is what keeps the cure local — at the
 * rim 0.01s is ~1:1, so a committed flick is as sharp as it ever was, and it is
 * only the low-radius region that trades latency for calm.
 *
 * NOTE this hides noise, it does not add resolution: at 13px there are still
 * only ~20 distinguishable 1px steps around the whole circle. Fine aim near the
 * centre is calm now, not precise. Making it precise means giving the stick a
 * trailing origin so the radius can't be small, which is a different design.
 */
export const AIM_TAU_NEAR = 0.10;
export const AIM_TAU_FAR = 0.01;

/** Mutable state for tickAimSmooth; one per client. */
export interface AimSmooth {
  a: number;        // the eased angle — what the game reads
  acquired: boolean; // has this touch produced a live angle yet?
}

export function newAimSmooth(): AimSmooth {
  return { a: 0, acquired: false };
}

/**
 * Drop the "acquired" latch, so the next tick snaps instead of easing. Called
 * when a new touch starts: re-planting the thumb somewhere new is intent, and
 * easing 150° over 233ms at the one moment the player is reacting to something
 * reads as a broken stick. Mid-drag jitter gets no such exemption, which is the
 * whole distinction — one bit of state, no magic angle threshold.
 */
export function releaseAim(st: AimSmooth): void {
  st.acquired = false;
}

/** Wrap to (-PI, PI]. */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/**
 * Ease `st.a` toward `target`, softly near the stick's centre and hard at its
 * rim. Per frame, not per pointer event: `pointermove` only fires while the
 * finger actually moves, so easing on event deltas would stall the aim short of
 * its target the moment the thumb held still.
 *
 * Eases the *error*, wrapped to (-PI, PI], rather than the angles themselves —
 * a plain lerp from 179° to -179° takes the 358° route and spins the player all
 * the way round the wrong way.
 */
export function tickAimSmooth(
  st: AimSmooth, target: number, deflect: number, dt: number,
): number {
  // Acquisition completes on the first *live* angle, not on the first tick: a
  // touchdown reports zero deflection, where the caller is still holding the
  // previous touch's angle. Latching there would spend the snap on a stale
  // target and then ease into the direction the thumb actually meant.
  if (!st.acquired) {
    st.a = target;
    if (deflect >= DEAD_ZONE) st.acquired = true;
    return st.a;
  }
  // below the deadzone the caller is holding its last target, so clamp rather
  // than extrapolate the curve to a radius that isn't steering anything
  const s = Math.min(1, Math.max(DEAD_ZONE, deflect));
  const tau = AIM_TAU_NEAR + (AIM_TAU_FAR - AIM_TAU_NEAR) * ((s - DEAD_ZONE) / (1 - DEAD_ZONE));
  st.a = wrapPi(st.a + wrapPi(target - st.a) * (1 - Math.exp(-dt / tau)));
  return st.a;
}

/** Deflection 0..1, clamped. */
export function deflection(dx: number, dy: number, radius: number = STICK_R): number {
  return Math.min(1, Math.hypot(dx, dy) / radius);
}

/**
 * Quantise a stick offset to the same 8-way digital input a keyboard produces.
 * Eight equal 45-degree sectors: exact parity with WASD, which is what makes a
 * dpad the right control for this game (shared/physics.ts normalises diagonals,
 * so an analog magnitude would have nothing to drive).
 */
export function stickKeys(
  dx: number, dy: number, deadzone: number = DEAD_ZONE, radius: number = STICK_R,
): MoveKeys {
  if (deflection(dx, dy, radius) < deadzone) return {};
  // screen +y is down, i.e. 's'
  const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  const k: MoveKeys = {};
  if (sector === 7 || sector === 0 || sector === 1) k.d = 1;
  if (sector === 1 || sector === 2 || sector === 3) k.s = 1;
  if (sector === 3 || sector === 4 || sector === 5) k.a = 1;
  if (sector === 5 || sector === 6 || sector === 7) k.w = 1;
  return k;
}

/** Mutable state for tickLead; one per client. */
export interface Lead { x: number; y: number }

export function newLead(): Lead {
  return { x: 0, y: 0 };
}

/**
 * Ease a two-component offset toward a target. The aim stick floats, so it
 * spawns at zero deflection and grows continuously as the thumb drags — but
 * release drops deflection to zero in a single frame, which would teleport
 * anything derived from it. This spreads that step over `tau`.
 *
 * The `1 - exp(-dt/tau)` form is deliberate over a fixed per-frame factor: the
 * curve is the same wall-clock shape at 20fps and at 144fps, which matters
 * because the only callers are phones. Asymptotic, so it never overshoots and
 * never quite reaches the target — sub-pixel residue is invisible against a
 * camera that is already at fractional world coordinates every frame.
 */
export function tickLead(st: Lead, tx: number, ty: number, tau: number, dt: number): Lead {
  const k = 1 - Math.exp(-dt / tau);
  st.x += (tx - st.x) * k;
  st.y += (ty - st.y) * k;
  return st;
}

/** Mutable state for tickFireCadence; one per client. */
export interface FireCadence {
  t: number;    // seconds until the next shot may be released
  on: boolean;  // last frame emitted a rising edge
}

export function newFireCadence(): FireCadence {
  return { t: 0, on: false };
}

/**
 * Turns "the aim stick is held" into a fire flag the server will actually act
 * on. The server edge-detects semi-autos via `firePrev`, so a held flag fires
 * exactly one shot; this alternates true/false at the weapon's own fire
 * interval to synthesise the edges — the same trick server/bot.ts uses for
 * bots. Auto weapons pass straight through. Rate is still bounded by rpm on
 * both ends, so this is parity with a desktop player clicking, not a buff.
 */
export function tickFireCadence(
  st: FireCadence, held: boolean, auto: boolean, intervalSec: number, dt: number,
): boolean {
  if (!held) { st.t = 0; st.on = false; return false; }
  if (auto) { st.on = true; return true; }
  if (st.on) { st.on = false; return false; } // the mandatory low frame
  st.t -= dt;
  if (st.t <= 0) { st.t = intervalSec; st.on = true; return true; }
  return false;
}
