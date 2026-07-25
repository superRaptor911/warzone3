/**
 * Persistent player profiles: the name registry and the stats store.
 *
 * The ONLY module that imports `node:sqlite`. Nothing in `shared/` or `client/`
 * may reach this — `shared/` is served to the browser with its types stripped,
 * so a `node:` import there would break the page rather than fail a build.
 *
 * Everything here is **fail-soft**: if the database cannot be opened (missing
 * directory, bad permissions, corrupt file) the server still boots and every
 * function below degrades to "no persistence" — reads return null/empty, writes
 * do nothing. A corrupt stats file must never be able to take a multiplayer
 * server offline; the log line is the symptom, the game stays playable and
 * everyone starts at wave 1.
 *
 * Writes are synchronous, on the game thread, by necessity (node:sqlite has no
 * async API). That is affordable because of *when* they happen: a handful of
 * UPDATEs per player per match (see Room.flushStats), never per kill and never
 * per tick — tens of microseconds against a 33ms tick budget.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameMode, ProfileDTO } from '../shared/types.ts';

const SCHEMA_VERSION = 1;

/** Resume points are quantised to this, matching CHECKPOINT_EVERY in zombie.ts. */
const CHECKPOINT_EVERY = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'warzone3.db');

let db: DatabaseSync | null = null;
let opened = false;

/**
 * Open on first use, once. `WZ3_DB` overrides the path (`:memory:` in tests, so
 * a test run can never touch a real player's record).
 */
function conn(): DatabaseSync | null {
  if (opened) return db;
  opened = true;
  const file = process.env.WZ3_DB || DEFAULT_PATH;
  try {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    // WAL keeps a write from blocking the read a menu is waiting on; NORMAL
    // trades an fsync per commit for losing at most the last commits on a power
    // cut, which for kill counters is the right trade.
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA synchronous = NORMAL');
    migrate(d);
    db = d;
    console.log(`[db] profiles at ${file}`);
  } catch (err) {
    db = null;
    console.error('[db] disabled — persistence unavailable:', (err as Error).message);
  }
  return db;
}

// Version ladder rather than a bare CREATE IF NOT EXISTS: the production file is
// the one thing here that cannot be re-derived, so future columns need a place
// to land that is not "remember to ALTER the box by hand".
function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number };
  let v = row.user_version;
  if (v < 1) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        name_key    TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        best_wave   INTEGER NOT NULL DEFAULT 0,
        resume_wave INTEGER NOT NULL DEFAULT 0,
        tdm_kills   INTEGER NOT NULL DEFAULT 0,
        tdm_deaths  INTEGER NOT NULL DEFAULT 0,
        z_kills     INTEGER NOT NULL DEFAULT 0,
        z_deaths    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_tdm_kills ON profiles(tdm_kills DESC);
      CREATE INDEX IF NOT EXISTS idx_profiles_z_kills ON profiles(z_kills DESC);
    `);
    v = 1;
  }
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Test/ops hook: forget the handle so the next call re-opens. */
export function closeDb(): void {
  try { db?.close(); } catch { /* already gone */ }
  db = null;
  opened = false;
}

export function dbAvailable(): boolean { return conn() !== null; }

// ---- names ----
//
// The registry owns two rules, and both exist to stop one player wearing
// another's name rather than to be tidy.

/**
 * What counts as "the same name": case-folded, internal whitespace runs
 * collapsed, trimmed. So `Raptor` and `raptor` are one name, and `Raptor  Prime`
 * cannot shadow `Raptor Prime`, while the display casing the player typed is
 * preserved separately.
 *
 * Note the limit of the collapse: it folds *padding*, not spaces in general —
 * `R aptor` is still its own name. Folding those together would mean stripping
 * spaces outright, which starts rejecting names that are genuinely different.
 */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Why a name may not be claimed, or null if it is fine. Callers have already
 * run the wire sanitizer; this is the registry's own policy on top of it.
 */
export function nameError(name: string): string | null {
  const key = nameKey(name);
  if (!key) return 'empty';
  if (name.trim().length > 16) return 'too long';
  // Bots are 'BOT ' + name (server/bot.ts) and appear in the kill feed by name
  // alone. A human called "BOT Viper" reads as filler, which in TDM is a
  // tactical lie — bots and humans are played nothing alike.
  if (key.startsWith('bot ') || key === 'bot') return 'reserved';
  return null;
}

export function nameTaken(name: string): boolean {
  const d = conn();
  if (!d) return false; // no registry, no conflicts
  return !!d.prepare('SELECT 1 FROM profiles WHERE name_key = ?').get(nameKey(name));
}

/** An available `Player####`, for pre-filling the menu on a first visit. */
export function suggestName(): string {
  for (let i = 0; i < 40; i++) {
    const n = 'Player' + (1000 + Math.floor(Math.random() * 9000));
    if (!nameTaken(n)) return n;
  }
  return 'Player' + Date.now().toString().slice(-6);
}

