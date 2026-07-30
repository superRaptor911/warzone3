import { findPath } from './pathfinding.ts';
import { weaponOf, ammoOf, type Player } from './entities.ts';
import { dist } from '../shared/physics.ts';
import type { WeaponId } from '../shared/weapons.ts';
import type { InputMsg, MoveKeys, Vec2 } from '../shared/types.ts';
import type { Room } from './room.ts';

const VIEW_RANGE = 950;
const BOT_NAMES = ['Viper', 'Rook', 'Havoc', 'Mantis', 'Echo', 'Blitz', 'Specter',
  'Nomad', 'Torque', 'Wraith', 'Jinx', 'Onyx', 'Falcon', 'Drifter', 'Saber', 'Piston'];
let nameCursor = 0;
export function nextBotName(): string {
  return 'BOT ' + BOT_NAMES[nameCursor++ % BOT_NAMES.length];
}

// preferred engagement distance band per weapon
const BANDS: Record<WeaponId, [number, number]> = {
  pistol: [150, 380], smg: [130, 330], rifle: [220, 500],
  shotgun: [70, 190], sniper: [380, 750], lmg: [250, 550],
};

export interface BotController {
  aimCur: number;
  targetId: number | null;
  seenT: number;
  lastKnown: Vec2 | null;
  path: Vec2[] | null;
  pathT: number;
  goal: Vec2 | null;
  strafe: number;
  strafeT: number;
  lastX: number; lastY: number;
  stuckT: number; jiggleT: number; jiggleA: number;
  fireTick: boolean;
  reaction: number;
  errBase: number;
}

// Same shape a client sends, with the fields bots always fill in.
export interface BotInput extends InputMsg {
  keys: MoveKeys;
  aim: number;
  fire: boolean;
  sprint: boolean;
  seq: number;
}

