// Direct room-level tests for match lifecycle transitions not covered by smoke.ts.
import { TDMRoom } from '../server/tdm.ts';
import { ZombieRoom, checkpointPoints } from '../server/zombie.ts';
import { TEAM, TDM_SCORE_LIMIT, STAMINA_MAX, STAMINA_MIN_TO_SPRINT, TILE, PLAYER_RADIUS } from '../shared/constants.ts';
import { tickSprint } from '../shared/physics.ts';
import { castPellet } from '../shared/hitscan.ts';
import { VIEW_TARGET_W, ZOOM_MIN, bloomFor, resolutionFor, zoomFor } from '../client/js/view.ts';
import { DEAD_ZONE, STICK_R, deflection, newFireCadence, stickKeys, tickFireCadence } from '../client/js/stick.ts';
import { WEAPONS, fireIntervalMs } from '../shared/weapons.ts';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}

// ---- TDM: score-limit end + restart ----
console.log('tdm match flow');
{
  const room = new TDMRoom('t1');
  const red = room.addPlayer({ name: 'R', bot: true, team: TEAM.RED })!;
  const blue = room.addPlayer({ name: 'B', bot: true, team: TEAM.BLUE })!;
  room.scores[TEAM.RED] = TDM_SCORE_LIMIT - 1;
  blue.protectT = 0;
  room.damagePlayer(blue, 1000, red, 'rifle', blue.x, blue.y);
  check(room.scores[TEAM.RED] === TDM_SCORE_LIMIT, 'kill increments team score');
  check(room.state === 'over', 'match ends at score limit');
  check(!blue.alive && blue.deaths === 1 && red.kills === 1, 'k/d recorded');
  room.modeUpdate(999); // burn the restart timer
  check(room.state === 'live', 'match restarts');
  check(room.scores[0] === 0 && room.scores[1] === 0, 'scores reset');
  check(red.kills === 0 && blue.alive, 'players reset + respawned');
  const evict = room.addPlayer({ name: 'H1', bot: false, team: TEAM.RED });
  for (let i = 0; i < 4; i++) room.addPlayer({ name: 'b' + i, bot: true, team: TEAM.RED });
  check(room.teamCount(TEAM.RED) === 5, 'red team full');
  const human = room.addPlayer({ name: 'H2', bot: false, team: TEAM.RED });
  check(human !== null && room.teamCount(TEAM.RED) === 5, 'human joining full team evicts a bot');
  room.destroy();
}

// ---- Zombie: wipe -> game over -> reset; bot buying ----
console.log('zombie match flow');
{
  const room = new ZombieRoom('z1');
  const p1 = room.addPlayer({ name: 'S1', bot: true })!;
  const p2 = room.addPlayer({ name: 'S2', bot: true })!;
  room.startWave(3);
  check(room.state === 'wave' && room.toSpawn.length > 0, 'wave 3 composed');
  const hasRunners = room.toSpawn.includes('runner');
  check(hasRunners, 'later waves include runners');
  p1.protectT = 0; p2.protectT = 0;
  room.damagePlayer(p1, 1000, null, 'claws', p1.x, p1.y);
  check(room.state === 'wave', 'one down does not end the game');
  room.damagePlayer(p2, 1000, null, 'claws', p2.x, p2.y);
  check(room.state === 'over', 'full squad wipe triggers game over');
  room.modeUpdate(999);
  check(room.state === 'break' && room.wave === 0, 'game resets to fresh run');
  check(p1.alive && p1.points === 400 && p1.slots.length === 1, 'players reset to pistol + start cash');

  // bot buying
  p1.points = 5000;
  room.botBuy(p1);
  check(p1.slots.includes('smg'), 'bot buys smg first');
  room.botBuy(p1);
  check(p1.slots.includes('rifle'), 'bot upgrades to rifle');
  room.botBuy(p1);
  check(p1.slots.includes('sniper'), 'bot upgrades to sniper');

  // human shop edge cases
  p2.points = 0;
  room.buy(p2, 'rifle');
  check(!p2.slots.includes('rifle'), 'cannot buy without points');
  p2.points = 10000;
  room.buy(p2, 'rifle');
  room.buy(p2, 'rifle');
  check(p2.points === 10000 - 800, 'no double-purchase of owned weapon');
  room.destroy();
}

