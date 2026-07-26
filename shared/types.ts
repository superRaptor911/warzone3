// Protocol and simulation types shared by server and client. Type-only module:
// it strips to nothing at runtime, so it must never export values.
import type { WeaponId } from './weapons.ts';

export type GameMode = 'tdm' | 'zombie';
// TDM rooms are 'live'/'over'; zombie rooms are 'break'/'wave'/'over'.
export type RoomState = 'live' | 'over' | 'break' | 'wave';
export type ZombieTypeId = 'walker' | 'runner' | 'brute';
/** Outbreak floor loot. Same two effects the shop sells, for free and rarely. */
export type PickupKind = 'ammo' | 'health';

export interface Vec2 { x: number; y: number }

// WASD flags as sent over the wire (1/0, but any truthy value counts).
export interface MoveKeys {
  w?: number | boolean;
  a?: number | boolean;
  s?: number | boolean;
  d?: number | boolean;
}

// One input message. Untrusted over the wire, so everything is optional and
// validated/clamped where it is consumed; bots emit the same shape.
export interface InputMsg {
  t?: 'input';
  seq?: number;
  dt?: number;
  keys?: MoveKeys;
  aim?: number;
  fire?: boolean;
  sprint?: boolean;
  // Render time this input was aimed at, on the server clock (the client's
  // GameState.renderTime()). Lets the server resolve shots against the world
  // the shooter was actually looking at. Untrusted: clamped server-side.
  rt?: number;
}

export interface Ammo { mag: number; reserve: number }

/**
 * One piece of free-position scenery: a stain, a skid mark, a scatter of
 * rubble. Purely decorative — the rule in shared/maps.ts is that anything
 * which collides or occludes is tile-aligned and lives in `tiles`/`mat`, so a
 * DecorSpec can never affect the simulation. Positions are world px, `rot` is
 * radians, `s` scales the baked frame, `f` indexes the decor art table
 * (DECOR in client/js/gfx/tileset.ts).
 */
export interface DecorSpec { x: number; y: number; rot: number; s: number; f: number }

export interface SerializedGrid {
  w: number;
  h: number;
  tiles: number[];
  /**
   * Render-only material per tile, parallel to `tiles`. Never consulted by
   * collision, raycasts, LOS or pathfinding — see the note on Grid.mat.
   */
  mat: number[];
  decor: DecorSpec[];
  redSpawns: Vec2[];
  blueSpawns: Vec2[];
  survivorSpawns: Vec2[];
  zombieSpawns: Vec2[];
}

// ---- server -> client events ----
export type GameEvent =
  | { e: 'shot'; id: number; x: number; y: number; w: WeaponId; p: { a: number; d: number }[] }
  | { e: 'hit'; x: number; y: number; sid: number; vid: number; amt: number; z: 0 | 1 }
  | { e: 'die'; id: number; x: number; y: number; z: 0 | 1 }
  | { e: 'zdie'; x: number; y: number; type: ZombieTypeId }
  | { e: 'kill'; k: string; v: string; w: string; kt: number; vt: number }
  | { e: 'reload'; id: number }
  | { e: 'wave'; n: number; count: number }
  | { e: 'break'; next: number; bonus: number }
  | { e: 'frenzy' }
  | { e: 'over'; wave: number }
  | { e: 'matchend'; winner: number }
  | { e: 'matchstart' }
  | { e: 'buy'; id: number; item: string }
  | { e: 'pick'; pid: number; kind: PickupKind; x: number; y: number }
  | { e: 'revive'; id: number }
  | { e: 'join'; name: string; team: number }
  | { e: 'leave'; name: string };

// ---- snapshots (short field names to keep JSON small) ----
export interface PlayerSnap {
  id: number; name: string; team: number; bot: 0 | 1;
  x: number; y: number; aim: number; hp: number; alive: 0 | 1;
  w: WeaponId; rld: 0 | 1;
  k: number; d: number; prot: 0 | 1;
  spr: number;
}

export interface PickupSnap {
  id: number; x: number; y: number; kind: PickupKind;
}

export interface ZombieSnap {
  id: number; x: number; y: number;
  hp: number; maxHp: number; type: ZombieTypeId; aim: number;
  fr: 0 | 1;
}

// Personalized block for the receiving client (authoritative self state that
// prediction restores before replaying unacked inputs).
export interface SelfSnap {
  slot: number;
  slots: WeaponId[];
  ammo: Ammo[];
  reloadT: number;
  reloadTotal: number;
  // Weapon-switch lockout remaining. The client's local gun mirror has to gate
  // on this too, or at high ping it fires phantom tracers the server rejects.
  sw: number;
  points: number;
  respawnT: number;
  stam: number;
  spg: 0 | 1;
}

export interface SnapshotBase {
  t: 'snap';
  tick: number;
  now: number;
  state: RoomState;
  players: PlayerSnap[];
  events: GameEvent[];
  // mutated per client just before sending
  ack?: number;
  self?: SelfSnap;
}

export interface TdmModeState {
  mode: 'tdm';
  scores: number[];
  timeLeft: number;
  restartT: number;
}

export interface ZombieModeState {
  mode: 'zombie';
  wave: number;
  zombies: ZombieSnap[];
  pk: PickupSnap[]; // supply crates on the floor
  left: number;
  breakT: number;
  restartT: number;
  cp: number; // checkpoint wave (multiple of 5, 0 = none); runs restart here after a wipe
}

export type TdmSnapshot = SnapshotBase & TdmModeState;
export type ZombieSnapshot = SnapshotBase & ZombieModeState;
export type Snapshot = TdmSnapshot | ZombieSnapshot;

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  roomId: string;
  mode: GameMode;
  mapName: string;
  map: SerializedGrid;
  /**
   * Persistent profile token, minted on a first join. Distinct from `id`, which
   * is the in-room player id and changes every match. Absent when the server
   * has no database (fail-soft: the match is played, nothing is recorded).
   */
  pid?: string;
  /**
   * The name the profile owns. Authoritative: names are claimed once and never
   * change, so the client displays this rather than what it typed.
   */
  name?: string;
}

/**
 * A player profile as served by `GET /api/profile` and `welcome`. Ordinary JSON
 * over HTTP, not part of the 15Hz snapshot path — nothing here is on the wire
 * during a match.
 */
export interface ProfileDTO {
  id: string;
  name: string;
  /** Deepest Outbreak wave reached, exact. Counts carried runs. */
  bestWave: number;
  /** Wave a solo run resumes at: a multiple of 5, and only ever earned. */
  resumeWave: number;
  tdmKills: number; tdmDeaths: number;
  zKills: number; zDeaths: number;
}
