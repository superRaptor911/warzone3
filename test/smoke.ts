// Headless smoke test: map sanity + live server exercise of both modes.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { buildMap, T_FLOOR } from '../shared/maps.ts';
import { TILE } from '../shared/constants.ts';
import type { GameEvent, Snapshot, TdmSnapshot, WelcomeMsg, ZombieSnapshot } from '../shared/types.ts';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}

// ---- 1. map sanity: every floor tile reachable from a spawn ----
for (const name of ['compound', 'outbreak']) {
  console.log(`map: ${name}`);
  const g = buildMap(name);
  const floors: [number, number][] = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    if (g.get(x, y) === T_FLOOR) floors.push([x, y]);
  }
  check(floors.length > 100, `has open space (${floors.length} floor tiles)`);
  const spawnLists = [g.redSpawns, g.blueSpawns, g.survivorSpawns, g.zombieSpawns];
  for (const list of spawnLists) {
    for (const s of list) {
      check(!g.solidAtPx(s.x, s.y), `spawn at ${s.x},${s.y} is on open floor`);
    }
  }
  // flood fill from first spawn
  const start = g.redSpawns[0];
  const seen = new Set<string>();
  const stack: [number, number][] = [[Math.floor(start.x / TILE), Math.floor(start.y / TILE)]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    const k = x + ',' + y;
    if (seen.has(k) || g.get(x, y) !== T_FLOOR) continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  check(seen.size === floors.length, `fully connected (${seen.size}/${floors.length})`);
}

// ---- 2. live server ----
const PORT = 3199;
const srv = spawn(process.execPath, ['server/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr!.on('data', d => { srvErr += d; });
await new Promise<void>((res, rej) => {
  srv.stdout!.on('data', d => { if (String(d).includes('listening')) res(); });
  srv.on('exit', () => rej(new Error('server exited early: ' + srvErr)));
  setTimeout(() => rej(new Error('server start timeout: ' + srvErr)), 5000);
});
console.log('server up');

interface TestClient<S extends Snapshot> {
  ws: WebSocket;
  welcome: WelcomeMsg | null;
  snaps: S[];
  events: GameEvent[];
}

function client<S extends Snapshot>(joinMsg: object): TestClient<S> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c: TestClient<S> = { ws, welcome: null, snaps: [], events: [] };
  ws.on('open', () => ws.send(JSON.stringify(joinMsg)));
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'snap') { c.snaps.push(m); for (const e of m.events) c.events.push(e); }
  });
  return c;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// --- TDM ---
console.log('mode: tdm');
const a = client<TdmSnapshot>({ t: 'join', name: 'Alice', mode: 'tdm', primary: 'rifle' });
await sleep(400);
check(a.welcome && a.welcome.mode === 'tdm', 'welcome received with map');
check(a.welcome!.map.tiles.length === a.welcome!.map.w * a.welcome!.map.h, 'map serialized');

// add 4 bots to my team, 5 to enemy
for (let i = 0; i < 4; i++) a.ws.send(JSON.stringify({ t: 'addBot', team: 'mine' }));
for (let i = 0; i < 5; i++) a.ws.send(JSON.stringify({ t: 'addBot', team: 'enemy' }));
await sleep(500);
let snap = a.snaps[a.snaps.length - 1];
check(snap.players.length === 10, `10 players after adding bots (got ${snap.players.length})`);
const me0 = snap.players.find(p => p.id === a.welcome!.id)!;
const myTeam = snap.players.filter(p => p.team === me0.team);
check(myTeam.length === 5, 'my team has 5 (4 bots + me)');

// send movement+fire inputs for 2s
let seq = 0;
const mover = setInterval(() => {
  a.ws.send(JSON.stringify({
    t: 'input', seq: ++seq, dt: 0.033,
    keys: { d: 1 }, aim: 0, fire: seq % 20 < 8, sprint: false,
  }));
}, 33);
const before = { x: me0.x, y: me0.y };
await sleep(2500);
clearInterval(mover);
snap = a.snaps[a.snaps.length - 1];
const me1 = snap.players.find(p => p.id === a.welcome!.id)!;
check(me1.x > before.x + 50, `player moved right (${before.x} -> ${me1.x})`);
check(snap.ack! > 0 && snap.ack! <= seq, `input acked (ack=${snap.ack})`);
check(snap.self && snap.self.ammo.length === 2, 'self ammo present');
check(a.events.some(e => e.e === 'shot'), 'shot events emitted');
const botsMoved = snap.players.filter(p => p.bot).some(p => {
  const first = a.snaps.find(s => s.players.find(q => q.id === p.id))!;
  const p0 = first.players.find(q => q.id === p.id)!;
  return Math.hypot(p.x - p0.x, p.y - p0.y) > 40;
});
check(botsMoved, 'bots are moving around');
check(a.events.some(e => e.e === 'hit' || e.e === 'kill') || snap.players.every(p => p.hp === 100),
  'combat events flowing (or nobody met yet)');