// ---- Zombie: checkpoints (resume at wave 5/10/15…) ----
console.log('zombie checkpoints');
{
  const room = new ZombieRoom('z3');
  const h = room.addPlayer({ name: 'H', bot: false })!;
  room.applyCheckpoint('junk');
  room.applyCheckpoint(-25);
  room.applyCheckpoint(3);
  check(room.checkpoint === 0 && room.wave === 0, 'garbage/low checkpoints rejected');
  room.applyCheckpoint(12);
  check(room.checkpoint === 10 && room.wave === 9, 'join checkpoint floors to a multiple of 5 and arms the wave');
  check(h.points === checkpointPoints(10), 'checkpoint start cash scales with the wave');
  room.modeUpdate(999); // burn the break
  check(room.state === 'wave' && room.wave === 10, 'run resumes at the checkpoint wave');
  const late = room.addPlayer({ name: 'L', bot: true })!;
  check(late.points === checkpointPoints(10), 'mid-run joiner gets wave-appropriate cash');
  room.startWave(15);
  check(room.checkpoint === 15, 'reaching wave 15 records the next checkpoint');
  h.protectT = 0; late.protectT = 0;
  room.damagePlayer(h, 1000, null, 'claws', h.x, h.y);
  room.damagePlayer(late, 1000, null, 'claws', late.x, late.y);
  check(room.state === 'over', 'squad wiped at wave 15');
  room.modeUpdate(999);
  check(room.state === 'break' && room.wave === 14, 'wipe restarts from the checkpoint, not wave 0');
  check(h.points === checkpointPoints(15) && h.slots.length === 1, 'restart grants checkpoint cash + pistol');
  check(room.modeSnapshot().cp === 15, 'snapshot carries the checkpoint');
  room.applyCheckpoint(50);
  check(room.checkpoint === 15, 'checkpoint cannot be re-armed mid-run');
  room.destroy();

  // a second human joining a still-fresh room must not hijack it either
  const r2 = new ZombieRoom('z4');
  r2.addPlayer({ name: 'A', bot: false });
  r2.addPlayer({ name: 'B', bot: false });
  r2.applyCheckpoint(50);
  check(r2.checkpoint === 0, 'second human cannot arm a checkpoint on a fresh room');
  r2.destroy();
}

// ---- sprint stamina ----
console.log('sprint stamina');
{
  const e = { stamina: STAMINA_MAX, sprinting: false };
  let t = 0;
  while (tickSprint(e, true, 0.05)) t += 0.05;
  check(t > 3 && t < 5, `sprint exhausts after ~4s (${t.toFixed(2)}s)`);
  check(e.stamina <= 1, 'stamina drained to zero');
  tickSprint(e, false, 0.3); // partial regen, below hysteresis threshold
  check(e.stamina < STAMINA_MIN_TO_SPRINT && !tickSprint(e, true, 0.05),
    'cannot restart sprint below recovery threshold');
  for (let i = 0; i < 300; i++) tickSprint(e, false, 0.05);
  check(e.stamina === STAMINA_MAX, 'stamina fully regenerates');
  check(tickSprint(e, true, 0.05), 'sprint available again when recovered');
}

// ---- zombie frenzy (anti-kiting) ----
console.log('zombie frenzy');
{
  const room = new ZombieRoom('z2');
  room.addPlayer({ name: 'S', bot: true });
  room.startWave(1);
  check(!room.frenzyActive() || room.toSpawn.length <= 3, 'no frenzy with a full wave queued');
  room.toSpawn = [];
  room.spawnZombie('walker');
  room.spawnZombie('runner');
  check(room.frenzyActive(), 'frenzy activates with <=3 zombies remaining');
  for (let i = 0; i < 200; i++) room.updateZombies(0.05); // ~10s
  const zs = [...room.zombies.values()];
  check(zs.every(z => z.frenzy > 0.95), 'frenzy fully ramped');
  const walker = zs.find(z => z.type === 'walker')!;
  const runner = zs.find(z => z.type === 'runner')!;
  check(walker.effSpeed >= 195, `frenzied walker outpaces walking players (${Math.round(walker.effSpeed)} px/s)`);
  check(runner.effSpeed >= 215, `frenzied runner is faster still (${Math.round(runner.effSpeed)} px/s)`);
  check(room.events.some(e => e.e === 'frenzy'), 'frenzy event announced once');
  check(room.zombieSnapshot().every(z => z.fr === 1), 'snapshot carries frenzy flag');
  // long waves also trigger it even with many zombies left
  room.startWave(2);
  room.waveAge = 80;
  check(room.frenzyActive(), 'dragging a wave past 75s also triggers frenzy');
  room.destroy();
}

