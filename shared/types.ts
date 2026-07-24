// Protocol and simulation types shared by server and client. Type-only module:
// it strips to nothing at runtime, so it must never export values.
import type { WeaponId } from './weapons.ts';

export type GameMode = 'tdm' | 'zombie';
// TDM rooms are 'live'/'over'; zombie rooms are 'break'/'wave'/'over'.
export type RoomState = 'live' | 'over' | 'break' | 'wave';
export type ZombieTypeId = 'walker' | 'runner' | 'brute';

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
}

export interface Ammo { mag: number; reserve: number }

export interface SerializedGrid {
  w: number;
  h: number;
  tiles: number[];
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
}