a.ws.send(JSON.stringify({ t: 'removeBot', team: 'enemy' }));
await sleep(300);
snap = a.snaps[a.snaps.length - 1];
check(snap.players.length === 9, `removeBot works (got ${snap.players.length})`);
check(snap.mode === 'tdm' && Array.isArray(snap.scores), 'tdm snapshot has scores');

// weapon switch + reload messages don't crash, primary change works
a.ws.send(JSON.stringify({ t: 'primary', w: 'shotgun' }));
a.ws.send(JSON.stringify({ t: 'reload' }));
await sleep(300);
snap = a.snaps[a.snaps.length - 1];
check(snap.self!.slots[1] === 'shotgun', 'loadout change applied');
a.ws.close();
await sleep(300);

// --- Zombie ---
console.log('mode: zombie');
const z = client<ZombieSnapshot>({ t: 'join', name: 'Bob', mode: 'zombie' });
await sleep(400);
check(z.welcome && z.welcome.mode === 'zombie', 'zombie welcome');
z.ws.send(JSON.stringify({ t: 'addBot' }));
z.ws.send(JSON.stringify({ t: 'addBot' }));
await sleep(400);
let zsnap = z.snaps[z.snaps.length - 1];
check(zsnap.players.length === 3, `survivor bots added (got ${zsnap.players.length})`);
check(zsnap.mode === 'zombie' && zsnap.breakT >= 0, 'zombie snapshot has wave info');

// wait through break for wave 1 (10s break, poll up to 13s)
let waveStarted = false;
for (let i = 0; i < 26 && !waveStarted; i++) {
  await sleep(500);
  zsnap = z.snaps[z.snaps.length - 1];
  if (zsnap.wave >= 1 && zsnap.zombies.length > 0) waveStarted = true;
  // keep-alive inputs, aim at nearest zombie and fire
  const meZ = zsnap.players.find(p => p.id === z.welcome!.id);
  if (meZ && zsnap.zombies.length) {
    const zt = zsnap.zombies[0];
    const aim = Math.atan2(zt.y - meZ.y, zt.x - meZ.x);
    z.ws.send(JSON.stringify({ t: 'input', seq: ++seq, dt: 0.033, keys: {}, aim, fire: true }));
  }
}
check(waveStarted, `wave started, zombies present (wave=${zsnap.wave}, zombies=${zsnap.zombies.length})`);
check(z.events.some(e => e.e === 'wave'), 'wave event emitted');

// let bots fight zombies; poll up to 15s for any zombie damage while we
// keep firing at the nearest one (they walk in from the map edges)
let zombieDamaged = false;
for (let i = 0; i < 100 && !zombieDamaged; i++) {
  await sleep(150);
  zombieDamaged = z.events.some(e => (e.e === 'hit' && e.z === 1) || e.e === 'zdie');
  zsnap = z.snaps[z.snaps.length - 1];
  const meZ = zsnap.players.find(p => p.id === z.welcome!.id);
  if (meZ && zsnap.zombies.length) {
    let best = zsnap.zombies[0], bd = Infinity;
    for (const t of zsnap.zombies) {
      const d = Math.hypot(t.x - meZ.x, t.y - meZ.y);
      if (d < bd) { bd = d; best = t; }
    }
    const aim = Math.atan2(best.y - meZ.y, best.x - meZ.x);
    z.ws.send(JSON.stringify({ t: 'input', seq: ++seq, dt: 0.05, keys: {}, aim, fire: true }));
  }
}
check(zombieDamaged, 'zombies taking damage from survivors/bots');
z.ws.send(JSON.stringify({ t: 'buy', item: 'smg' }));
await sleep(300);
zsnap = z.snaps[z.snaps.length - 1];
check(zsnap.self!.slots.includes('smg') || zsnap.self!.points < 400, 'buy processed');
z.ws.close();
await sleep(300);

srv.kill();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
if (srvErr.trim()) console.error('server stderr:\n' + srvErr);
process.exit(failures === 0 ? 0 : 1);