// ---- shared hitscan: pellets stop on bodies, not only walls ----
console.log('hitscan');
{
  const room = new TDMRoom('h1');
  const grid = room.grid;
  // find an open spot with clear space to the +x
  let ox = 0, oy = 0;
  outer: for (let ty = 1; ty < grid.h - 1; ty++) {
    for (let tx = 1; tx < grid.w - 10; tx++) {
      const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
      if (grid.raycast(x, y, 1, 0, 400) >= 400) { ox = x; oy = y; break outer; }
    }
  }
  check(ox > 0, 'found an open lane to shoot down');
  const clear = castPellet(grid, ox, oy, 1, 0, 400, []);
  check(clear.dist >= 400 && clear.hit === null, 'unobstructed pellet flies its full range');
  const body = { x: ox + 200, y: oy, radius: PLAYER_RADIUS };
  const hit = castPellet(grid, ox, oy, 1, 0, 400, [body]);
  check(hit.hit === body, 'pellet stops on a body in the lane');
  check(Math.abs(hit.dist - (200 - PLAYER_RADIUS)) < 0.01,
    `stops at the body's near edge (${hit.dist.toFixed(1)}px)`);
  const grazePast = castPellet(grid, ox, oy, 1, 0, 400,
    [{ x: ox + 200, y: oy + PLAYER_RADIUS + 2, radius: PLAYER_RADIUS }]);
  check(grazePast.hit === null && grazePast.dist >= 400, 'a body beside the lane does not block');
  const behind = castPellet(grid, ox, oy, 1, 0, 400, [{ x: ox - 100, y: oy, radius: PLAYER_RADIUS }]);
  check(behind.hit === null, 'a body behind the shooter does not block');
  const nearest = castPellet(grid, ox, oy, 1, 0, 400, [
    { x: ox + 300, y: oy, radius: PLAYER_RADIUS },
    body,
  ]);
  check(nearest.hit === body, 'nearest body wins');
  room.destroy();
}

// ---- viewport: zoom + quality tier ----
console.log('\nviewport math');
{
  check(zoomFor(1920, 1080) === 1, 'desktop 1920x1080 renders at zoom 1 (unchanged)');
  check(zoomFor(1366, 768) === 1, 'small laptop still zoom 1');
  check(zoomFor(VIEW_TARGET_W, 9999) === 1, 'exactly the target width is the zoom-1 boundary');
  check(zoomFor(3440, 1440) === 1, 'never zooms IN on an ultrawide');
  const phone = zoomFor(844, 390);
  check(phone > 0.6 && phone < 0.66, `landscape phone zooms out (${phone.toFixed(3)})`);
  check(Math.abs(zoomFor(844, 390) - 390 / 620) < 1e-9, 'height drives the phone zoom, not width');
  check(zoomFor(390, 844) === ZOOM_MIN, 'portrait clamps at the zoom floor');
  check(zoomFor(0, 0) === 1, 'zero-size viewport during layout falls back to 1');
  // world visible at a given zoom — the number that decides what a player sees
  check(Math.round(844 / phone) === 1342, `phone sees 1342 world px across (${Math.round(1342 / TILE)} tiles)`);

  check(resolutionFor('fast', 3) === 1, 'fast tier ignores DPR');
  check(resolutionFor('sharp', 3) === 2, 'sharp tier caps DPR at 2');
  check(resolutionFor('sharp', 1) === 1, 'sharp tier on a DPR-1 desktop is unchanged');
  check(resolutionFor('sharp', 0) === 1, 'a bogus DPR floors at 1');
  check(bloomFor('sharp') && !bloomFor('fast'), 'bloom follows the tier');
}

