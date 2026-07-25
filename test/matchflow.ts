// Direct room-level tests for match lifecycle transitions not covered by smoke.ts.
import { TDMRoom } from '../server/tdm.ts';
import { ZombieRoom, checkpointPoints } from '../server/zombie.ts';
import { TEAM, TDM_SCORE_LIMIT, STAMINA_MAX, STAMINA_MIN_TO_SPRINT, TILE, PLAYER_RADIUS } from '../shared/constants.ts';
import { tickSprint } from '../shared/physics.ts';
import { castPellet } from '../shared/hitscan.ts';
import { VIEW_TARGET_W, ZOOM_MIN, bloomFor, resolutionFor, zoomFor } from '../client/js/view.ts';

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
