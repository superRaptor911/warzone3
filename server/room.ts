import { buildMap, type Grid } from '../shared/maps.ts';
import { stepMove, tickSprint, dist } from '../shared/physics.ts';
import { WEAPONS, fireIntervalMs, damageAt, type Weapon, type WeaponId } from '../shared/weapons.ts';
import {
  TICK_RATE, SNAPSHOT_EVERY, PLAYER_HP, SWITCH_MS, STAMINA_MAX,
} from '../shared/constants.ts';
import { weaponOf, ammoOf, type Player, type Zombie } from './entities.ts';
import { botThink } from './bot.ts';
import type {
  GameEvent, GameMode, InputMsg, PlayerSnap, RoomState, SnapshotBase, Vec2,
} from '../shared/types.ts';
import type { WebSocket } from 'ws';

const SPREAD_DECAY_DELAY = 0.25; // s since last shot before bloom recovers

// What a shot can hit; produced by hitscanTargets, consumed by damageTarget.
export type Target =
  | { id: number; x: number; y: number; radius: number; kind: 'player'; ref: Player }
  | { id: number; x: number; y: number; radius: number; kind: 'zombie'; ref: Zombie };

export interface AddPlayerOpts {
  name: string;
  bot?: boolean;
  team?: number | null;
  primary?: WeaponId;
}

export class Room {
  id: string;
  mode: GameMode;
  mapName: string;
  grid: Grid;
  players: Map<number, Player>;
  clients: Map<number, WebSocket>;
  events: GameEvent[];
  tick: number;
  now: number;
  state: RoomState;
  interval: NodeJS.Timeout;

  constructor(id: string, mode: GameMode, mapName: string) {
    this.id = id;
    this.mode = mode;
    this.mapName = mapName;
    this.grid = buildMap(mapName);
    this.players = new Map(); // id -> player (humans and bots)
    this.clients = new Map(); // id -> ws (humans only)
    this.events = [];
    this.tick = 0;
    this.now = Date.now();
    this.state = 'live';
    this.interval = setInterval(() => this.update(), 1000 / TICK_RATE);
  }

  destroy(): void { clearInterval(this.interval); }

  humanCount(): number { return this.clients.size; }

  event(e: GameEvent): void { this.events.push(e); }

  queueInput(p: Player, m: InputMsg): void {
    if (p.inputQueue.length < 120) p.inputQueue.push(m);
  }