// ---- touch: stick quantisation ----
console.log('\ntouch stick');
{
  const R = STICK_R;
  const keys = (dx: number, dy: number) => JSON.stringify(stickKeys(dx, dy));
  // screen +y is down, so -y is 'w'
  check(keys(0, -R) === JSON.stringify({ w: 1 }), 'straight up is W alone');
  check(keys(0, R) === JSON.stringify({ s: 1 }), 'straight down is S alone');
  check(keys(-R, 0) === JSON.stringify({ a: 1 }), 'left is A alone');
  check(keys(R, 0) === JSON.stringify({ d: 1 }), 'right is D alone');
  check(keys(R * 0.7, -R * 0.7) === JSON.stringify({ d: 1, w: 1 }), 'up-right is the W+D diagonal');
  check(keys(-R * 0.7, R * 0.7) === JSON.stringify({ s: 1, a: 1 }), 'down-left is the S+A diagonal');

  check(keys(0, 0) === '{}', 'centred stick emits nothing');
  check(keys(R * 0.2, 0) === '{}', 'inside the deadzone emits nothing');
  check(keys(R * 0.26, 0) !== '{}', 'just outside the deadzone registers');
  check(Math.abs(deflection(R * 0.5, 0) - 0.5) < 1e-9, 'deflection is a 0..1 fraction of the radius');
  check(deflection(R * 4, 0) === 1, 'deflection clamps at 1 beyond the stick edge');

  // Sector boundaries sit at 22.5 degrees. Sweeping the full circle must give
  // exactly 8 distinct key sets, each held for exactly 45 degrees.
  const seen = new Map<string, number>();
  for (let i = 0; i < 3600; i++) {
    const a = (i / 3600) * Math.PI * 2;
    const s = keys(Math.cos(a) * R, Math.sin(a) * R);
    seen.set(s, (seen.get(s) || 0) + 1);
  }
  check(seen.size === 8, `a full sweep yields exactly 8 directions (got ${seen.size})`);
  // 3600 samples / 8 sectors = 450 each; +-2 is float noise at the boundaries
  const spread = [...seen.values()];
  check(Math.max(...spread) - Math.min(...spread) <= 2,
    `every sector is 45 degrees wide within 0.2 degrees (${Math.min(...spread)}..${Math.max(...spread)} of 450)`);
  check(!seen.has('{}'), 'a fully deflected stick never reads as centred');
}

// ---- touch: synthesised fire edges for semi-autos ----
console.log('\ntouch fire cadence');
{
  const dt = 1 / 60;
  const run = (weapon: 'pistol' | 'rifle' | 'sniper', seconds: number, held = true) => {
    const w = WEAPONS[weapon];
    const st = newFireCadence();
    let edges = 0, prev = false;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      const f = tickFireCadence(st, held, w.auto, fireIntervalMs(w) / 1000, dt);
      if (f && !prev) edges++; // exactly what the server's firePrev sees
      prev = f;
    }
    return edges;
  };

  // held for 1s: a raw held flag would give the server ONE edge for a semi-auto
  const pistol = run('pistol', 1);
  check(pistol >= 5 && pistol <= 6, `pistol (340rpm semi) yields ~5.7 edges/s, got ${pistol}`);
  // 42rpm = one shot per 1.43s, so 10s of holding is 7 shots — the stick cannot
  // make a bolt-action any faster than the weapon allows
  const sniper = run('sniper', 10);
  check(sniper === 7, `sniper (42rpm semi) yields 7 edges in 10s, got ${sniper}`);
  check(run('pistol', 1, false) === 0, 'no edges while the stick is centred');

  // rate must stay bounded by rpm — this is parity with clicking, not a buff
  check(pistol <= Math.ceil(WEAPONS.pistol.rpm / 60), 'cadence never exceeds the weapon rpm');

  // auto weapons bypass the cadence entirely: one continuous hold
  const st = newFireCadence();
  let lows = 0;
  for (let i = 0; i < 60; i++) {
    if (!tickFireCadence(st, true, WEAPONS.rifle.auto, fireIntervalMs(WEAPONS.rifle) / 1000, dt)) lows++;
  }
  check(lows === 0, 'an auto weapon holds fire high the whole time');

  // releasing must reset, so the next press fires immediately rather than
  // waiting out a stale interval
  const st2 = newFireCadence();
  tickFireCadence(st2, true, false, 1, dt);   // shot
  tickFireCadence(st2, false, false, 1, dt);  // release
  check(tickFireCadence(st2, true, false, 1, dt), 'a fresh press fires immediately after release');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
