// Headless smoke test: map sanity + live server exercise of both modes.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { buildMap, T_FLOOR } from '../shared/maps.ts';
import { TILE, ZOMBIE_RADII } from '../shared/constants.ts';
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

  // ---- clearance for the widest body in the game ----
  //
  // CLAUDE.md flags this as an unchecked hazard: "the flood fill is tile-based
  // and won't catch it", about a brute (radius 22) in 48px doorways.
  //
  // Worth being precise about what can actually go wrong, because it is NOT the
  // fill. On a tile grid the nearest solid surface to a tile centre is an
  // axis-aligned face TILE/2 away, so ANY body with radius < TILE/2 fits at
  // every floor tile and sweeps between any two 4-adjacent ones — the geometry
  // makes it impossible to trap. A clearance fill therefore cannot fail while
  // that inequality holds, and a check that cannot fail is not a check.
  //
  // What can fail is the inequality. Brute sits 2px inside it, so a single bump
  // to 24 jams it in every doorway on both maps, which is exactly the mistake
  // CLAUDE.md warns about. So the fill below is reported for its numbers, and
  // the assertion that guards the hazard is the margin.
  const R = Math.max(...Object.values(ZOMBIE_RADII));
  for (const [kind, r] of Object.entries(ZOMBIE_RADII)) {
    check(r < TILE / 2,
      `${kind} radius ${r} clears a 1-tile doorway (< ${TILE / 2}, margin ${TILE / 2 - r}px)`);
  }
  const fitsAt = (tx: number, ty: number): boolean => {
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    // Sample the tiles the body's bounding box can touch. A tile grid means the
    // nearest solid surface is always an axis-aligned face or a corner, so
    // clamping the centre to each candidate tile's box is an exact distance.
    for (let gy = Math.floor((cy - R) / TILE); gy <= Math.floor((cy + R) / TILE); gy++) {
      for (let gx = Math.floor((cx - R) / TILE); gx <= Math.floor((cx + R) / TILE); gx++) {
        if (!g.solid(gx, gy)) continue;
        const nx = Math.max(gx * TILE, Math.min((gx + 1) * TILE, cx));
        const ny = Math.max(gy * TILE, Math.min((gy + 1) * TILE, cy));
        if ((cx - nx) ** 2 + (cy - ny) ** 2 < R * R) return false;
      }
    }
    return true;
  };
  const wide = floors.filter(([x, y]) => fitsAt(x, y));
  check(wide.length === floors.length,
    `a radius-${R} body fits on every floor tile (${wide.length}/${floors.length})`);

  // Every tile a brute can stand on must be reachable from every other, or a
  // wave can spawn one where it can never reach the squad.
  const wideSet = new Set(wide.map(([x, y]) => x + ',' + y));
  const wseen = new Set<string>();
  const wstack: [number, number][] = [wide[0]];
  while (wstack.length) {
    const [x, y] = wstack.pop()!;
    const k = x + ',' + y;
    if (wseen.has(k) || !wideSet.has(k)) continue;
    wseen.add(k);
    wstack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  check(wseen.size === wide.length,
    `every tile a radius-${R} body fits on is reachable by one (${wseen.size}/${wide.length})`);

  // And it has to be able to leave its spawn and reach the objective, which is
  // the specific failure a doorway one pixel too narrow produces.
  for (const s of name === 'outbreak' ? g.zombieSpawns : g.redSpawns) {
    const k = Math.floor(s.x / TILE) + ',' + Math.floor(s.y / TILE);
    check(wseen.has(k), `radius-${R} body can path out of spawn ${s.x},${s.y}`);
  }
}

// ---- 2. live server ----
const PORT = 3199;
const srv = spawn(process.execPath, ['server/index.ts'], {
  // In-memory profiles: this suite drives real joins, which claim names and
  // write stats. Pointed at a file it would litter (and eventually collide with)
  // a real player's record.
  env: { ...process.env, PORT: String(PORT), WZ3_DB: ':memory:' },
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
  /** Why the join was refused ('namebad'/'full'), if it was. */
  rejected: string | null;
}

function client<S extends Snapshot>(joinMsg: object): TestClient<S> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c: TestClient<S> = { ws, welcome: null, snaps: [], events: [], rejected: null };
  ws.on('open', () => ws.send(JSON.stringify(joinMsg)));
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'snap') { c.snaps.push(m); for (const e of m.events) c.events.push(e); }
    if (m.t === 'namebad' || m.t === 'full') c.rejected = m.t + (m.why ? ':' + m.why : '');
  });
  return c;
}

