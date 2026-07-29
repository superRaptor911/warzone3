// Weapon definitions shared by server (authoritative fire logic) and client (HUD/feel).
// spread values are radians. Damage falls off linearly from falloffStart to range,
// down to falloffMult * damage.
//
// `reserve` is deliberately expressed in whole magazines: pistol 10, smg 8,
// rifle 8, shotgun 12, sniper 10. Shotgun and sniper carry more spares than the
// automatics on purpose — a 6-round tube and a 5-round bolt would otherwise be
// counting reloads instead of shots. Scaling the whole table by one factor is
// the only way to change how long a life lasts without re-litigating that
// ranking, so keep the mag counts above in step with any future change.
//
// `pierce` is how many EXTRA bodies a round passes through (0 = stops in the
// first, walls always stop it); `pierceMult` scales damage per body already
// passed, dmg × mult^n on top of range falloff. The two are deliberately
// per-weapon because they want different things: the sniper's 1.0 keeps the
// collateral a full one-shot (0.85 would leave the second man on 6hp and read
// as a bug), while the rifle's 0.6 makes its pierce a bonus instead of double
// DPS into a lined-up horde.
export type WeaponId = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper';

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
    moveSpreadMult: 2.0, pellets: 1, kick: 3, pierce: 0, pierceMult: 1,
  },
  smg: {
    id: 'smg', name: 'Viper SMG', auto: true,
    damage: 16, rpm: 820, mag: 32, reserve: 256, reloadMs: 1500,
    range: 700, falloffStart: 300, falloffMult: 0.5,
    baseSpread: 0.035, maxSpread: 0.22, bloom: 0.016, recover: 0.5,
    moveSpreadMult: 1.4, pellets: 1, kick: 2, pierce: 0, pierceMult: 1,
  },
  rifle: {
    id: 'rifle', name: 'AR-7 Rifle', auto: true,
    damage: 26, rpm: 600, mag: 30, reserve: 240, reloadMs: 1800,
    range: 1100, falloffStart: 600, falloffMult: 0.65,
    baseSpread: 0.02, maxSpread: 0.15, bloom: 0.019, recover: 0.45,
    moveSpreadMult: 1.9, pellets: 1, kick: 3.5, pierce: 1, pierceMult: 0.6,
  },
  shotgun: {
    id: 'shotgun', name: 'M870 Shotgun', auto: false,
    damage: 13, rpm: 75, mag: 6, reserve: 72, reloadMs: 2400,
    range: 420, falloffStart: 150, falloffMult: 0.35,
    baseSpread: 0.09, maxSpread: 0.16, bloom: 0.02, recover: 0.6,
    moveSpreadMult: 1.2, pellets: 8, kick: 8, pierce: 0, pierceMult: 1,
  },
  sniper: {
    id: 'sniper', name: 'LR-50 Marksman', auto: false,
    damage: 110, rpm: 42, mag: 5, reserve: 50, reloadMs: 2600,
    range: 1800, falloffStart: 1800, falloffMult: 1.0,
    baseSpread: 0.002, maxSpread: 0.3, bloom: 0.25, recover: 0.4,
    moveSpreadMult: 14.0, pellets: 1, kick: 10, pierce: 3, pierceMult: 1,
  },
};

export const PRIMARIES = ['smg', 'rifle', 'shotgun', 'sniper'] as const;
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
