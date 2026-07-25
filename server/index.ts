import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { TDMRoom } from './tdm.ts';
import { ZombieRoom } from './zombie.ts';
import {
  claimProfile, dbAvailable, leaderboard, nameError, nameTaken, profileById,
  suggestName, touchProfile, validId,
} from './db.ts';
import { MAX_TEAM_SIZE, MAX_SURVIVORS } from '../shared/constants.ts';
import { WEAPONS, isPrimary } from '../shared/weapons.ts';
import type { GameMode, ProfileDTO } from '../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// ---- profile API ----
// Read-only, and deliberately so: there is no mint endpoint. A profile row is
// INSERTed only when a socket actually joins a room, so creating garbage rows
// costs a real room seat instead of a curl loop.
function json(res: http.ServerResponse, code: number, body: object): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(s);
}

function api(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname === '/api/profile') {
    const p = profileById(url.searchParams.get('id'));
    // The 404 is load-bearing: it is what lets the menu tell a mistyped recovery
    // code from a real one before it reconnects and claims a blank profile.
    if (!p) json(res, 404, { error: 'no such profile' });
    else json(res, 200, p);
    return true;
  }
  if (url.pathname === '/api/name') {
    const raw = url.searchParams.get('n');
    // No name asked about: hand back a free suggestion for the menu to pre-fill.
    if (raw === null || sanitizeName(raw) === '') {
      json(res, 200, { free: false, suggestion: suggestName() });
      return true;
    }
    const name = sanitizeName(raw);
    const err = nameError(name) || (nameTaken(name) ? 'taken' : null);
    json(res, 200, err ? { free: false, why: err } : { free: true });
    return true;
  }
  if (url.pathname === '/api/leaderboard') {
    json(res, 200, leaderboard(10));
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  // Before the static branch on purpose: everything below rewrites an unknown
  // path to /client/<path>, so /api/* would 404 as a missing file.
  if (url.pathname.startsWith('/api/') && api(url, res)) return;
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') urlPath = '/client/index.html';
  else if (!urlPath.startsWith('/shared/') && !urlPath.startsWith('/client/')) {
    urlPath = '/client' + urlPath;
  }
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    // .ts sources are served to the browser as plain JS, types stripped
    // in-place (whitespace-preserving, so stack traces keep line numbers)
    if (file.endsWith('.ts')) {
      try {
        const js = stripTypeScriptTypes(data.toString());
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(js);
      } catch {
        res.writeHead(500); res.end('type strip failed');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- rooms / matchmaking ----
type GameRoom = TDMRoom | ZombieRoom;
interface SocketMeta { room: GameRoom; playerId: number }
type GameSocket = WebSocket & { meta?: SocketMeta | null; isAlive?: boolean };

const rooms = new Map<string, GameRoom>();
let roomCounter = 1;

// `created` matters to the caller: the bot roster on a join message is only
// honored by the player who brought the room into existence (the same rule
// ZombieRoom.applyCheckpoint uses), so a later joiner inherits the match as it
// stands instead of reshaping someone else's game.
function findRoom(mode: GameMode): { room: GameRoom; created: boolean } {
  for (const room of rooms.values()) {
    if (room.mode !== mode) continue;
    if (mode === 'tdm' && room.humanCount() < MAX_TEAM_SIZE * 2) return { room, created: false };
    if (mode === 'zombie' && room.humanCount() < MAX_SURVIVORS) return { room, created: false };
  }
  const id = `${mode}-${roomCounter++}`;
  const room = mode === 'tdm' ? new TDMRoom(id) : new ZombieRoom(id);
  rooms.set(id, room);
  console.log(`[room] created ${id}`);
  return { room, created: true };
}

// Roster target off the wire. Untrusted: coerced, floored and capped at the
// mode's own maximum, so nothing here can ask for a room bigger than the mode
// supports. A per-team target in TDM, a total squad size in zombie.
function botTargetOf(raw: unknown, mode: GameMode): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, mode === 'tdm' ? MAX_TEAM_SIZE : MAX_SURVIVORS);
}

function leaveRoom(ws: GameSocket): void {
  if (!ws.meta) return;
  const { room, playerId } = ws.meta;
  if (!rooms.has(room.id)) return;
  const p = room.players.get(playerId);
  room.clients.delete(playerId);
  if (p) {
    // Before the delete: this is the last moment the counters exist. Quitting
    // mid-match is the common way to leave, so without this the match banks
    // nothing.
    room.flushStats(p);
    room.players.delete(playerId);
    room.event({ e: 'leave', name: p.name });
  }
  if (room.humanCount() === 0) {
    room.destroy();
    rooms.delete(room.id);
    console.log(`[room] closed ${room.id}`);
    return;
  }
  // A human joining a full team evicted a bot to get in; when they leave, the
  // seat stays empty unless we refill it. There is no in-game bot control any
  // more, so without this the roster only ever decays.
  room.fillBots();
}

// Wire hygiene only: printable ASCII, single-spaced, 16 chars. Returns '' for a
// blank field rather than a default, because the two callers want different
// things from that — a claim generates a free name, an unrecorded session just
// needs something to display.
function sanitizeName(raw: unknown): string {
  return String(raw || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
    .trim();
}

type Claim = { profile: ProfileDTO | null; reject?: undefined } | { profile?: undefined; reject: string };

/**
 * Who is joining. Resolved *before* matchmaking, so a name we are going to
 * refuse never consumes a room seat.
 *
 * A token that resolves is the whole answer: the profile owns its name, so
 * `m.name` is ignored entirely for a returning player — the wire cannot set a
 * display name any more. A token this server has never seen (cleared database,
 * a code typed wrong past the menu's check) falls through to a fresh claim.
 *
 * With no database at all this returns a null profile: the match is played and
 * simply not recorded, which is the fail-soft path.
 */
function resolveProfile(rawId: unknown, rawName: unknown): Claim {
  if (!dbAvailable()) return { profile: null };
  if (validId(rawId)) {
    const existing = profileById(rawId);
    if (existing) return { profile: existing };
  }
  // A blank field is not an error: the menu pre-fills a suggestion, and anyone
  // who cleared it still gets a distinct name rather than fighting over 'Player'.
  const name = sanitizeName(rawName) || suggestName();
  const err = nameError(name);
  if (err) return { reject: err };
  const claimed = claimProfile(name);
  if (claimed) return { profile: claimed };
  // The UNIQUE index refused it. Almost always "taken"; anything else is the
  // write itself failing, and either way there is no profile to play as.
  return { reject: nameTaken(name) ? 'taken' : 'unavailable' };
}

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (socket) => {
  const ws = socket as GameSocket;
  ws.meta = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    // untrusted wire input: everything read off `m` is validated/coerced below
    let m: any;
    try { m = JSON.parse(String(buf)); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!ws.meta) {
      if (m.t !== 'join') return;
      const mode: GameMode = m.mode === 'zombie' ? 'zombie' : 'tdm';
      const claim = resolveProfile(m.pid, m.name);
      if (claim.reject) {
        ws.send(JSON.stringify({ t: 'namebad', why: claim.reject }));
        ws.close();
        return;
      }
      const profile = claim.profile;
      const { room, created } = findRoom(mode);
      const primary = isPrimary(m.primary) ? m.primary : 'rifle';
      const p = room.addPlayer({
        name: profile ? profile.name : (sanitizeName(m.name) || 'Player'),
        bot: false, primary,
      });
      if (!p) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      if (profile) { p.profileId = profile.id; touchProfile(profile.id); }
      room.clients.set(p.id, ws);
      // Roster is set after the human is in, so TDM balances the bots around
      // whichever team they landed on.
      if (created) { room.botTarget = botTargetOf(m.bots, mode); room.fillBots(); }
      if (room.mode === 'zombie') {
        // Same rule as the bot roster: only the join that *created* the room may
        // arm it, so a later joiner inherits the match instead of dragging
        // someone else's run to their own wave. `fresh` is the menu's
        // start-from-wave-1 toggle — it skips arming without touching the record.
        if (created && profile && !m.fresh) room.arm(profile.resumeWave);
        // Decided after arming, and fixed for the session: waves raise this
        // player's resume point only if the room began at or below where they
        // could have started it themselves. A carried run still raises bestWave.
        p.earning = !!profile && room.checkpoint <= profile.resumeWave;
      }
      ws.meta = { room, playerId: p.id };
      ws.send(JSON.stringify({
        t: 'welcome', id: p.id, roomId: room.id, mode,
        mapName: room.mapName, map: room.grid.serialize(),
        pid: profile ? profile.id : undefined,
        name: p.name,
      }));
      return;
    }

    const { room, playerId } = ws.meta;
    if (!rooms.has(room.id)) return;
    const p = room.players.get(playerId);
    if (!p) return;

    switch (m.t) {
      case 'input':
        room.queueInput(p, m);
        break;
      // app-level RTT probe (distinct from the ws-protocol ping above): echo the
      // client's own timestamp back so it can measure without a clock sync
      case 'ping':
        if (typeof m.ts === 'number') ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
        break;
      case 'reload':
        room.startReload(p);
        break;
      case 'slot':
        room.trySwitch(p, m.i | 0);
        break;
      case 'buy':
        if (room.mode === 'zombie') room.buy(p, String(m.item));
        break;
      case 'primary': { // TDM: change loadout, effective immediately with full ammo
        const w: unknown = m.w;
        if (room.mode === 'tdm' && isPrimary(w)) {
          p.slots[1] = w;
          p.ammo[w] = { mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve };
          if (p.alive && p.slot !== 1) room.trySwitch(p, 1);
        }
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => { /* close handler cleans up */ });
});

// drop dead connections
setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as GameSocket;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`warzone3 listening on http://localhost:${PORT}`);
});
