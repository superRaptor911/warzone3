// Shared constants — imported by both server and client.
import type { ZombieTypeId } from './types.ts';

export const TILE = 48;

export const TICK_RATE = 30;          // server simulation Hz
export const SNAPSHOT_EVERY = 2;      // send snapshot every N ticks (15 Hz)
export const INTERP_DELAY_MS = 130;   // client render delay for remote entities

export const PLAYER_RADIUS = 17;
export const PLAYER_SPEED = 175;      // px/s
export const SPRINT_MULT = 1.42;
export const STAMINA_MAX = 100;
export const STAMINA_DRAIN = 26;      // per second while sprinting (~3.8s of sprint)
export const STAMINA_REGEN = 18;      // per second while not sprinting
export const STAMINA_MIN_TO_SPRINT = 15; // hysteresis: must recover this much to sprint again
export const PLAYER_HP = 100;
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECT_MS = 2000;
export const SWITCH_MS = 350;         // weapon switch delay

// Per-type collision radii — the single source of truth. The server builds
// zombie stats from these (authoritative hitboxes) and the client bakes its
// body frames and rings at the same values, so visuals can never drift from
// the hitbox. Brute stays at 22: Outbreak's outer buildings have 1-tile
// (TILE=48px) doors, and a diameter of 48 would jam it in every doorway.
export const ZOMBIE_RADII: Record<ZombieTypeId, number> = {
  walker: 17,
  runner: 15,
  brute: 22,
  spitter: 16,
  bomber: 19,
};

export const TDM_SCORE_LIMIT = 40;
export const TDM_TIME_LIMIT_MS = 5 * 60 * 1000;
export const MATCH_RESTART_MS = 10000;

export const MAX_TEAM_SIZE = 5;
export const MAX_SURVIVORS = 5;

export const WAVE_BREAK_MS = 10000;
export const MAX_ZOMBIES_ALIVE = 26;

export const TEAM = { RED: 0, BLUE: 1, SURVIVOR: 2 };

// Zombie-mode shop (cost in points)
export type ShopItemId = 'smg' | 'shotgun' | 'rifle' | 'lmg' | 'sniper' | 'ammo' | 'health';

export const SHOP: Record<ShopItemId, { cost: number }> = {
  smg:     { cost: 300 },
  shotgun: { cost: 500 },
  rifle:   { cost: 800 },
  lmg:     { cost: 1000 },
  sniper:  { cost: 1200 },
  ammo:    { cost: 150 },   // refill all ammo
  health:  { cost: 200 },   // full heal
};

export const ZOMBIE_KILL_POINTS: Record<ZombieTypeId, number> =
  { walker: 10, runner: 15, brute: 60, spitter: 40, bomber: 25 };

// ---- Outbreak: spitter acid ----
// The glob is dodgeable on purpose (350 px/s against a 175 px/s walk), and the
// puddle is the whole payload — a direct hit does no extra damage, it just
// splashes the puddle at your feet, which is why sidestepping still matters.
// The puddle burns SURVIVORS ONLY (zombies wade through their own goo), ticks
// damage far below BOT_HEAL_AT, and must never touch movement: acid that slowed
// you would have to live in shared/physics.ts and desync prediction.
export const GLOB_SPEED = 350;    // px/s — slower than a walking survivor
export const GLOB_RADIUS = 7;     // contact radius in flight, and the drawn size
export const GLOB_RANGE = 460;    // px of flight before it bursts on its own
export const PUDDLE_RADIUS = 55;  // px — wider than a doorway is not, so it denies one
export const PUDDLE_LIFE_MS = 4000;

// ---- Outbreak: bomber blast ----
// Radius only; the two damage peaks live where each is constrained — the
// survivor peak in ZOMBIE_TYPES (it must stay under BOT_HEAL_AT, see
// server/zombie.ts) and the zombie peak in server/zombie.ts (server-only).
export const BLAST_RADIUS = 110;

// ---- Outbreak supply crates ----
// Deliberately as strong as the shop's own ammo/health rows and rare instead of
// plentiful: two placed at each wave start, accumulating to a cap, so a wave
// cleared without looting leaves its crates standing for the next one. Anything
// weaker would be a chore to walk to; anything more frequent would retire the
// 150/200 point shop rows the bots also buy from.
export const PICKUP_RADIUS = 13;
export const PICKUPS_PER_WAVE = 2;
export const MAX_PICKUPS = 4;
// Minimum distance from every survivor spawn. Without it the compound (where
// the squad already stands, and respawns) collects the crates for free.
export const PICKUP_SPAWN_CLEAR = 400;