export function createBotController(): BotController {
  return {
    aimCur: Math.random() * Math.PI * 2,
    targetId: null, seenT: 0,
    lastKnown: null,
    path: null, pathT: 0, goal: null,
    strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
    lastX: 0, lastY: 0, stuckT: 0, jiggleT: 0, jiggleA: 0,
    fireTick: false,
    reaction: 0.2 + Math.random() * 0.2,
    errBase: 0.26 + Math.random() * 0.14,
  };
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function botThink(room: Room, p: Player, dt: number): BotInput {
  const c = p.botCtl!, grid = room.grid;
  const input: BotInput = { keys: {}, aim: c.aimCur, fire: false, sprint: false, seq: p.lastSeq };
  if (!p.alive) return input;

  const w = weaponOf(p), ammo = ammoOf(p);

  // --- perception ---
  const enemies = room.botEnemies(p);
  let target = null, targetDist = Infinity;
  const prev = c.targetId !== null ? enemies.find(e => e.id === c.targetId) : null;
  const visible = (e: Vec2) => {
    const d = dist(p, e);
    return d < VIEW_RANGE && grid.los(p.x, p.y, e.x, e.y) ? d : null;
  };
  if (prev) {
    const d = visible(prev);
    if (d !== null) { target = prev; targetDist = d; }
  }
  if (!target) {
    for (const e of enemies) {
      const d = visible(e);
      if (d !== null && d < targetDist) { target = e; targetDist = d; }
    }
  }

  if (target) {
    c.seenT = c.targetId === target.id ? c.seenT + dt : dt;
    c.targetId = target.id;
    c.lastKnown = { x: target.x, y: target.y };
  } else {
    c.targetId = null;
    c.seenT = 0;
  }

  // --- aiming ---
  const move = { x: 0, y: 0 };
  if (target) {
    const wobble = Math.sin(room.now / 110 + p.id * 3.1) * 0.6;
    const err = (0.03 + c.errBase * Math.exp(-c.seenT / 0.55)) * (1 + wobble * 0.5);
    const desired = Math.atan2(target.y - p.y, target.x - p.x) + err * Math.sin(room.now / 90 + p.id);
    const diff = angDiff(desired, c.aimCur);
    const turn = 8.5 * dt;
    c.aimCur += Math.abs(diff) < turn ? diff : Math.sign(diff) * turn;

    // fire discipline
    const aligned = Math.abs(angDiff(desired, c.aimCur)) < 0.14;
    const wantFire = c.seenT > c.reaction && aligned && targetDist < w.range * 0.95 &&
      p.reloadT <= 0 && ammo.mag > 0;
    if (wantFire) {
      c.fireTick = !c.fireTick;
      input.fire = w.auto ? true : c.fireTick;
    }

    // combat movement: hold range band + strafe
    const band = BANDS[w.id] || BANDS.rifle;
    const tx = (target.x - p.x) / targetDist, ty = (target.y - p.y) / targetDist;
    c.strafeT -= dt;
    if (c.strafeT <= 0) { c.strafe = -c.strafe; c.strafeT = 0.7 + Math.random() * 0.8; }
    let along = 0;
    if (targetDist > band[1]) along = 1;
    else if (targetDist < band[0]) along = -1;
    move.x = tx * along + -ty * c.strafe * 0.9;
    move.y = ty * along + tx * c.strafe * 0.9;
    c.path = null;
  } else {
    // --- navigation ---
    let goal = c.lastKnown || room.botGoal(p);
    if (goal && dist(p, goal) < 48) {
      if (c.lastKnown) c.lastKnown = null;
      room.botGoalReached?.(p);
      goal = null;
      c.path = null;
    }
    if (goal) {
      c.pathT -= dt;
      const stale = !c.path || c.path.length === 0 ||
        dist(c.path[c.path.length - 1], goal) > 150;
      if (stale || c.pathT <= 0) {
        c.path = findPath(grid, p.x, p.y, goal.x, goal.y);
        c.pathT = 0.8 + Math.random() * 0.5;
      }
      if (c.path && c.path.length) {
        while (c.path.length && dist(p, c.path[0]) < 26) c.path.shift();
        if (c.path.length) {
          const wp = c.path[0];
          const d = dist(p, wp);
          move.x = (wp.x - p.x) / d;
          move.y = (wp.y - p.y) / d;
          input.sprint = d > 200;
        }
      }
    }
    // idle aim follows movement
    if (move.x || move.y) {
      const desired = Math.atan2(move.y, move.x);
      const diff = angDiff(desired, c.aimCur);
      c.aimCur += Math.max(-6 * dt, Math.min(6 * dt, diff));
    }
  }

  // --- threats override (kiting, e.g. zombies too close) ---
  const threat = room.botThreat ? room.botThreat(p) : null;
  if (threat) {
    const d = Math.max(1, dist(p, threat));
    move.x += ((p.x - threat.x) / d) * 1.6;
    move.y += ((p.y - threat.y) / d) * 1.6;
  }

  // --- stuck detection / jiggle ---
  const wantsMove = Math.abs(move.x) > 0.05 || Math.abs(move.y) > 0.05;
  const progressed = Math.hypot(p.x - c.lastX, p.y - c.lastY) / dt;
  c.lastX = p.x; c.lastY = p.y;
  if (wantsMove && progressed < 30) {
    c.stuckT += dt;
    if (c.stuckT > 0.45) {
      c.stuckT = 0;
      c.jiggleT = 0.4;
      c.jiggleA = Math.random() * Math.PI * 2;
      c.path = null; c.pathT = 0;
    }
  } else c.stuckT = 0;
  if (c.jiggleT > 0) {
    c.jiggleT -= dt;
    move.x = Math.cos(c.jiggleA);
    move.y = Math.sin(c.jiggleA);
  }

  // --- reload management ---
  if (ammo.mag === 0 || (!target && ammo.mag < w.mag * 0.4)) room.startReload(p);

  // vector -> keys
  const len = Math.hypot(move.x, move.y);
  if (len > 0.05) {
    const nx = move.x / len, ny = move.y / len;
    if (nx > 0.38) input.keys.d = 1;
    if (nx < -0.38) input.keys.a = 1;
    if (ny > 0.38) input.keys.s = 1;
    if (ny < -0.38) input.keys.w = 1;
  }
  if (target) input.sprint = false;
  input.aim = c.aimCur;
  return input;
}
