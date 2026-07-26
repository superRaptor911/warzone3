import { WEAPONS, type Weapon, type WeaponId } from '../shared/weapons.ts';
import { PLAYER_HP, STAMINA_MAX, ZOMBIE_RADII } from '../shared/constants.ts';
import type { Ammo, InputMsg, PickupKind, Vec2, ZombieTypeId } from '../shared/types.ts';
import type { BotController } from './bot.ts';

let nextEntityId = 1;
export function newId(): number { return nextEntityId++; }

export function makeAmmo(weaponId: WeaponId): Ammo {
  const w = WEAPONS[weaponId];
  return { mag: w.mag, reserve: w.reserve };
}

export interface Player {
  id: number;
  name: string;
  team: number;
  bot: boolean;
  x: number; y: number; aim: number;
  hp: number;
  alive: boolean;
  stamina: number;
  sprinting: boolean;
  slots: WeaponId[];
  ammo: Partial<Record<WeaponId, Ammo>>;
  slot: number;
  // timers, in seconds, counted down as inputs/ticks are processed
  fireCd: number; reloadT: number; switchT: number;
  spread: number; sinceShot: number; moving: boolean; firePrev: boolean;
  respawnT: number; protectT: number;
  lastSeq: number; inputQueue: InputMsg[]; inputBudget: number;
  lastRt: number; // last reported client render time, for lag compensation (0 = none)
  kills: number; deaths: number; points: number; damageDealt: number;
  joinedAt: number;
  botCtl: BotController | null; // bot controller state, set for bots
  /**
   * Outbreak-only, bots only: free full heals left this wave. Refilled by
   * `ZombieRoom.startWave`, spent on the damage path. Server-side and never
   * snapshotted — like `points`, a field only one mode reads.
   */
  botHeals: number;
  // ---- persistence (server-only; never snapshotted) ----
  /**
   * Persistent profile this human is playing as, or null. Null for every bot,
   * and for a human the database could not serve — `Room.flushStats` keys off
   * this, so both cases cost nothing and no test that builds rooms directly
   * ever touches a database.
   */
  profileId: string | null;
  /**
   * May the waves this player survives raise their own resume point? Fixed once
   * at join, from whether the room was armed at or below where they could have
   * started it themselves. False means a carried run: `best_wave` still climbs,
   * the resume point does not.
   */
  earning: boolean;
  /** Kills/deaths already written to the profile, so a flush writes a delta. */
  bankedKills: number; bankedDeaths: number;
}

export function createPlayer(
  { name, team, bot = false, primary = 'rifle' }:
  { name: string; team: number; bot?: boolean; primary?: WeaponId },
): Player {
  return {
    id: newId(), name, team, bot,
    x: 0, y: 0, aim: 0, hp: PLAYER_HP, alive: true,
    stamina: STAMINA_MAX, sprinting: false,
    slots: ['pistol', primary],
    ammo: { pistol: makeAmmo('pistol'), [primary]: makeAmmo(primary) },
    slot: 1,
    fireCd: 0, reloadT: 0, switchT: 0,
    spread: 0, sinceShot: 0, moving: false, firePrev: false,
    respawnT: 0, protectT: 0,
    lastSeq: 0, inputQueue: [], inputBudget: 0, lastRt: 0,
    kills: 0, deaths: 0, points: 0, damageDealt: 0,
    joinedAt: Date.now(),
    botCtl: null, botHeals: 0,
    profileId: null, earning: false, bankedKills: 0, bankedDeaths: 0,
  };
}

export function weaponOf(p: Player): Weapon { return WEAPONS[p.slots[p.slot]]; }
export function ammoOf(p: Player): Ammo { return p.ammo[p.slots[p.slot]]!; }

export function setPrimary(p: Player, weaponId: WeaponId): void {
  p.slots[1] = weaponId;
  if (!p.ammo[weaponId]) p.ammo[weaponId] = makeAmmo(weaponId);
  p.slot = 1;
  p.reloadT = 0;
  p.switchT = 0.35;
}

export function refillAmmo(p: Player): void {
  for (const wid of p.slots) {
    const w = WEAPONS[wid], ammo = p.ammo[wid]!;
    ammo.mag = w.mag;
    ammo.reserve = w.reserve;
  }
}

/** A supply crate lying on the Outbreak floor. Inert: it has no simulation of
 *  its own, it is just a position a walking human can consume. */
export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number; y: number;
}

export function createPickup(kind: PickupKind, x: number, y: number): Pickup {
  return { id: newId(), kind, x, y };
}

/** Is every owned weapon topped up? An ammo crate refuses if so, and is left
 *  standing rather than consumed — the same shape as the shop refusing a heal
 *  at full health. */
export function ammoFull(p: Player): boolean {
  for (const wid of p.slots) {
    const w = WEAPONS[wid], ammo = p.ammo[wid]!;
    if (ammo.mag < w.mag || ammo.reserve < w.reserve) return false;
  }
  return true;
}

export const ZOMBIE_TYPES: Record<ZombieTypeId, {
  hp: number; speed: number; damage: number; radius: number; attackMs: number; points: number;
}> = {
  walker: { hp: 60, speed: 62, damage: 12, radius: ZOMBIE_RADII.walker, attackMs: 900, points: 10 },
  runner: { hp: 40, speed: 138, damage: 9, radius: ZOMBIE_RADII.runner, attackMs: 700, points: 15 },
  brute: { hp: 320, speed: 46, damage: 34, radius: ZOMBIE_RADII.brute, attackMs: 1300, points: 60 },
};

export interface Zombie {
  id: number;
  type: ZombieTypeId;
  x: number; y: number; aim: number;
  hp: number; maxHp: number;
  speed: number;
  frenzy: number; effSpeed: number;
  radius: number; damage: number; attackMs: number;
  attackCd: number;
  path: Vec2[] | null; pathT: number; targetId: number | null;
}

export function createZombie(type: ZombieTypeId, x: number, y: number): Zombie {
  const t = ZOMBIE_TYPES[type];
  return {
    id: newId(), type, x, y, aim: 0,
    hp: t.hp, maxHp: t.hp, speed: t.speed * (0.9 + Math.random() * 0.2),
    frenzy: 0, effSpeed: t.speed,
    radius: t.radius, damage: t.damage, attackMs: t.attackMs,
    attackCd: 0, path: null, pathT: Math.random() * 0.5, targetId: null,
  };
}
