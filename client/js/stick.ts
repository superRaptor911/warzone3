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
