// Client-side reload mirror.
//
// The server owns ammo, but `self.reloadT` only moves once a snapshot returns,
// so at 250ms RTT the bar sits dead for a third of a second after pressing R
// and the press reads as dropped. This runs the timer locally and then hands
// over to the server, which remains the authority on when the reload actually
// finishes.
//
// Pure — no DOM, no Pixi — like view.ts and stick.ts, so the state machine
// (four states plus a refusal timeout) is unit-tested under Node.
import { WEAPONS, type WeaponId } from '../../shared/weapons.ts';
import type { Ammo } from '../../shared/types.ts';

export interface ReloadMirror {
  active: boolean;     // a predicted reload is in flight
  t: number;           // local remaining time, seconds
  total: number;       // local duration, for the bar's denominator
  confirmed: boolean;  // the server has been seen reloading
  wait: number;        // grace period left for that confirmation
}

// How long to wait for the server to acknowledge before assuming it refused.
// Comfortably beyond any playable RTT plus a snapshot interval.
export const CONFIRM_GRACE = 1;

export function newReloadMirror(): ReloadMirror {
  return { active: false, t: 0, total: 0, confirmed: false, wait: 0 };
}

// Begin a predicted reload, but only when the server would accept one — the
// same magazine/reserve test Room.startReload applies. Returns whether it took.
export function startReload(r: ReloadMirror, wid: WeaponId, ammo: Ammo | undefined): boolean {
  if (r.active || !ammo) return false;
  const w = WEAPONS[wid];
  if (ammo.mag >= w.mag || ammo.reserve <= 0) return false;
  r.active = true;
  r.t = w.reloadMs / 1000;
  r.total = r.t;
  r.confirmed = false;
  r.wait = CONFIRM_GRACE;
  return true;
}

export function cancelReload(r: ReloadMirror): void {
  r.active = false;
  r.confirmed = false;
}

// Advance one frame against the server's reported reloadT, and return the time
// the HUD should display. Note the local clock may reach zero while `active` is
// still true: we started roughly RTT/2 before the server did, so the mirror
// stays up until the server confirms completion. Callers gate firing on
// max(shown, serverReloadT) so that early finish can never license a shot.
export function tickReload(r: ReloadMirror, serverReloadT: number, dt: number): number {
  if (r.active) {
    r.t = Math.max(0, r.t - dt);
    if (!r.confirmed) {
      if (serverReloadT > 0) r.confirmed = true;
      else if ((r.wait -= dt) <= 0) r.active = false; // never acknowledged — refused
    } else if (serverReloadT <= 0) {
      r.active = false; // the server says it finished
    }
  }
  return r.active ? r.t : serverReloadT;
}
