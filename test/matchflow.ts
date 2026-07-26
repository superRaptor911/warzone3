// Direct room-level tests for match lifecycle transitions not covered by smoke.ts.
//
// Persistence is pointed at an in-memory database before anything can open one:
// `server/db.ts` opens lazily on first use, so this assignment (module body,
// ahead of every test block) is what guarantees a test run cannot touch a real
// player's record — including when this file is run directly.
process.env.WZ3_DB = ':memory:';

import { TDMRoom } from '../server/tdm.ts';
import { ZombieRoom, checkpointPoints } from '../server/zombie.ts';
import {
  TEAM, TDM_SCORE_LIMIT, STAMINA_MAX, STAMINA_MIN_TO_SPRINT, TILE, PLAYER_RADIUS,
  TICK_RATE, PLAYER_SPEED, PLAYER_HP, PICKUPS_PER_WAVE, MAX_PICKUPS, PICKUP_SPAWN_CLEAR,
} from '../shared/constants.ts';
import {
  Grid, MAT, OVER, OVER_HEIGHT, T_CRATE, T_FLOOR, T_WALL, buildMap, matId,
} from '../shared/maps.ts';
import {
  DECOR_ART, E, N, OVER_ART, S, W, floorKey, floorVariant, floorVariants, isFloorMat,
  isOverId, isPropMat, isWallMat, overVariant, overVariants,
} from '../client/js/gfx/tileset.ts';
import { createPickup } from '../server/entities.ts';
import {
  addStats, claimProfile, closeDb, leaderboard, nameError, nameKey, nameTaken,
  profileById, recordWave, suggestName,
} from '../server/db.ts';
import { tickSprint } from '../shared/physics.ts';
import { castPellet } from '../shared/hitscan.ts';
import { VIEW_TARGET_W, ZOOM_MIN, bloomFor, resolutionFor, zoomFor } from '../client/js/view.ts';
import {
  AIM_TAU_FAR, AIM_TAU_NEAR, DEAD_ZONE, STICK_R, deflection, newAimSmooth,
  newFireCadence, newLead, releaseAim, stickKeys, tickAimSmooth, tickFireCadence, tickLead,
} from '../client/js/stick.ts';
import {
  ASSIST_CONE, ASSIST_MAX_PULL, newAssist, onTarget, releaseAssist, tickAimAssist,
} from '../client/js/assist.ts';
import { WEAPONS, fireIntervalMs } from '../shared/weapons.ts';
import { CONFIRM_GRACE, cancelReload, newReloadMirror, startReload, tickReload } from '../client/js/reload.ts';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}

/** Degrees wrapped to (-180, 180], so a pull across the seam reads as a delta. */
function wrapDeg(d: number): number {
  return d - 360 * Math.floor((d + 180) / 360);
}

