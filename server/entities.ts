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

/**
 * `damage` is each type's hit on a SURVIVOR, whatever shape the attack takes:
 * claws for the melee three, one acid tick for the spitter, the blast's
 * point-blank peak for the bomber. Two of those are constrained, not tuned —
 * the spitter's tick must stay far below BOT_HEAL_AT (a bot in acid spends a
 * heal charge per tick that leaves it under 40, so big ticks eat both charges
 * on chip damage), and the bomber's peak must stay UNDER it, or a bot holding
 * a charge could be killed by a single blow, which breaks the derivation
 * BOT_HEAL_AT is (see server/zombie.ts). matchflow asserts both.
 *
 * `attackMs` is the cooldown of that same attack; for the spitter that is the
 * gap between spits (the windup is separate, see SPIT_WINDUP_MS). The bomber
 * has no repeatable attack — contact detonates it — so its entry is inert.
 */
export const ZOMBIE_TYPES: Record<ZombieTypeId, {
  hp: number; speed: number; damage: number; radius: number; attackMs: number; points: number;
}> = {
  walker: { hp: 60, speed: 62, damage: 12, radius: ZOMBIE_RADII.walker, attackMs: 900, points: 10 },
  runner: { hp: 40, speed: 138, damage: 9, radius: ZOMBIE_RADII.runner, attackMs: 700, points: 15 },
  brute: { hp: 320, speed: 46, damage: 34, radius: ZOMBIE_RADII.brute, attackMs: 1300, points: 60 },
  spitter: { hp: 50, speed: 55, damage: 8, radius: ZOMBIE_RADII.spitter, attackMs: 2800, points: 40 },
  bomber: { hp: 70, speed: 95, damage: 34, radius: ZOMBIE_RADII.bomber, attackMs: 900, points: 25 },
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
  /** Spit windup remaining, in seconds. Only ever set on spitters. */
  windup: number;
  path: Vec2[] | null; pathT: number; targetId: number | null;
}

export function createZombie(type: ZombieTypeId, x: number, y: number): Zombie {
  const t = ZOMBIE_TYPES[type];
  return {
    id: newId(), type, x, y, aim: 0,
    hp: t.hp, maxHp: t.hp, speed: t.speed * (0.9 + Math.random() * 0.2),
    frenzy: 0, effSpeed: t.speed,
    radius: t.radius, damage: t.damage, attackMs: t.attackMs,
    attackCd: 0, windup: 0, path: null, pathT: Math.random() * 0.5, targetId: null,
  };
}

/** An acid glob in flight. Direction is fixed at launch — it flies straight
 *  until a wall, the first living survivor, or the end of `left`, and splashes
 *  a puddle wherever it dies. No owner: the puddle credits nobody. */
export interface Glob {
  id: number;
  x: number; y: number;
  dx: number; dy: number; // unit direction
  left: number;           // px of flight remaining
}

export function createGlob(x: number, y: number, angle: number, range: number): Glob {
  return { id: newId(), x, y, dx: Math.cos(angle), dy: Math.sin(angle), left: range };
}

/** An acid puddle on the ground. `t` counts down to expiry; `tick` counts down
 *  to the next damage pass, starting at 0 so a glob stopped by your body hurts
 *  on the frame it lands. */
export interface Puddle {
  id: number;
  x: number; y: number;
  t: number; tick: number;
}

export function createPuddle(x: number, y: number, life: number): Puddle {
  return { id: newId(), x, y, t: life, tick: 0 };
}
