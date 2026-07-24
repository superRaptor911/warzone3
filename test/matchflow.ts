// Direct room-level tests for match lifecycle transitions not covered by smoke.ts.
import { TDMRoom } from '../server/tdm.ts';
import { ZombieRoom, checkpointPoints } from '../server/zombie.ts';
import { TEAM, TDM_SCORE_LIMIT, STAMINA_MAX, STAMINA_MIN_TO_SPRINT } from '../shared/constants.ts';
import { tickSprint } from '../shared/physics.ts';

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