// Centre of a run of clear floor tiles, so tests can place entities without a
// wall silently changing what is being measured.
function openLane(g: Grid, tiles: number): { x: number; y: number } | null {
  for (let ty = 1; ty < g.h - 1; ty++) {
    for (let tx = 1; tx < g.w - tiles - 1; tx++) {
      let clear = true;
      for (let i = 0; i < tiles; i++) if (g.get(tx + i, ty) !== T_FLOOR) { clear = false; break; }
      if (clear) return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    }
  }
  return null;
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

// ---- input carry-over: a stalled burst is simulated, not discarded ----
// A laggy client's inputs arrive in one flush. The tick may only simulate
// 1.6x its own duration, so the remainder has to bank for the next tick
// instead of being acked-but-dropped (which showed up as a rubber-band snap).
console.log('input carry-over');
{
  const room = new TDMRoom('c1');
  const p = room.addPlayer({ name: 'P', bot: false, team: TEAM.RED })!;
  // Park the player where there is clear floor to the right, so the run is
  // bounded by the input budget rather than by a wall.
  const spot = openLane(room.grid, 9);
  check(spot !== null, 'found an open lane to run down');
  p.x = spot!.x; p.y = spot!.y; p.protectT = 0;
  const x0 = p.x;

  const tickDt = 1 / TICK_RATE;
  const BURST = 12; // 12 x 33.3ms = 400ms of input in one flush
  for (let i = 0; i < BURST; i++) {
    room.queueInput(p, { t: 'input', seq: i + 1, dt: tickDt, keys: { d: 1 }, aim: 0 });
  }
  for (let i = 0; i < 20; i++) room.update();

  const travelled = p.x - x0;
  const full = BURST * tickDt * PLAYER_SPEED;
  check(travelled > full * 0.8,
    `stalled burst is simulated, not discarded (${travelled.toFixed(1)}px of ${full.toFixed(1)}px)`);
  check(p.lastSeq === BURST, `every queued input acked (lastSeq=${p.lastSeq})`);
  room.destroy();
}

// ---- hit rewind: shots resolve against the world the shooter was rendering ----
console.log('hit rewind');
{
  const room = new TDMRoom('r1');
  const shooter = room.addPlayer({ name: 'S', bot: false, team: TEAM.RED })!;
  const target = room.addPlayer({ name: 'T', bot: false, team: TEAM.BLUE })!;
  shooter.protectT = 0; target.protectT = 0; shooter.moving = false; shooter.spread = 0;

  const lane = openLane(room.grid, 9)!;
  shooter.x = lane.x; shooter.y = lane.y; shooter.aim = 0; // firing along +x

  // Broadcast a history of the target sliding off the firing line, 66ms apart
  // (the real 15Hz cadence). room.now is driven by hand so the frames get
  // distinct, deterministic timestamps. The span has to exceed MAX_REWIND_MS,
  // or every clamped claim would land on the oldest frame and the cap would be
  // indistinguishable from "older than the buffer".
  const T0 = 1_000_000;
  const OFFSETS = [0, 6, 12, 18, 24, 30, 36, 42, 48]; // px perpendicular to the shot
  const SEEN = T0 + 2 * 66; // the frame the shooter was looking at (offset 12)
  for (let i = 0; i < OFFSETS.length; i++) {
    room.now = T0 + i * 66;
    target.x = lane.x + 150;
    target.y = lane.y + OFFSETS[i];
    room.broadcast();
  }
  room.now = T0 + (OFFSETS.length - 1) * 66; // 528ms after the first frame

  const hitsWith = (rt: number): boolean => {
    shooter.lastRt = rt;
    const targets = room.hitscanTargets(shooter);
    room.rewindTargets(targets, room.rewindFrameFor(shooter));
    return castPellet(room.grid, shooter.x, shooter.y, 1, 0, 2000, targets).hit !== null;
  };

  check(target.y - lane.y > PLAYER_RADIUS * 2, 'target has moved clear of the firing line');
  check(!hitsWith(0), 'no rewind: the shot misses where the target no longer is');
  check(hitsWith(SEEN), 'rewind: the shot hits where the shooter saw the target');

  // An absurd claim lands at the cap rather than reaching further back.
  // now - 400ms = T0+128, which is 62/66 of the way from offset 6 to offset 12.
  shooter.lastRt = T0 - 5_000;
  const cappedY = room.rewindFrameFor(shooter)!.get(target.id)!.y - lane.y;
  check(Math.abs(cappedY - (6 + 6 * (62 / 66))) < 1,
    `rewind claim clamps to the 400ms cap (y+${cappedY.toFixed(2)})`);

  // Rewinding must move positions only — a dead target stays unhittable.
  target.alive = false;
  check(!hitsWith(SEEN), 'rewind does not resurrect a dead target');
  target.alive = true;

  // End to end through fireShot, which is where the rewind is actually wired in.
  target.hp = PLAYER_HP; shooter.spread = 0; shooter.lastRt = SEEN;
  room.fireShot(shooter, WEAPONS.pistol);
  check(target.hp < PLAYER_HP, `fireShot applies the rewind (target hp ${target.hp})`);

  // A bot reports no render time and must resolve at the present.
  target.hp = PLAYER_HP; shooter.spread = 0; shooter.lastRt = 0;
  room.fireShot(shooter, WEAPONS.pistol);
  check(target.hp === PLAYER_HP, 'no render time reported means no compensation');
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

// ---- Zombie: supply crates ----
// Full-strength (a shop ammo refill / a full heal) and rare rather than
// plentiful, so what has to hold is the scarcity: where they land, that they
// accumulate rather than pile up without limit, and who may take one.
console.log('zombie supply crates');
{
  const room = new ZombieRoom('z4');
  const h = room.addPlayer({ name: 'H', bot: false })!;
  const bot = room.addPlayer({ name: 'B', bot: true })!;

  check(room.pickups.size === 0, 'a fresh room has no crates on the floor');
  room.startWave(1);
  check(room.pickups.size === PICKUPS_PER_WAVE, `wave 1 places ${PICKUPS_PER_WAVE} crates`);

  // placement: on floor, and far enough out that the compound cannot farm them
  let onFloor = true, clear = true;
  for (const c of room.pickups.values()) {
    if (room.grid.solidAtPx(c.x, c.y)) onFloor = false;
    for (const sp of room.grid.survivorSpawns) {
      if (Math.hypot(c.x - sp.x, c.y - sp.y) < PICKUP_SPAWN_CLEAR) clear = false;
    }
  }
  check(onFloor, 'every crate lands on open floor');
  check(clear, `and none within ${PICKUP_SPAWN_CLEAR}px of a survivor spawn`);

  // uncollected crates persist across waves, up to the cap
  room.startWave(2);
  check(room.pickups.size === MAX_PICKUPS, `uncollected crates accumulate to the cap (${room.pickups.size})`);
  room.startWave(3);
  check(room.pickups.size === MAX_PICKUPS, 'and the cap holds');

  // ---- collection ----
  const put = (kind: 'ammo' | 'health', x: number, y: number) => {
    room.pickups.clear();
    const c = createPickup(kind, x, y);
    room.pickups.set(c.id, c);
    return c;
  };
  // a hurt human standing on a medkit takes it
  h.hp = 40;
  const med = put('health', h.x, h.y);
  room.collectPickups();
  check(h.hp === PLAYER_HP && room.pickups.size === 0, `a hurt human takes the medkit (hp ${h.hp})`);
  check(room.events.some(e => e.e === 'pick'), 'and the pickup is announced');

  // ...but a healthy one leaves it standing, exactly as the shop refuses a heal
  put('health', h.x, h.y);
  room.collectPickups();
  check(room.pickups.size === 1, 'a human at full health leaves the medkit on the floor');

  // ammo: refused when topped up, taken when not
  room.events.length = 0;
  put('ammo', h.x, h.y);
  room.collectPickups();
  check(room.pickups.size === 1, 'a human with full ammo leaves the ammo crate too');
  h.ammo[h.slots[0]]!.reserve = 0;
  room.collectPickups();
  check(room.pickups.size === 0 && h.ammo[h.slots[0]]!.reserve > 0, 'and takes it once short');

  // bots walk over crates without consuming them: a squadmate hoovering a rare
  // full refill it did not need is the one way this makes the game worse
  bot.hp = 30;
  bot.ammo[bot.slots[0]]!.reserve = 0;
  const b1 = put('health', bot.x, bot.y);
  room.collectPickups();
  check(room.pickups.has(b1.id) && bot.hp === 30, 'a bot squadmate walks over a medkit without taking it');
  const b2 = put('ammo', bot.x, bot.y);
  room.collectPickups();
  check(room.pickups.has(b2.id) && bot.ammo[bot.slots[0]]!.reserve === 0, 'and over an ammo crate too');

  // a downed human is not a collector either
  h.alive = false;
  h.hp = 10;
  const dead = put('health', h.x, h.y);
  room.collectPickups();
  check(room.pickups.has(dead.id), 'a downed human does not collect');
  h.alive = true;

  // a squad wipe resets the world, crates included
  room.resetGame();
  check(room.pickups.size === 0, 'a squad wipe clears the floor');

  check(room.modeSnapshot().pk.length === 0, 'the snapshot carries the crate list');
  room.startWave(1);
  const snapPk = room.modeSnapshot().pk;
  check(snapPk.length === PICKUPS_PER_WAVE && snapPk.every(c => c.kind === 'ammo' || c.kind === 'health'),
    'and it is populated once a wave places them');
  room.destroy();
}

// ---- Zombie: checkpoints (resume at wave 5/10/15…) ----
console.log('zombie checkpoints');
{
  const room = new ZombieRoom('z3');
  const h = room.addPlayer({ name: 'H', bot: false })!;
  room.arm(NaN);
  room.arm(-25);
  room.arm(3);
  check(room.checkpoint === 0 && room.wave === 0, 'garbage/low resume points rejected');
  room.arm(12);
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
  room.arm(50);
  check(room.checkpoint === 15, 'checkpoint cannot be re-armed mid-run');
  room.destroy();

  // a second human joining a still-fresh room must not hijack it either
  const r2 = new ZombieRoom('z4');
  r2.addPlayer({ name: 'A', bot: false });
  r2.addPlayer({ name: 'B', bot: false });
  r2.arm(50);
  check(r2.checkpoint === 0, 'second human cannot arm a checkpoint on a fresh room');
  r2.destroy();
}

// ---- predicted reload mirror ----
// The server owns ammo; the mirror only exists so the bar moves on the frame R
// is pressed instead of one round trip later. What matters is that it always
// yields to the server: it must never outlive a refusal, never end a reload the
// server is still running, and never report ready before the server does.
console.log('reload mirror');
{
  const RIFLE = WEAPONS.rifle.reloadMs / 1000;
  const dt = 1 / 60;

  // starts immediately, before the server has said anything
  const r = newReloadMirror();
  check(startReload(r, 'rifle', { mag: 4, reserve: 60 }), 'a partial mag starts a predicted reload');
  check(Math.abs(tickReload(r, 0, dt) - (RIFLE - dt)) < 1e-6,
    'the bar moves on the first frame, with the server still reporting nothing');
  check(!startReload(r, 'rifle', { mag: 4, reserve: 60 }), 'a second press while reloading is ignored');

  // the server picks it up one round trip later and then owns the ending
  for (let i = 0; i < 15; i++) tickReload(r, 0, dt);   // ~250ms of silence
  check(r.active && !r.confirmed, 'still predicting while unconfirmed');
  tickReload(r, RIFLE - 0.3, dt);
  check(r.confirmed, 'server reporting a reload confirms the mirror');
  let shown = 1;
  for (let i = 0; i < 200 && r.active; i++) shown = tickReload(r, RIFLE - 0.3, dt);
  check(r.active && shown === 0,
    'a local clock that runs out early keeps the mirror up rather than clearing it');
  shown = tickReload(r, 0, dt);
  check(!r.active && shown === 0, 'the server finishing ends the mirror');

  // a refused reload must back itself out rather than hang the bar
  const r2 = newReloadMirror();
  startReload(r2, 'rifle', { mag: 4, reserve: 60 });
  let t = 0;
  while (r2.active && t < 5) { tickReload(r2, 0, dt); t += dt; }
  check(!r2.active && t >= CONFIRM_GRACE && t < CONFIRM_GRACE + 0.1,
    `an unacknowledged reload backs out after the grace period (${t.toFixed(2)}s)`);

  // the same magazine test the server applies, so we never predict a refusal
  const r3 = newReloadMirror();
  check(!startReload(r3, 'rifle', { mag: WEAPONS.rifle.mag, reserve: 60 }), 'a full mag does not reload');
  check(!startReload(r3, 'rifle', { mag: 0, reserve: 0 }), 'an empty reserve does not reload');
  check(!startReload(r3, 'rifle', undefined), 'missing ammo does not reload');

  // switching weapons or dying drops the prediction
  const r4 = newReloadMirror();
  startReload(r4, 'rifle', { mag: 4, reserve: 60 });
  cancelReload(r4);
  check(!r4.active && tickReload(r4, 0, dt) === 0, 'cancel drops the mirror to the server value');
}

// ---- bots never spend reserve, but still reload ----
// The point is the "but": a bot with a bottomless magazine would stop reloading
// altogether, which is a visible and audible change to how it fights. Only the
// reserve is free, so every other cost stays — the mag empties on the same
// round and the reload takes the same reloadMs.
console.log('bot infinite reserve');
{
  const room = new TDMRoom('t-ammo');
  const bot = room.addPlayer({ name: 'B', bot: true, team: TEAM.RED, primary: 'rifle' })!;
  const human = room.addPlayer({ name: 'H', bot: false, team: TEAM.BLUE, primary: 'rifle' })!;
  const w = WEAPONS.rifle;
  const drain = (p: typeof bot): number => {
    const ammo = p.ammo.rifle!;
    // empty the mag, reload, repeat — twice as many times as the reserve holds
    for (let i = 0; i < (w.reserve / w.mag) * 2; i++) {
      ammo.mag = 0;
      room.startReload(p);
      room.finishReload(p);
    }
    return ammo.reserve;
  };

  check(bot.slots[1] === 'rifle' && human.slots[1] === 'rifle', 'both carry a rifle');
  bot.slot = 1; human.slot = 1;

  check(drain(human) === 0, 'a human runs the reserve dry');
  check(human.ammo.rifle!.mag === 0, 'and is then stuck with an empty gun');

  check(drain(bot) === w.reserve, 'a bot doing the same still has a full reserve');
  check(bot.ammo.rifle!.mag === w.mag, 'and a full magazine every time');

  // the reload is real, not skipped: reloadT is set and the mag stays empty
  // until it elapses, which is what keeps a bot's rate of fire honest
  bot.ammo.rifle!.mag = 0;
  room.startReload(bot);
  check(bot.reloadT === w.reloadMs / 1000 && bot.ammo.rifle!.mag === 0,
    'a bot reload takes the weapon\'s full reload time');
  check(room.events.some(e => e.e === 'reload' && e.id === bot.id),
    'and is announced, so it looks and sounds like any other reload');
  room.destroy();
}

// ---- switch lockout reaches the client ----
// The local gun mirror gates firing on self.sw. Without it, a client at high
// ping keeps firing through the 350ms switch lockout and emits tracers the
// server refuses outright.
console.log('switch lockout on the wire');
{
  const room = new TDMRoom('s1');
  const p = room.addPlayer({ name: 'P', bot: false, team: TEAM.RED })!;
  const sent: string[] = [];
  // stand in for a connected socket so broadcast() builds the per-client block
  room.clients.set(p.id, { send: (s: string) => sent.push(s) } as never);

  room.broadcast();
  check(JSON.parse(sent.at(-1)!).self.sw === 0, 'idle player reports no lockout');
  room.trySwitch(p, 0);
  room.broadcast();
  const sw = JSON.parse(sent.at(-1)!).self.sw;
  check(sw > 0, `switching arms the lockout on the wire (sw=${sw})`);
  room.advanceTimers(p, 1); // burn it
  room.broadcast();
  check(JSON.parse(sent.at(-1)!).self.sw === 0, 'lockout clears once the switch completes');
  room.destroy();
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

// ---- touch: the auto-fire trigger ----
// There is no fire button on a phone, so the gun goes off exactly when the
// crosshair is on a body. The threshold is derived rather than tuned — the
// target's own angular half-width plus the weapon's effective spread — so it
// tracks distance, the radii in shared/constants.ts, and bloom for free.
console.log('\ntouch auto-fire trigger');
{
  const DEG = Math.PI / 180;
  const g = new Grid(140, 140);
  const me = { x: g.pxW() / 2, y: g.pxH() / 2 };
  // aim due east; a target `offDeg` off that is `offDeg` of error
  const at = (dist: number, offDeg: number, radius = PLAYER_RADIUS) => ({
    x: me.x + Math.cos(offDeg * DEG) * dist,
    y: me.y + Math.sin(offDeg * DEG) * dist,
    radius,
  });
  // the real pipeline: assist picks and pulls, then the trigger reads its pick
  const fires = (dist: number, offDeg: number, spread = 0, radius = PLAYER_RADIUS) => {
    const st = newAssist();
    const aim = tickAimAssist(st, 0, me.x, me.y, [at(dist, offDeg, radius)], 2000, g);
    return onTarget(st, aim, spread);
  };

  // 1. the headline: a wobble the player cannot remove still fires, because the
  // assist pulls it inside the body first
  check(fires(800, 2), 'a 2deg wobble at rifle range fires (the assist pulls it on)');
  check(fires(1800, 2), 'and at sniper range, where the target is 1.1deg wide');

  // 2. pointing somewhere else does not. 10deg is inside the assist cone, so
  // this is the trigger refusing, not the assist failing to find a target.
  check(!fires(800, 10), 'pointing 10deg off an 800px target does not fire');
  check(10 < ASSIST_CONE / DEG, 'and that 10deg is inside the assist cone, so it is the trigger refusing');
  check(!fires(1800, 4), 'nor 4deg off at sniper range');

  // 3. scale: a body 150px away fills 6.5deg either side of its centre, so an
  // error that misses at range is a hit here. Nothing per-weapon says so —
  // atan2 does, off the radius in shared/constants.ts.
  const half150 = Math.atan2(PLAYER_RADIUS, 150) / DEG;
  check(fires(150, 5), `at 150px a 5deg error is still on the body (half-width ${half150.toFixed(1)}deg)`);
  check(!fires(150, 8), 'and 8deg is off it, even that close');
  check(!fires(800, 5), 'while the 5deg that hit up close misses the same body at 800px');

  // 4. no target, no shot. This is the whole reason the trigger can be
  // invisible: the gun cannot fire at nothing, so there is nothing to hold.
  const empty = newAssist();
  check(!onTarget(empty, 0, 0), 'a fresh assist with no target never fires');
  const stale = newAssist();
  tickAimAssist(stale, 0, me.x, me.y, [at(800, 0)], 2000, g);
  releaseAssist(stale);
  check(!onTarget(stale, 0, 0), 'and releasing the stick disarms the remembered target');

  // 5. spread widens the gate, because at full bloom the rounds really do go
  // that wide. The shotgun is the case this exists for: its pellets cover the
  // arc, so a body inside it is a body it hits.
  const shotgun = WEAPONS.shotgun;
  check(fires(300, 5, shotgun.baseSpread), `a shotgun fires 5deg off at 300px (its pellets span ${(shotgun.baseSpread / DEG).toFixed(1)}deg)`);
  check(!fires(300, 5, WEAPONS.sniper.baseSpread), 'a sniper at the same angle does not');

  // 6. the gate is exactly the target half-width plus spread, checked at the
  // boundary from both sides — an off-by-one here is a gun that fires early
  const d = 800, half = Math.atan2(PLAYER_RADIUS, d);
  const on = newAssist();
  tickAimAssist(on, 0, me.x, me.y, [at(d, 0)], 2000, g);
  check(onTarget(on, -half * 0.99, 0), 'just inside the target edge fires');
  check(!onTarget(on, -half * 1.01, 0), 'and just outside it does not');
}

// ---- touch: radius-scaled aim easing ----
// A floating stick's angular sensitivity is 1/radius, so near its origin a 1-3px
// wander of the finger's contact centroid was ~13deg of instant rotation. The
// fix must kill that WITHOUT dulling a committed flick at the rim.
console.log('\ntouch aim easing');
{
  const dt = 1 / 60, DEG = Math.PI / 180;
  const tauAt = (s: number) =>
    AIM_TAU_NEAR + (AIM_TAU_FAR - AIM_TAU_NEAR) * ((s - DEAD_ZONE) / (1 - DEAD_ZONE));
  // primed state: acquired already, so we measure easing and not the snap
  const primed = (a = 0) => {
    const st = newAimSmooth();
    tickAimSmooth(st, a, 1, dt);
    return st;
  };

  // 1. the reported bug. +-1.5px of tangential centroid noise at 10Hz, converted
  // to degrees at that radius, must come out small at BOTH ends of the travel.
  const wobble = (s: number) => {
    const amp = (1.5 / (s * STICK_R));         // radians of raw jitter
    const st = primed();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 600; i++) {
      const t = i * dt;
      tickAimSmooth(st, amp * Math.sin(2 * Math.PI * 10 * t), s, dt);
      if (t > 0.3) { lo = Math.min(lo, st.a); hi = Math.max(hi, st.a); }
    }
    return { raw: 2 * amp / DEG, out: (hi - lo) / DEG };
  };
  const near = wobble(DEAD_ZONE);
  check(near.raw > 12 && near.out < 3,
    `centroid noise at the deadzone is flattened (${near.raw.toFixed(1)}deg raw -> ${near.out.toFixed(2)}deg)`);
  const rim = wobble(1);
  check(rim.out < 3, `and it is no worse at the rim (${rim.raw.toFixed(1)}deg raw -> ${rim.out.toFixed(2)}deg)`);

  // 2. the flick must survive: at the rim the ease is ~1:1, so a deliberate 90deg
  // sweep lands in a couple of frames. This is the property that makes the cure
  // local — dulling the rim would have traded one bad feel for another.
  const sweep = (s: number) => {
    const st = primed();
    for (let i = 0; i < 600; i++) {
      tickAimSmooth(st, 90 * DEG, s, dt);
      if (st.a >= 81 * DEG) return (i + 1) * dt * 1000;
    }
    return Infinity;
  };
  const rimMs = sweep(1), nearMs = sweep(DEAD_ZONE);
  check(rimMs <= 50, `a rim flick is effectively instant (90deg in ${rimMs.toFixed(0)}ms)`);
  check(nearMs > rimMs * 3,
    `while the same sweep near the centre is deliberately damped (${nearMs.toFixed(0)}ms)`);
  check(tauAt(1) < tauAt(DEAD_ZONE), 'tau falls monotonically with deflection');

  // 3. shortest arc across the +-PI seam. A plain lerp from 179deg to -179deg
  // takes the 358deg route and spins the player the whole way round.
  const seam = primed(179 * DEG);
  tickAimSmooth(seam, -179 * DEG, 1, dt);
  const moved = ((seam.a - 179 * DEG) / DEG + 540) % 360 - 180;
  check(moved > 0 && moved < 3,
    `179deg -> -179deg steps forward across the seam, not back round it (${moved.toFixed(2)}deg)`);
  // and the output stays wrapped, so nothing downstream sees a runaway angle
  const spin = primed();
  for (let i = 0; i < 240; i++) tickAimSmooth(spin, ((i * 37) % 360 - 180) * DEG, 1, dt);
  check(Math.abs(spin.a) <= Math.PI + 1e-9, `the eased angle stays in (-PI, PI] (${spin.a.toFixed(3)})`);

  // 4. frame-rate independence: phones are the only callers and they range from
  // a throttled 20fps to 120fps. Same wall clock must give the same angle.
  const fast = primed(), slow = primed();
  for (let i = 0; i < 10; i++) tickAimSmooth(fast, 90 * DEG, DEAD_ZONE, 0.016);
  tickAimSmooth(slow, 90 * DEG, DEAD_ZONE, 0.16);
  check(Math.abs(fast.a - slow.a) / DEG < 0.5,
    `160ms of ease matches at 62fps and 6fps (${(fast.a / DEG).toFixed(2)} vs ${(slow.a / DEG).toFixed(2)})`);

  // 5. a fresh plant snaps. Easing 150deg over ~230ms at the moment the player
  // is reacting to something behind them reads as a broken stick.
  const fresh = newAimSmooth();
  check(tickAimSmooth(fresh, 150 * DEG, DEAD_ZONE, dt) === 150 * DEG,
    'the first angle of a new touch is taken whole');

  // ...and the snap must survive the touchdown frames, where deflection is still
  // zero and the caller is holding the PREVIOUS touch's angle. Latching there
  // would spend the snap on a stale target and ease into the real one.
  const plant = newAimSmooth();
  tickAimSmooth(plant, 0, 1, dt);            // a previous touch, aimed at 0
  releaseAim(plant);                          // thumb lifts, new touch lands
  for (let i = 0; i < 5; i++) tickAimSmooth(plant, 0, 0, dt); // ...held inside the deadzone
  check(tickAimSmooth(plant, 150 * DEG, 0.38, dt) === 150 * DEG,
    'the snap waits for the first angle past the deadzone, not the touchdown frame');
  // ...and only the first: the very next sample eases again
  const after = tickAimSmooth(fresh, 0, DEAD_ZONE, dt);
  check(after > 100 * DEG, `the touch then eases as normal (${(after / DEG).toFixed(1)}deg)`);
  releaseAim(fresh);
  check(tickAimSmooth(fresh, 0, DEAD_ZONE, dt) === 0, 'releaseAim re-arms the snap for the next touch');

  // 6. monotonic, no overshoot — an overshoot would be a wobble of its own
  const mono = primed();
  let prev = mono.a, ok = true;
  for (let i = 0; i < 120; i++) {
    tickAimSmooth(mono, 45 * DEG, 0.5, dt);
    if (mono.a < prev || mono.a > 45 * DEG + 1e-9) ok = false;
    prev = mono.a;
  }
  check(ok, 'the ease rises monotonically and never overshoots the target');
}

// ---- touch: aim assist ----
// A target's angular size falls as 1/distance but the thumb's noise floor does
// not, so past ~500px an enemy is narrower than the ~2deg the aim ease leaves
// behind and no amount of steadiness holds a crosshair on it. The pull is sized
// to erase exactly that, and to fade out where it isn't needed.
console.log('\ntouch aim assist');
{
  const DEG = Math.PI / 180;
  // A synthetic all-floor arena for the geometry: a real map has no 1800px
  // sightline, and a wall silently eating the pull would make these checks
  // measure LOS instead of the maths. The real map is used for the LOS test
  // below, which is the one that actually wants walls.
  const g = new Grid(140, 140);
  const me = { x: g.pxW() / 2, y: g.pxH() / 2 };
  const at = (dist: number, offDeg: number, radius = PLAYER_RADIUS) => ({
    x: me.x + Math.cos(offDeg * DEG) * dist,
    y: me.y + Math.sin(offDeg * DEG) * dist,
    radius,
  });
  // aim due east; a target `offDeg` off that is `offDeg` of error
  const pull = (dist: number, offDeg: number, radius = PLAYER_RADIUS, range = 2000) => {
    const st = newAssist();
    const out = tickAimAssist(st, 0, me.x, me.y, [at(dist, offDeg, radius)], range, g);
    return wrapDeg(out / DEG);
  };

  // 1. the headline claim: at rifle range the pull all but erases the residual
  // wobble, taking the aim from 2deg off to a fraction of the target's width
  const half800 = Math.atan2(PLAYER_RADIUS, 800) / DEG;
  const res800 = 2 - pull(800, 2);
  check(res800 < half800,
    `at 800px a 2deg wobble is pulled inside the target (${res800.toFixed(2)}deg left, target half-width ${half800.toFixed(2)}deg)`);
  const half1800 = Math.atan2(PLAYER_RADIUS, 1800) / DEG;
  const res1800 = 2 - pull(1800, 2);
  check(res1800 < half1800,
    `and at sniper range too (${res1800.toFixed(2)}deg left, half-width ${half1800.toFixed(2)}deg)`);

  // 2. ...while up close it barely acts, because a 12.9deg target needs no help
  const near = pull(150, 2);
  check(near < 0.5, `at 150px the pull is negligible (${near.toFixed(2)}deg of a 2deg error)`);
  check(pull(800, 2) > near * 4, 'the pull scales with how much the target needs it');

  // 3. bounded by construction — err*(1-|err|/cone) peaks at cone/4. This is
  // what stops it becoming a lock: a deliberate thumb always outvotes it.
  let peak = 0;
  for (let o = -25; o <= 25; o += 0.25) peak = Math.max(peak, Math.abs(pull(1800, o)));
  const bound = ASSIST_MAX_PULL / DEG;
  check(peak <= bound + 1e-6,
    `the bend never exceeds cone/4 (peak ${peak.toFixed(2)}deg, bound ${bound.toFixed(2)}deg)`);
  // two-sided: the bound must be tight, or it is documenting a limit the code
  // never approaches and would not catch a strength change
  check(peak > bound * 0.98, `and the bound is tight, not decorative (${peak.toFixed(2)} vs ${bound.toFixed(2)})`);

  // 4. no pull outside the cone, and none at the boundary either — a step there
  // would be a snap the player did not ask for
  check(pull(800, ASSIST_CONE / DEG + 1) === 0, 'a target outside the cone is ignored');
  check(Math.abs(pull(800, ASSIST_CONE / DEG)) < 1e-9, 'and the pull reaches zero at the cone edge, not a step');

  // 5. always toward the target, never away
  check(pull(800, 5) > 0 && pull(800, -5) < 0, 'the pull is signed toward the target');

  // 6. weapon range gates it: a shotgun must not be helped with a shot that
  // cannot reach. 420px is the shotgun's range.
  check(pull(600, 3, PLAYER_RADIUS, 420) === 0, 'a target beyond the weapon range is ignored');
  check(pull(400, 3, PLAYER_RADIUS, 420) > 0, 'and one inside it is not');

  // 7. never through a wall — that would hand mobile information the renderer
  // deliberately withholds. Uses a REAL map, and finds a real solid tile with
  // floor on both sides of it.
  const real = new TDMRoom('assist').grid;
  let blocked: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  for (let ty = 1; ty < real.h - 1 && !blocked; ty++) {
    for (let tx = 2; tx < real.w - 2; tx++) {
      if (real.get(tx, ty) === T_FLOOR
        || real.get(tx - 1, ty) !== T_FLOOR || real.get(tx + 1, ty) !== T_FLOOR) continue;
      blocked = {
        from: { x: (tx - 1 + 0.5) * TILE, y: (ty + 0.5) * TILE },
        to: { x: (tx + 1 + 0.5) * TILE, y: (ty + 0.5) * TILE },
      };
      break;
    }
  }
  check(blocked !== null, 'found a wall with floor either side to test LOS against');
  if (blocked) {
    const wallAim = Math.atan2(blocked.to.y - blocked.from.y, blocked.to.x - blocked.from.x);
    const tgt = { x: blocked.to.x, y: blocked.to.y, radius: PLAYER_RADIUS };
    const st = newAssist();
    const out = tickAimAssist(st, wallAim + 2 * DEG, blocked.from.x, blocked.from.y, [tgt], 2000, real);
    check(out === wallAim + 2 * DEG, 'a target behind a wall gets no pull');
    check(!st.has, 'and is not remembered as the sticky target');
    // ...and the same target with the wall gone does get one, so the check above
    // is really about LOS and not about the geometry being out of cone
    const open = newAssist();
    const clear = tickAimAssist(open, wallAim + 2 * DEG, blocked.from.x, blocked.from.y, [tgt], 2000, g);
    check(clear !== wallAim + 2 * DEG, 'while the identical geometry in the open is assisted');
  }

  // 8. stickiness. Two targets either side of the crosshair: without hysteresis
  // the pull changes sign the moment the nearer one swaps, which is a wobble of
  // its own. The one chosen last frame keeps its claim through a small swap.
  const left = at(800, -4), right = at(800, 4.4);
  const st = newAssist();
  const first = tickAimAssist(st, 0, me.x, me.y, [left, right], 2000, g);
  check(first < 0, 'the nearer of two targets takes the pull');
  // now make the other marginally nearer — inside the stick bonus, so no flip
  const swap = tickAimAssist(st, 0, me.x, me.y, [at(800, -4.6), at(800, 4)], 2000, g);
  check(swap < 0, 'a marginal swap does not flip the pull to the other target');
  // a decisive difference still wins, or the assist could never change target
  const decisive = tickAimAssist(st, 0, me.x, me.y, [at(800, -14), at(800, 1)], 2000, g);
  check(decisive > 0, 'a clearly better target does take over');

  // 9. an empty target set is the common case (nobody in view) and must be free
  const none = newAssist();
  check(tickAimAssist(none, 1.234, me.x, me.y, [], 2000, g) === 1.234, 'no targets means no change');
  releaseAssist(st);
  check(!st.has, 'releaseAssist drops the sticky target');
}

// ---- touch: eased camera lead ----
// Releasing the aim stick zeroes deflection in one frame, so the camera lead has
// to be eased or it steps the whole TOUCH_LEAD distance at once.
console.log('\ntouch camera lead');
{
  const TAU = 0.08, REACH = 140;

  // frame-rate independence — the property a fixed per-frame lerp factor fails.
  // Same 160ms of wall clock, ten small steps vs one big one.
  const fast = newLead(); fast.x = REACH;
  for (let i = 0; i < 10; i++) tickLead(fast, 0, 0, TAU, 0.016);
  const slow = newLead(); slow.x = REACH;
  tickLead(slow, 0, 0, TAU, 0.16);
  check(Math.abs(fast.x - slow.x) < 0.5,
    `160ms of ease is the same at 62fps and 6fps (${fast.x.toFixed(2)} vs ${slow.x.toFixed(2)})`);

  // monotonic toward the target, never past it — no overshoot to hide a snap
  const st = newLead(); st.x = REACH;
  let prev = st.x, ok = true;
  for (let i = 0; i < 60; i++) {
    tickLead(st, 0, 0, TAU, 1 / 60);
    if (st.x >= prev || st.x < 0) ok = false;
    prev = st.x;
  }
  check(ok, 'the lead falls monotonically and never crosses the target');

  // 250ms has to look settled, or the release still reads as a pan
  const q = newLead(); q.x = REACH;
  for (let i = 0; i < 15; i++) tickLead(q, 0, 0, TAU, 1 / 60);
  check(q.x < REACH * 0.05, `a release is >=95% closed by 250ms (${q.x.toFixed(1)} of ${REACH} left)`);

  // pushing off centre is the same law in reverse, and both axes move
  const up = newLead();
  for (let i = 0; i < 15; i++) tickLead(up, 0, -REACH, TAU, 1 / 60);
  check(up.x === 0 && up.y < -REACH * 0.95, `the lead eases out as well as in (y ${up.y.toFixed(1)})`);
}

// ---- persistent profiles ----
// The name registry, the delta flush and the earned/carried split. All three are
// things a wrong answer would be invisible in play: a stat that quietly does not
// save, or a carried run that silently hands out 39 skipped waves.
console.log('profiles: name registry');
{
  check(nameKey('  Raptor  ') === 'raptor' && nameKey('R  aptor') === 'r aptor',
    'the key folds case and collapses internal whitespace');
  check(nameError('') === 'empty' && nameError('   ') === 'empty', 'a blank name cannot be claimed');
  check(nameError('BOT Viper') === 'reserved' && nameError('bot viper') === 'reserved',
    'the BOT prefix is reserved, case-folded');
  check(nameError('Botanist') === null, 'but "bot" as a word start is fine — only the prefix is reserved');

  const a = claimProfile('Raptor')!;
  check(!!a && a.name === 'Raptor' && /^[0-9a-f]{32}$/.test(a.id), 'a claim mints a 32-hex token');
  check(a.bestWave === 0 && a.resumeWave === 0 && a.zKills === 0, 'a fresh profile is empty');
  check(claimProfile('raptor') === null, 'the same name in different casing is refused');
  check(!!claimProfile('Raptor Prime'), 'a name that merely contains another is fine');
  check(claimProfile('raptor   prime') === null,
    'but padded spacing cannot shadow it — runs collapse to one');
  check(nameTaken('RAPTOR') && !nameTaken('Nomad'), 'nameTaken folds the same way');
  check(claimProfile('BOT Ghost') === null, 'a reserved name is never claimed');
  check(!nameTaken(suggestName()), 'the menu suggestion is free');
  check(profileById(a.id)!.name === 'Raptor' && profileById('nope') === null, 'lookup by token');
}

console.log('profiles: stat flush');
{
  const p1 = claimProfile('Flusher')!;
  const room = new TDMRoom('p1');
  const h = room.addPlayer({ name: p1.name, bot: false })!;
  h.profileId = p1.id;

  room.flushStats(h);
  check(profileById(p1.id)!.tdmKills === 0, 'nothing to bank writes nothing');
  h.kills = 4; h.deaths = 2;
  room.flushStats(h);
  check(profileById(p1.id)!.tdmKills === 4 && profileById(p1.id)!.tdmDeaths === 2, 'a flush banks the match');
  room.flushStats(h);
  room.flushStats(h);
  check(profileById(p1.id)!.tdmKills === 4, 'flushing again is a no-op — it writes a delta, not a total');
  h.kills = 7;
  room.flushStats(h);
  check(profileById(p1.id)!.tdmKills === 7, 'later kills bank as a delta');

  // The match reset zeroes kills/deaths, so the banked marks have to go with
  // them or the next match's first 7 kills vanish.
  room.resetMatch();
  check(h.kills === 0 && h.bankedKills === 0, 'a reset clears the counters and the banked marks together');
  h.kills = 3;
  room.flushStats(h);
  check(profileById(p1.id)!.tdmKills === 10, 'the match after a reset banks in full');

  // Bots share every code path and must never write.
  const bot = room.addPlayer({ name: 'BOT Viper', bot: true })!;
  bot.kills = 99;
  room.flushStats(bot);
  check(bot.profileId === null, 'bots have no profile, so the flush is a no-op for them');
  room.destroy();
}

console.log('profiles: outbreak waves, earned vs carried');
{
  const earner = claimProfile('Earner')!;
  const carried = claimProfile('Carried')!;

  recordWave(earner.id, 12, true);
  let e = profileById(earner.id)!;
  check(e.bestWave === 12, 'best wave is exact');
  check(e.resumeWave === 10, 'the resume point floors to a multiple of 5');
  recordWave(earner.id, 7, true);
  e = profileById(earner.id)!;
  check(e.bestWave === 12 && e.resumeWave === 10, 'a worse run never lowers either number');

  recordWave(carried.id, 40, false);
  const c = profileById(carried.id)!;
  check(c.bestWave === 40, 'a carried run still counts toward best wave');
  check(c.resumeWave === 0, 'but not toward the resume point — no free 39 waves of cash');

  // The room arms from the stored resume point, and `earning` is decided against
  // it: this is the whole carry gate, expressed the way index.ts does it.
  const room = new ZombieRoom('p2');
  const h = room.addPlayer({ name: 'H', bot: false })!;
  h.profileId = earner.id;
  room.arm(profileById(earner.id)!.resumeWave);
  check(room.checkpoint === 10 && room.wave === 9, 'a room arms at the stored resume point');
  h.earning = room.checkpoint <= profileById(earner.id)!.resumeWave;
  check(h.earning, 'the player who armed it is earning');
  const guest = room.addPlayer({ name: 'G', bot: false })!;
  guest.profileId = carried.id;
  guest.earning = room.checkpoint <= profileById(carried.id)!.resumeWave;
  check(!guest.earning, 'a joiner whose own resume point is lower is being carried');

  room.startWave(15);
  check(profileById(earner.id)!.resumeWave === 15, 'surviving to 15 advances the earner');
  check(profileById(carried.id)!.resumeWave === 0, 'and never the carried player');
  check(profileById(carried.id)!.bestWave === 40, 'whose best wave stays where it was');
  room.destroy();
}

console.log('profiles: leaderboard');
{
  const top = claimProfile('Topper')!;
  const quiet = claimProfile('Quiet')!;
  addStats(top.id, 'zombie', 500, 3);
  const board = leaderboard(10);
  check(board.zombie[0].name === 'Topper' && board.zombie[0].kills === 500, 'ranked by kills, descending');
  check(!board.zombie.some(r => r.name === 'Quiet'), 'a profile with no kills is not an entry');
  check(!!profileById(quiet.id), 'even though it exists');
  check(!board.tdm.some(r => r.name === 'Topper'), 'the two modes are separate boards');
}
closeDb();

// ---- world materials: the render-only layer, and its separation from the sim ----
//
// tileset.ts is importable here for the same reason view.ts and stick.ts are:
// its tables and pure helpers touch no DOM at module scope. The draw functions
// need a canvas, so the checks that require pixels live in touchdrive.ts.
console.log('materials: every authored value has art');
{
  for (const name of ['compound', 'outbreak']) {
    const g = buildMap(name);
    check(g.mat.length === g.tiles.length, `${name}: mat is parallel to tiles`);

    // Every material a builder actually emits must resolve, and must resolve to
    // art of the RIGHT KIND — a wall labelled with a floor material would draw a
    // hole in a building rather than throw.
    const bad: string[] = [];
    let voids = 0;
    for (let ty = 0; ty < g.h; ty++) {
      for (let tx = 0; tx < g.w; tx++) {
        const t = g.get(tx, ty), id = matId(g.matAt(tx, ty));
        if (id === MAT.VOID) { voids++; continue; }
        const ok = t === T_WALL ? isWallMat(id)
          : t === T_CRATE ? isPropMat(id)
          : isFloorMat(id);
        if (!ok) bad.push(`${tx},${ty} tile=${t} mat=${id}`);
      }
    }
    check(voids === 0, `${name}: no tile was left unpainted`);
    check(bad.length === 0, `${name}: every material matches its tile kind`
      + (bad.length ? ` — ${bad.slice(0, 4).join('; ')}` : ''));

    // Every floor variant the position hash can select must have been baked, or
    // the tile silently renders nothing (tx.has() misses) instead of throwing.
    const missing = new Set<string>();
    for (let ty = 0; ty < g.h; ty++) {
      for (let tx = 0; tx < g.w; tx++) {
        const id = g.get(tx, ty) === T_FLOOR
          ? matId(g.matAt(tx, ty)) : matId(g.floorMatUnder(tx, ty));
        if (!isFloorMat(id)) continue;
        const v = floorVariant(id, tx, ty);
        if (v >= floorVariants(id)) missing.add(floorKey(id, v));
      }
    }
    check(missing.size === 0, `${name}: every selected floor variant exists`);

    // Decor is dressing, so the rule is that it can never matter: inside the
    // map, never on a solid tile, and always a frame that exists.
    const offMap = g.decor.filter(d => d.x < 0 || d.y < 0 || d.x > g.pxW() || d.y > g.pxH());
    const onSolid = g.decor.filter(d => g.solidAtPx(d.x, d.y));
    const noArt = g.decor.filter(d => !(d.f in DECOR_ART));
    check(g.decor.length > 20, `${name}: has decor (${g.decor.length} items)`);
    check(offMap.length === 0, `${name}: no decor outside the map`);
    check(onSolid.length === 0, `${name}: no decor stranded inside a solid tile`);
    check(noArt.length === 0, `${name}: every decor frame has art`);

    // Both halves have to survive the wire, and `mat` is the easy one to forget:
    // welcome sends it as a plain array and Uint8Array.set would silently
    // truncate a short one.
    const round = Grid.deserialize(g.serialize());
    check(round.mat.every((v, i) => v === g.mat[i]), `${name}: mat round-trips`);
    check(round.over.every((v, i) => v === g.over[i]), `${name}: over round-trips`);
    check(round.tiles.every((v, i) => v === g.tiles[i]), `${name}: tiles round-trip`);
    check(round.decor.length === g.decor.length
      && round.decor.every((d, i) => d.x === g.decor[i].x && d.f === g.decor[i].f),
      `${name}: decor round-trips`);
  }

  // The load-bearing separation: materials are render data, so painting them
  // must not have moved a single hitbox. Rebuild the geometry and compare.
  const fresh = buildMap('compound');
  const blank = new Grid(fresh.w, fresh.h);
  blank.tiles.set(fresh.tiles);
  check(blank.solid(17, 12) && !blank.solid(19, 12),
    'painting materials left the guard post wall and its doorway as they were');
  check([...fresh.mat].some(v => v !== 0) && fresh.tiles.length === blank.tiles.length,
    'mat is populated without changing the tile array length');
}

// Deterministic authoring: two builds of the same map must be byte-identical, or
// two clients in one room would disagree about the world and the tests above
// would only be true of whichever build happened to run.
console.log('materials: map building is deterministic');
{
  for (const name of ['compound', 'outbreak']) {
    const a = buildMap(name), b = buildMap(name);
    check(a.mat.every((v, i) => v === b.mat[i]), `${name}: materials are stable across builds`);
    check(a.over.every((v, i) => v === b.over[i]), `${name}: overheads are stable across builds`);
    check(a.decor.length === b.decor.length
      && a.decor.every((d, i) => d.x === b.decor[i].x && d.y === b.decor[i].y
        && d.f === b.decor[i].f && d.rot === b.decor[i].rot),
      `${name}: scattered decor is stable across builds`);
  }
}

// ---- Compound's fairness, as an actual measurement ----
//
// The map is authored through `rotated`, so its halves are each other's 180°
// rotation and neither team has geometry the other lacks. That is the whole
// reason the helper exists, and it is one stray direct `g.set` away from being
// quietly untrue — which is exactly the kind of unfairness nobody notices from
// inside a match.
console.log('compound: 180 degree rotational symmetry');
{
  const g = buildMap('compound');
  check(g.w % 2 === 0 && g.h % 2 === 0,
    `both dimensions even (${g.w}x${g.h}), so no tile is its own twin`);
  let tiles = 0, mats = 0, overs = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = g.idx(x, y), j = g.idx(g.w - 1 - x, g.h - 1 - y);
      if (g.tiles[i] !== g.tiles[j]) tiles++;
      if (g.mat[i] !== g.mat[j]) mats++;
      if (g.over[i] !== g.over[j]) overs++;
    }
  }
  check(tiles === 0, `every wall, crate and floor tile has its twin (${tiles} mismatches)`);
  check(mats === 0, `so does every material (${mats} mismatches) — the phase-3 ambient`
    + ' split reads MAT_INDOOR, so an asymmetric floor is asymmetric lighting');
  check(overs === 0, `and every overhead (${overs} mismatches)`);

  // Spawns: each team's set must be the other's rotation, not merely the same
  // count. A spawn that is 3 tiles further from the middle is a real advantage.
  const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;
  const blue = new Set(g.blueSpawns.map(key));
  const rotated = g.redSpawns.map(p => ({ x: g.pxW() - p.x, y: g.pxH() - p.y }));
  check(g.redSpawns.length === g.blueSpawns.length && rotated.every(p => blue.has(key(p))),
    `spawns are rotations of each other (${g.redSpawns.length} per team)`);

  // Decor too — it never matters to play, but a stray asymmetric scatter is the
  // tell that some authoring pass skipped the helper.
  const dset = new Map<string, number>();
  for (const d of g.decor) {
    const k = `${Math.round(d.x)},${Math.round(d.y)},${d.f}`;
    dset.set(k, (dset.get(k) ?? 0) + 1);
  }
  let lonely = 0;
  for (const d of g.decor) {
    const k = `${Math.round(g.pxW() - d.x)},${Math.round(g.pxH() - d.y)},${d.f}`;
    if (!dset.get(k)) lonely++;
  }
  check(lonely === 0, `every decor item has a rotated twin (${lonely} without)`);
}