// ---- profiles ----
function toDTO(r: Record<string, unknown>): ProfileDTO {
  return {
    id: String(r.id), name: String(r.name),
    bestWave: Number(r.best_wave), resumeWave: Number(r.resume_wave),
    tdmKills: Number(r.tdm_kills), tdmDeaths: Number(r.tdm_deaths),
    zKills: Number(r.z_kills), zDeaths: Number(r.z_deaths),
  };
}

/** Is this a well-formed token? Checked before it ever reaches a query. */
export function validId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw);
}

export function profileById(id: unknown): ProfileDTO | null {
  if (!validId(id)) return null;
  const d = conn();
  if (!d) return null;
  const r = d.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toDTO(r) : null;
}

export function touchProfile(id: string): void {
  const d = conn();
  if (!d) return;
  try { d.prepare('UPDATE profiles SET last_seen = ? WHERE id = ?').run(Date.now(), id); } catch { /* soft */ }
}

/**
 * Claim `name` for a brand-new profile, minting its token. Returns null if the
 * name is already owned (or unclaimable, or there is no database) — the caller
 * turns that into a rejection *before* a room seat is consumed.
 *
 * The UNIQUE index is the real arbiter, not the SELECT above it: two sockets can
 * claim the same name in the same millisecond, and one of them has to lose.
 */
export function claimProfile(name: string): ProfileDTO | null {
  const d = conn();
  if (!d || nameError(name)) return null;
  const id = randomBytes(16).toString('hex');
  const now = Date.now();
  try {
    d.prepare(
      'INSERT INTO profiles(id, name, name_key, created_at, last_seen) VALUES(?, ?, ?, ?, ?)',
    ).run(id, name.trim().replace(/\s+/g, ' '), nameKey(name), now, now);
  } catch {
    return null; // name taken (UNIQUE), or the write failed
  }
  return profileById(id);
}

// ---- stats ----
/**
 * Add a match's worth of kills/deaths. Callers pass a *delta* (see
 * Room.flushStats), so flushing twice costs nothing.
 */
export function addStats(id: string, mode: GameMode, kills: number, deaths: number): void {
  const d = conn();
  if (!d || (kills <= 0 && deaths <= 0)) return;
  const kc = mode === 'tdm' ? 'tdm_kills' : 'z_kills';
  const dc = mode === 'tdm' ? 'tdm_deaths' : 'z_deaths';
  try {
    d.prepare(
      `UPDATE profiles SET ${kc} = ${kc} + ?, ${dc} = ${dc} + ?, last_seen = ? WHERE id = ?`,
    ).run(Math.max(0, Math.floor(kills)), Math.max(0, Math.floor(deaths)), Date.now(), id);
  } catch { /* soft */ }
}

/**
 * Record reaching Outbreak wave `wave`.
 *
 * `best_wave` always climbs — it is the personal "deepest wave I have seen",
 * carried runs included. `resume_wave` climbs only when `earning` is set (the
 * room was armed at or below this player's own resume point), which is what
 * stops one deep host handing a stranger 39 skipped waves and
 * checkpointPoints(40) in starting cash. Resume stays quantised to
 * CHECKPOINT_EVERY, so the arming maths in zombie.ts is untouched.
 */
export function recordWave(id: string, wave: number, earning: boolean): void {
  const d = conn();
  if (!d || !(wave > 0)) return;
  const step = Math.floor(wave / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
  try {
    if (earning && step > 0) {
      d.prepare(
        `UPDATE profiles SET best_wave = MAX(best_wave, ?), resume_wave = MAX(resume_wave, ?),
         last_seen = ? WHERE id = ?`,
      ).run(Math.floor(wave), step, Date.now(), id);
    } else {
      d.prepare(
        'UPDATE profiles SET best_wave = MAX(best_wave, ?), last_seen = ? WHERE id = ?',
      ).run(Math.floor(wave), Date.now(), id);
    }
  } catch { /* soft */ }
}

export interface BoardRow { name: string; kills: number }

/**
 * Top players by kills, per mode. Zero-kill rows are excluded: a minted profile
 * that never fought is not a leaderboard entry.
 *
 * Bot kills count — the board measures kills, not opposition, which does mean a
 * TDM room left running against bots ranks. That is a known, accepted trade.
 */
export function leaderboard(limit = 10): { tdm: BoardRow[]; zombie: BoardRow[] } {
  const d = conn();
  if (!d) return { tdm: [], zombie: [] };
  const q = (col: string): BoardRow[] => {
    try {
      const rows = d.prepare(
        `SELECT name, ${col} AS kills FROM profiles WHERE ${col} > 0
         ORDER BY ${col} DESC, last_seen ASC LIMIT ?`,
      ).all(limit) as Record<string, unknown>[];
      return rows.map(r => ({ name: String(r.name), kills: Number(r.kills) }));
    } catch { return []; }
  };
  return { tdm: q('tdm_kills'), zombie: q('z_kills') };
}