// The profile API. Read-only by design, so a GET is the whole surface.
async function apiGet(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://localhost:${PORT}${path}`);
  let body: any = null;
  try { body = await r.json(); } catch { /* non-json error page */ }
  return { status: r.status, body };
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// --- TDM ---
console.log('mode: tdm');
// bots:5 = a per-team target, honored because this join creates the room
const a = client<TdmSnapshot>({ t: 'join', name: 'Alice', mode: 'tdm', primary: 'rifle', bots: 5 });
await sleep(500);
check(a.welcome && a.welcome.mode === 'tdm', 'welcome received with map');
check(a.welcome!.map.tiles.length === a.welcome!.map.w * a.welcome!.map.h, 'map serialized');

// The first join mints a profile and claims the callsign.
const alicePid = a.welcome!.pid!;
check(/^[0-9a-f]{32}$/.test(alicePid || ''), `welcome carries a profile token (${alicePid})`);
check(a.welcome!.name === 'Alice', 'and the callsign the profile owns');
{
  const got = await apiGet(`/api/profile?id=${alicePid}`);
  check(got.status === 200 && got.body.name === 'Alice', 'GET /api/profile serves it');
  check(got.body.bestWave === 0 && got.body.tdmKills === 0, 'a fresh profile reads as empty');
  const miss = await apiGet('/api/profile?id=' + 'f'.repeat(32));
  check(miss.status === 404, 'an unknown token 404s — what makes a bad recovery code visible');
  check((await apiGet('/api/name?n=Alice')).body.free === false, 'the claimed name is not free');
  check((await apiGet('/api/name?n=alice')).body.free === false, 'and neither is its case-fold');
  check((await apiGet('/api/name?n=Nomad')).body.free === true, 'an unclaimed name is free');
  const res = await apiGet('/api/name?n=' + encodeURIComponent('BOT Viper'));
  check(res.body.free === false && res.body.why === 'reserved', 'the BOT prefix is refused');
  const sug = await apiGet('/api/name');
  check(typeof sug.body.suggestion === 'string' && sug.body.suggestion.length > 0,
    `a blank query returns a suggestion (${sug.body.suggestion})`);
}

// Claiming a taken callsign is refused at the socket, and never consumes a seat.
const dup = client<TdmSnapshot>({ t: 'join', name: 'ALICE', mode: 'tdm' });
await sleep(400);
check(dup.rejected === 'namebad:taken' && !dup.welcome, `a duplicate callsign is refused (${dup.rejected})`);
dup.ws.close();

let snap = a.snaps[a.snaps.length - 1];
check(snap.players.length === 10, `join filled both teams to 5v5 (got ${snap.players.length})`);
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
check(snap.mode === 'tdm' && Array.isArray(snap.scores), 'tdm snapshot has scores');

// a second human takes a bot's seat rather than an eleventh slot, and leaving
// gives it back — the roster target outlives the humans who displaced it
const b = client<TdmSnapshot>({ t: 'join', name: 'Bea', mode: 'tdm', primary: 'rifle', bots: 0 });
await sleep(500);
snap = a.snaps[a.snaps.length - 1];
const humans = snap.players.filter(p => !p.bot).length;
check(snap.players.length === 10 && humans === 2,
  `second human evicts a bot, roster stays 10 (got ${snap.players.length}, ${humans} human)`);
b.ws.close();
await sleep(500);
snap = a.snaps[a.snaps.length - 1];
check(snap.players.length === 10, `roster refilled after the human left (got ${snap.players.length})`);

// weapon switch + reload messages don't crash, primary change works
a.ws.send(JSON.stringify({ t: 'primary', w: 'shotgun' }));
a.ws.send(JSON.stringify({ t: 'reload' }));
await sleep(300);
snap = a.snaps[a.snaps.length - 1];
check(snap.self!.slots[1] === 'shotgun', 'loadout change applied');
a.ws.close();
await sleep(300);

// A returning player is their token, not their typed name: the wire cannot
// rename them, and the room shows the name the profile owns.
const back = client<TdmSnapshot>({ t: 'join', name: 'Impostor', mode: 'tdm', pid: alicePid });
await sleep(500);
check(back.welcome!.name === 'Alice', `a token overrides the name on the wire (${back.welcome!.name})`);
check(back.welcome!.pid === alicePid, 'and mints nothing new');
check(back.snaps[back.snaps.length - 1].players.some(p => p.name === 'Alice'),
  'so the scoreboard shows the owned callsign');
back.ws.close();
await sleep(300);

// --- Zombie ---
console.log('mode: zombie');
// bots:3 = a total squad size in zombie mode, i.e. two squadmates
const z = client<ZombieSnapshot>({ t: 'join', name: 'Bob', mode: 'zombie', bots: 3 });
await sleep(500);
check(z.welcome && z.welcome.mode === 'zombie', 'zombie welcome');
let zsnap = z.snaps[z.snaps.length - 1];
check(zsnap.players.length === 3, `join filled the squad to 3 (got ${zsnap.players.length})`);
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
// crates are placed at wave start and ride the zombie snapshot
check(zsnap.pk.length === 2 && zsnap.pk.every(c => c.kind === 'ammo' || c.kind === 'health'),
  `supply crates reach the client (${zsnap.pk.map(c => c.kind).join(', ') || 'none'})`);

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

// Keep firing until *this* player lands a kill of their own, so the persistence
// check below has a real number to compare instead of 0 = 0. Bounded: bots may
// take every killing blow, and the flush assertion holds either way.
//
// The fire flag has to *alternate*: the pistol is semi-auto and the server edge-
// detects on firePrev, so a held flag is exactly one round for the whole match
// (the same reason server/bot.ts has fireTick and touch.ts has tickFireCadence).
// Reloads go in periodically too — 12 rounds do not kill a wave.
for (let i = 0; i < 90; i++) {
  zsnap = z.snaps[z.snaps.length - 1];
  const meZ = zsnap.players.find(p => p.id === z.welcome!.id);
  if (meZ && meZ.k > 0) break;
  await sleep(150);
  if (meZ && zsnap.zombies.length) {
    let best = zsnap.zombies[0], bd = Infinity;
    for (const t of zsnap.zombies) {
      const d = Math.hypot(t.x - meZ.x, t.y - meZ.y);
      if (d < bd) { bd = d; best = t; }
    }
    const aim = Math.atan2(best.y - meZ.y, best.x - meZ.x);
    z.ws.send(JSON.stringify({ t: 'input', seq: ++seq, dt: 0.05, keys: {}, aim, fire: i % 2 === 0 }));
    if (i % 12 === 11) z.ws.send(JSON.stringify({ t: 'reload' }));
  }
}
z.ws.send(JSON.stringify({ t: 'buy', item: 'smg' }));
await sleep(300);
zsnap = z.snaps[z.snaps.length - 1];
check(zsnap.self!.slots.includes('smg') || zsnap.self!.points < 400, 'buy processed');
const bobPid = z.welcome!.pid!;
// What the match itself last reported for him. Kills cannot move after this: he
// sends no further inputs, and a kill needs a shot.
zsnap = z.snaps[z.snaps.length - 1];
const bobEnd = zsnap.players.find(p => p.id === z.welcome!.id)!;
z.ws.close();
await sleep(400);

// Waves are recorded as they start; kills are banked when the socket closes.
console.log('profiles');
{
  const got = await apiGet(`/api/profile?id=${bobPid}`);
  check(got.status === 200 && got.body.name === 'Bob', 'the outbreak player has a profile');
  check(got.body.bestWave >= 1, `reaching wave 1 was recorded (best ${got.body.bestWave})`);
  check(got.body.resumeWave === 0, 'wave 1 is below the first checkpoint, so nothing to resume');
  // The end-to-end flush: what the room counted is what the profile holds. Not
  // "some kills happened" — bots may take every killing blow, and a test that
  // depends on the pistol landing one is a test that fails on Tuesdays.
  check(got.body.zKills === bobEnd.k,
    `disconnect banked the match's kills (${got.body.zKills} = ${bobEnd.k})`);
  check(got.body.zDeaths >= bobEnd.d,
    `and its deaths (${got.body.zDeaths} >= ${bobEnd.d})`);
  const board = await apiGet('/api/leaderboard');
  check(board.status === 200 && Array.isArray(board.body.tdm) && Array.isArray(board.body.zombie),
    'the leaderboard serves both modes');
  check(!board.body.zombie.some((r: { name: string }) => r.name === 'Nomad'),
    'and lists nobody who never played');
}

srv.kill();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
if (srvErr.trim()) console.error('server stderr:\n' + srvErr);
process.exit(failures === 0 ? 0 : 1);