// ---- overheads: authored in phase 2, drawn in phase 3 ----
//
// Nothing renders these yet, which is precisely why they need asserting now: a
// mistake made here surfaces a phase later as "the awning has no south edge" or
// "the pipe run turns a corner and draws a straight piece", long after the map
// was authored.
console.log('overheads: art, autotiling and the 3% budget');
{
  for (const name of ['compound', 'outbreak']) {
    const g = buildMap(name);
    const bad: string[] = [];
    const thin: string[] = [];
    const bent: string[] = [];
    let floors = 0, overFloor = 0, tiles = 0;
    for (let ty = 0; ty < g.h; ty++) {
      for (let tx = 0; tx < g.w; tx++) {
        if (g.get(tx, ty) === T_FLOOR) floors++;
        const id = g.overAt(tx, ty);
        if (!id) continue;
        tiles++;
        if (g.get(tx, ty) === T_FLOOR) overFloor++;
        if (!isOverId(id) || !OVER_HEIGHT[id]) { bad.push(`${tx},${ty} over=${id}`); continue; }
        const same = (x: number, y: number): boolean => g.overAt(x, y) === id;
        const mask = (same(tx, ty - 1) ? N : 0) | (same(tx + 1, ty) ? E : 0)
          | (same(tx, ty + 1) ? S : 0) | (same(tx - 1, ty) ? W : 0);
        const art = OVER_ART[id];
        if (art.kind === 'slab') {
          // The 9-slice has no piece with a north AND a south edge, so a slab one
          // tile thin would draw with a side missing.
          if (!(mask & (N | S)) || !(mask & (E | W))) thin.push(`${tx},${ty}`);
        } else {
          // No elbow art exists, and a lone tile has no orientation at all.
          if ((mask & (N | S)) && (mask & (E | W))) bent.push(`${tx},${ty}`);
          if (!mask) bent.push(`${tx},${ty} (single tile)`);
        }
        if (overVariant(id, mask) >= overVariants(id)) bad.push(`${tx},${ty} variant`);
      }
    }
    check(tiles > 0, `${name}: has authored overheads (${tiles} tiles)`);
    check(bad.length === 0, `${name}: every overhead resolves to art with a declared height`
      + (bad.length ? ` — ${bad.slice(0, 4).join('; ')}` : ''));
    check(thin.length === 0, `${name}: no slab is one tile thin`
      + (thin.length ? ` — ${thin.slice(0, 4).join('; ')}` : ''));
    check(bent.length === 0, `${name}: no pipe run turns or stands alone`
      + (bent.length ? ` — ${bent.slice(0, 4).join('; ')}` : ''));

    // The budget. It is measured against FLOOR tiles because that is what the
    // hazard is: an overhead over a wall hides nobody, and x-ray has to stay the
    // exception or every fight happens between flat silhouettes.
    const pct = 100 * overFloor / floors;
    check(pct <= 3, `${name}: overheads cover ${overFloor}/${floors} floor tiles`
      + ` = ${pct.toFixed(2)}%, budget 3% (margin ${(3 - pct).toFixed(2)} points)`);
  }

  // Every declared clearance must be well over a body: phase 3's occlusion test
  // is "is there anything above this actor", which is only safe while nothing in
  // the table is low enough for a player to be visible under it from the side.
  const lowest = Math.min(...Object.values(OVER_HEIGHT));
  check(lowest > 4 * PLAYER_RADIUS,
    `the lowest overhead (${lowest}px) clears a body by a wide margin`);
  check(Object.keys(OVER).filter(k => k !== 'NONE')
    .every(k => OVER_HEIGHT[OVER[k as keyof typeof OVER]] > 0),
    'every overhead id declares a height');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
