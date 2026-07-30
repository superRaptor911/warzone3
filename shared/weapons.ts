// Weapon definitions shared by server (authoritative fire logic) and client (HUD/feel).
// spread values are radians. Damage falls off linearly from falloffStart to range,
// down to falloffMult * damage.
//
// `reserve` is deliberately expressed in whole magazines: pistol 10, smg 8,
// rifle 8, shotgun 12, sniper 10, lmg 3. Shotgun and sniper carry more spares
// than the automatics on purpose — a 6-round tube and a 5-round bolt would
// otherwise be counting reloads instead of shots — while the lmg carries the
// fewest because a 100-round box is nearly a reserve by itself (its total pool
// is still the largest in the game). Scaling the whole table by one factor is
// the only way to change how long a life lasts without re-litigating that
// ranking, so keep the mag counts above in step with any future change.
//
// `pierce` is how many EXTRA bodies a round passes through (0 = stops in the
// first, walls always stop it); `pierceMult` scales damage per body already
// passed, dmg × mult^n on top of range falloff. The two are deliberately
// per-weapon because they want different things: the sniper's 1.0 keeps the
// collateral a full one-shot (0.85 would leave the second man on 6hp and read
// as a bug), while the rifle's 0.6 makes its pierce a bonus instead of double
// DPS into a lined-up horde. The shotgun's 1 @ 0.6 (the rifle's decay) is its
// horde answer: pellets punch through the front rank into the second, so a
// clump eats up to 166 per trigger pull while single targets are untouched.
//
// `moveMult` scales walk/sprint speed while the weapon is HELD (switching
// guns changes it). Only three deviate from 1.00, on purpose: the smg (the
// run-and-gun identity) and the two heavy guns, sniper and lmg (the weight
// tax — the lmg deliberately TIES the sniper rather than going lower, because
// 0.88 would leave 4 px/s of escape speed against a frenzied brute and its
// heaviness lives in moveSpreadMult and the reload instead). The band is bounded
// by Outbreak's frenzy envelope, not taste — the fastest gun-out walk must
// stay under a frenzied walker's 195 px/s or anti-kiting dies for every wave
// whose stragglers aren't runners, and the slowest must stay above a frenzied
// brute's 150 px/s or brutes stop being escapable at a walk. matchflow holds
// both bounds against the live frenzySpeed table. The pistol stays at 1.00
// deliberately (everyone owns one — a fast pistol is a free kite loadout) and
// the shotgun is exempt from "heavy = slow" (a 420px-range gun has to close).
export type WeaponId = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'lmg';

export interface Weapon {
  id: WeaponId;
  name: string;
  auto: boolean;
  damage: number;
  rpm: number;
  mag: number;
  reserve: number;
  reloadMs: number;
  range: number;
  falloffStart: number;
  falloffMult: number;
  baseSpread: number;
  maxSpread: number;
  bloom: number;
  recover: number;
  moveSpreadMult: number;
  moveMult: number;
  pellets: number;
  kick: number;
  pierce: number;
  pierceMult: number;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', auto: false,
    damage: 34, rpm: 340, mag: 12, reserve: 120, reloadMs: 1100,
    range: 800, falloffStart: 420, falloffMult: 0.6,
    baseSpread: 0.018, maxSpread: 0.16, bloom: 0.028, recover: 0.35,
    moveSpreadMult: 2.0, moveMult: 1, pellets: 1, kick: 3, pierce: 0, pierceMult: 1,
  },
  smg: {
    id: 'smg', name: 'Viper SMG', auto: true,
    damage: 16, rpm: 880, mag: 32, reserve: 256, reloadMs: 1150,
    range: 700, falloffStart: 300, falloffMult: 0.5,
    baseSpread: 0.035, maxSpread: 0.22, bloom: 0.016, recover: 0.5,
    moveSpreadMult: 1.4, moveMult: 1.05, pellets: 1, kick: 2, pierce: 0, pierceMult: 1,
  },
  rifle: {
    id: 'rifle', name: 'AR-7 Rifle', auto: true,
    damage: 26, rpm: 600, mag: 30, reserve: 240, reloadMs: 1800,
    range: 1100, falloffStart: 600, falloffMult: 0.65,
    baseSpread: 0.02, maxSpread: 0.15, bloom: 0.019, recover: 0.45,
    moveSpreadMult: 1.9, moveMult: 1, pellets: 1, kick: 3.5, pierce: 1, pierceMult: 0.6,
  },
  shotgun: {
    id: 'shotgun', name: 'M870 Shotgun', auto: false,
    damage: 13, rpm: 75, mag: 6, reserve: 72, reloadMs: 2400,
    range: 420, falloffStart: 150, falloffMult: 0.35,
    baseSpread: 0.09, maxSpread: 0.16, bloom: 0.02, recover: 0.6,
    moveSpreadMult: 1.2, moveMult: 1, pellets: 8, kick: 8, pierce: 1, pierceMult: 0.6,
  },
  sniper: {
    id: 'sniper', name: 'LR-50 Marksman', auto: false,
    damage: 110, rpm: 42, mag: 5, reserve: 50, reloadMs: 2600,
    range: 1800, falloffStart: 1800, falloffMult: 1.0,
    baseSpread: 0.002, maxSpread: 0.3, bloom: 0.25, recover: 0.4,
    moveSpreadMult: 14.0, moveMult: 0.9, pellets: 1, kick: 10, pierce: 3, pierceMult: 1,
  },
  // The planted anchor — the SMG's opposite pole. Its capacity buys reload
  // AUTONOMY, not DPS: burst stays under the rifle's (238 vs 260) so the rifle
  // keeps its crown, but a 100-round box is 9.2s of continuous fire — one
  // chosen reload per push instead of five forced ones. The signatures: lowest
  // maxSpread of any auto (round 90 as aimed as round 10, planted) and the
  // worst move-bloom of any auto (mobile fire is spray). Sustained DPS 169 is
  // the one number that must stay above the rifle's 162, and it needs all
  // three of mag 100, reload 3800 and burst-below-rifle to hold.
  lmg: {
    id: 'lmg', name: 'M249 LMG', auto: true,
    damage: 22, rpm: 650, mag: 100, reserve: 300, reloadMs: 3800,
    range: 950, falloffStart: 500, falloffMult: 0.6,
    baseSpread: 0.028, maxSpread: 0.10, bloom: 0.006, recover: 0.45,
    moveSpreadMult: 4.0, moveMult: 0.9, pellets: 1, kick: 5, pierce: 1, pierceMult: 0.6,
  },
};

export const PRIMARIES = ['smg', 'rifle', 'shotgun', 'sniper', 'lmg'] as const;
export type PrimaryId = (typeof PRIMARIES)[number];

export function isPrimary(w: unknown): w is PrimaryId {
  return typeof w === 'string' && (PRIMARIES as readonly string[]).includes(w);
}

export function fireIntervalMs(w: Weapon): number { return 60000 / w.rpm; }

export function damageAt(w: Weapon, dist: number): number {
  if (dist <= w.falloffStart) return w.damage;
  const t = Math.min(1, (dist - w.falloffStart) / Math.max(1, w.range - w.falloffStart));
  return w.damage * (1 - t * (1 - w.falloffMult));
}
