import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { TDMRoom } from './tdm.ts';
import { ZombieRoom } from './zombie.ts';
import { nextBotName } from './bot.ts';
import { TEAM, MAX_TEAM_SIZE, MAX_SURVIVORS } from '../shared/constants.ts';
import { PRIMARIES, WEAPONS, isPrimary } from '../shared/weapons.ts';
import type { GameMode } from '../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
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

function findRoom(mode: GameMode): GameRoom {
  for (const room of rooms.values()) {
    if (room.mode !== mode) continue;
    if (mode === 'tdm' && room.humanCount() < MAX_TEAM_SIZE * 2) return room;
    if (mode === 'zombie' && room.humanCount() < MAX_SURVIVORS) return room;
  }
  const id = `${mode}-${roomCounter++}`;
  const room = mode === 'tdm' ? new TDMRoom(id) : new ZombieRoom(id);
  rooms.set(id, room);
  console.log(`[room] created ${id}`);
  return room;
}

function leaveRoom(ws: GameSocket): void {
  if (!ws.meta) return;
  const { room, playerId } = ws.meta;
  if (!rooms.has(room.id)) return;
  const p = room.players.get(playerId);
  room.clients.delete(playerId);
  if (p) {
    room.players.delete(playerId);
    room.event({ e: 'leave', name: p.name });
  }
  if (room.humanCount() === 0) {
    room.destroy();
    rooms.delete(room.id);
    console.log(`[room] closed ${room.id}`);
  }
}

function sanitizeName(raw: unknown): string {
  const name = String(raw || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 16);
  return name || 'Player';
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
      const room = findRoom(mode);
      const primary = isPrimary(m.primary) ? m.primary : 'rifle';
      const p = room.addPlayer({ name: sanitizeName(m.name), bot: false, primary });
      if (!p) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      room.clients.set(p.id, ws);
      if (room.mode === 'zombie') room.applyCheckpoint(m.cp);
      ws.meta = { room, playerId: p.id };
      ws.send(JSON.stringify({
        t: 'welcome', id: p.id, roomId: room.id, mode,
        mapName: room.mapName, map: room.grid.serialize(),
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
      case 'addBot': {
        if (room.mode === 'tdm') {
          const team = m.team === 'enemy'
            ? (p.team === TEAM.RED ? TEAM.BLUE : TEAM.RED)
            : p.team;
          room.addPlayer({
            name: nextBotName(), bot: true, team,
            primary: PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)],
          });
        } else {
          room.addPlayer({ name: nextBotName(), bot: true });
        }
        break;
      }
      case 'removeBot': {
        if (room.mode === 'tdm') {
          const team = m.team === 'enemy'
            ? (p.team === TEAM.RED ? TEAM.BLUE : TEAM.RED)
            : p.team;
          room.removeBot(team);
        } else {
          room.removeBot();
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