  // ---- main loop ----
  update(): void {
    this.now = Date.now();
    const tickDt = 1 / TICK_RATE;

    for (const p of this.players.values()) {
      if (p.bot) {
        if (this.inputAllowed()) {
          const input = botThink(this, p, tickDt);
          input.dt = tickDt;
          p.inputQueue = [input];
        } else p.inputQueue = [];
      }
      p.inputBudget = tickDt * 1.6;
      let processed = 0;
      for (const m of p.inputQueue) {
        const dt = Math.min(Math.max(m.dt || tickDt, 0.002), 0.05, p.inputBudget);
        if (dt <= 0) { p.lastSeq = m.seq || p.lastSeq; continue; }
        p.inputBudget -= dt;
        processed += dt;
        this.applyInput(p, m, dt);
      }
      p.inputQueue = [];
      if (processed < tickDt) this.advanceTimers(p, tickDt - processed);
      if (!p.alive && p.respawnT > 0) {
        p.respawnT -= tickDt;
        if (p.respawnT <= 0) this.respawn(p);
      }
      if (p.protectT > 0) p.protectT -= tickDt;
    }

    this.modeUpdate(tickDt);
    this.tick++;
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  advanceTimers(p: Player, dt: number): void {
    if (p.fireCd > 0) p.fireCd -= dt;
    if (p.switchT > 0) p.switchT -= dt;
    p.sinceShot = (p.sinceShot || 0) + dt;
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) this.finishReload(p);
    } else if (p.sinceShot > SPREAD_DECAY_DELAY && p.spread > 0) {
      const w = weaponOf(p);
      p.spread = Math.max(0, p.spread - w.recover * dt);
    }
  }

  inputAllowed(): boolean { return this.state === 'live'; }

  applyInput(p: Player, m: InputMsg, dt: number): void {
    p.lastSeq = m.seq || p.lastSeq;
    if (!p.alive || !this.inputAllowed()) return;
    this.advanceTimers(p, dt);
    if (typeof m.aim === 'number' && isFinite(m.aim)) p.aim = m.aim;
    const keys = m.keys || {};
    const wantsMove = !!(keys.w || keys.a || keys.s || keys.d);
    const sprinting = tickSprint(p, !!m.sprint && wantsMove, dt);
    p.moving = stepMove(this.grid, p, keys, sprinting, dt);
    if (m.fire) this.tryFire(p, !p.firePrev);
    p.firePrev = !!m.fire;
  }

  // ---- weapons ----
  tryFire(p: Player, freshPress: boolean): void {
    const w = weaponOf(p);
    if (p.fireCd > 0 || p.switchT > 0 || p.reloadT > 0) return;
    if (!w.auto && !freshPress) return;
    const ammo = ammoOf(p);
    if (ammo.mag <= 0) {
      if (freshPress) this.startReload(p);
      return;
    }
    ammo.mag--;
    p.fireCd = fireIntervalMs(w) / 1000;
    p.sinceShot = 0;
    if (p.protectT > 0) p.protectT = 0; // firing drops spawn protection
    this.fireShot(p, w);
    p.spread = Math.min(p.spread + w.bloom, w.maxSpread);
  }

  effSpread(p: Player, w: Weapon): number {
    let s = w.baseSpread + p.spread;
    if (p.moving) s *= w.moveSpreadMult;
    return Math.min(s, w.maxSpread);
  }

  fireShot(p: Player, w: Weapon): void {
    const spread = this.effSpread(p, w);
    const pellets: { a: number; d: number }[] = [];
    for (let i = 0; i < w.pellets; i++) {
      const a = p.aim + (Math.random() * 2 - 1) * spread;
      const dx = Math.cos(a), dy = Math.sin(a);
      const wallDist = this.grid.raycast(p.x, p.y, dx, dy, w.range);
      let best: Target | null = null, bestT = wallDist;
      for (const tgt of this.hitscanTargets(p)) {
        const t = rayCircle(p.x, p.y, dx, dy, tgt.x, tgt.y, tgt.radius);
        if (t !== null && t < bestT) { bestT = t; best = tgt; }
      }
      pellets.push({ a: round2(a), d: Math.round(bestT) });
      if (best) {
        const dmg = damageAt(w, bestT);
        const hx = p.x + dx * bestT, hy = p.y + dy * bestT;
        this.damageTarget(best, dmg, p, w.id, hx, hy);
      }
    }
    this.event({ e: 'shot', id: p.id, x: Math.round(p.x), y: Math.round(p.y), w: w.id, p: pellets });
  }

  // Subclasses return the things this player's shots can hit.
  hitscanTargets(_p: Player): Target[] { return []; }
  // Subclasses apply damage to a target descriptor.
  damageTarget(_tgt: Target, _dmg: number, _shooter: Player, _weaponId: WeaponId, _hx: number, _hy: number): void {}

  damagePlayer(victim: Player, dmg: number, shooter: Player | null, weaponId: string, hx: number, hy: number): void {
    if (!victim.alive || victim.protectT > 0) return;
    victim.hp -= dmg;
    if (shooter) shooter.damageDealt += dmg;
    this.event({
      e: 'hit', x: Math.round(hx), y: Math.round(hy),
      sid: shooter ? shooter.id : 0, vid: victim.id, amt: Math.round(dmg), z: 0,
    });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      victim.reloadT = 0; victim.spread = 0; victim.firePrev = false;
      this.event({ e: 'die', id: victim.id, x: Math.round(victim.x), y: Math.round(victim.y), z: 0 });
      if (shooter && shooter !== victim) {
        shooter.kills++;
        this.event({ e: 'kill', k: shooter.name, v: victim.name, w: weaponId, kt: shooter.team, vt: victim.team });
      }
      this.onPlayerDeath(victim, shooter);
    }
  }

  onPlayerDeath(_victim: Player, _killer: Player | null): void {}
  modeUpdate(_dt: number): void {}
  respawn(_p: Player): void {}

  // ---- mode hooks, implemented by mode rooms ----
  // consumed by matchmaking (index.ts)
  addPlayer(_opts: AddPlayerOpts): Player | null { return null; }
  removeBot(_team?: number): boolean { return false; }
  // consumed by botThink
  botEnemies(_p: Player): Target[] { return []; }
  botGoal(_p: Player): Vec2 | null { return null; }
  botGoalReached?(p: Player): void;
  botThreat?(p: Player): Vec2 | null;

  startReload(p: Player): void {
    if (p.reloadT > 0 || p.switchT > 0 || !p.alive) return;
    const w = weaponOf(p), ammo = ammoOf(p);
    if (ammo.mag >= w.mag || ammo.reserve <= 0) return;
    p.reloadT = w.reloadMs / 1000;
    this.event({ e: 'reload', id: p.id });
  }

  finishReload(p: Player): void {
    p.reloadT = 0;
    const w = weaponOf(p), ammo = ammoOf(p);
    const need = w.mag - ammo.mag;
    const take = Math.min(need, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
  }

  trySwitch(p: Player, slot: number): void {
    if (!p.alive || slot === p.slot || slot < 0 || slot >= p.slots.length) return;
    p.slot = slot;
    p.switchT = SWITCH_MS / 1000;
    p.reloadT = 0;
    p.spread = 0;
  }

  spawnAt(p: Player, spot: Vec2): void {
    p.x = spot.x; p.y = spot.y;
    p.hp = PLAYER_HP;
    p.alive = true;
    p.fireCd = 0; p.reloadT = 0; p.switchT = 0; p.spread = 0;
    p.respawnT = 0;
    p.stamina = STAMINA_MAX; p.sprinting = false;
  }

  // Pick the spawn point maximizing distance to the nearest hostile.
  bestSpawn(spots: Vec2[], hostiles: Vec2[]): Vec2 {
    let best = spots[0], bestScore = -1;
    for (const s of spots) {
      let nearest = Infinity;
      for (const h of hostiles) nearest = Math.min(nearest, dist(s, h));
      const score = nearest + Math.random() * 40;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // ---- networking ----
  playerSnapshot(): PlayerSnap[] {
    const out: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      out.push({
        id: p.id, name: p.name, team: p.team, bot: p.bot ? 1 : 0,
        x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
        aim: round2(p.aim), hp: Math.round(p.hp), alive: p.alive ? 1 : 0,
        w: p.slots[p.slot], rld: p.reloadT > 0 ? 1 : 0,
        k: p.kills, d: p.deaths, prot: p.protectT > 0 ? 1 : 0,
        spr: round2(this.effSpread(p, weaponOf(p))),
      });
    }
    return out;
  }

  modeSnapshot(): object { return {}; }

  broadcast(): void {
    const base: SnapshotBase & Record<string, unknown> = {
      t: 'snap', tick: this.tick, now: this.now, state: this.state,
      players: this.playerSnapshot(), events: this.events,
      ...this.modeSnapshot(),
    };
    for (const [id, ws] of this.clients) {
      const p = this.players.get(id);
      if (!p) continue;
      base.ack = p.lastSeq;
      base.self = {
        slot: p.slot, slots: p.slots,
        ammo: p.slots.map(wid => p.ammo[wid]!),
        reloadT: Math.max(0, round2(p.reloadT)),
        reloadTotal: WEAPONS[p.slots[p.slot]].reloadMs / 1000,
        points: p.points, respawnT: Math.max(0, round2(p.respawnT)),
        stam: round2(p.stamina), spg: p.sprinting ? 1 : 0,
      };
      try { ws.send(JSON.stringify(base)); } catch { /* dropped below via close handler */ }
    }
    this.events = [];
  }

  sendTo(p: Player, obj: object): void {
    const ws = this.clients.get(p.id);
    if (ws) { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } }
  }
}

function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const mx = cx - ox, my = cy - oy;
  const t = mx * dx + my * dy;
  if (t < 0) return null;
  const closestSq = mx * mx + my * my - t * t;
  if (closestSq > r * r) return null;
  const back = Math.sqrt(r * r - closestSq);
  const hit = t - back;
  return hit >= 0 ? hit : 0;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
