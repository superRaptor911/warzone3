import { buildMap, type Grid } from '../shared/maps.ts';
import { stepMove, tickSprint, dist } from '../shared/physics.ts';
import { castPellet } from '../shared/hitscan.ts';
import { WEAPONS, fireIntervalMs, damageAt, type Weapon, type WeaponId } from '../shared/weapons.ts';
import {
  TICK_RATE, SNAPSHOT_EVERY, PLAYER_HP, SWITCH_MS, STAMINA_MAX,
} from '../shared/constants.ts';
import { weaponOf, ammoOf, type Player, type Zombie } from './entities.ts';
import { addStats } from './db.ts';
import { botThink } from './bot.ts';
import type {
  GameEvent, GameMode, InputMsg, PlayerSnap, RoomState, SnapshotBase, Vec2, ZombieSnap,
} from '../shared/types.ts';
import type { WebSocket } from 'ws';

const SPREAD_DECAY_DELAY = 0.25; // s since last shot before bloom recovers
// How much stalled input may bank up waiting for a tick to simulate it. Bounds
// how far behind realtime a recovering client can drag its own simulation.
const MAX_BACKLOG = 0.3; // s

// One input message's worth of simulated time, clamped against garbage and
// speedhacks. Also applied to the remainder left on a partially-drained input.
function clampInputDt(dt: number | undefined, tickDt: number): number {
  return Math.min(Math.max(dt || tickDt, 0.002), 0.05);
}

// Lag compensation. How far back a client may ask the server to rewind before
// resolving its shots.
//
// Size this against the shooter's whole *view age*, not their ping: a client
// reports renderTime(), which already trails the server by RTT plus
// INTERP_DELAY_MS, and the resolving tick adds up to another 33ms. So a
// 250ms-RTT player needs ~400ms, not 250ms — a cap set to the RTT alone leaves
// them still leading by most of a body width. 400ms covers 200-250ms RTT fully
// and 300ms to within ~10px.
//
// The cost is symmetrical: a victim can be damaged up to this long after
// reaching cover. This constant is the shooter/victim fairness dial.
// Raising it further requires raising HISTORY_FRAMES to match.
const MAX_REWIND_MS = 400;
// Depth of the broadcast-position history, in snapshots (15Hz). Must comfortably
// exceed MAX_REWIND_MS; ~800ms leaves room for a larger interpolation buffer.
const HISTORY_FRAMES = 12;

interface HistoryFrame { t: number; pos: Map<number, Vec2> }

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
  history: HistoryFrame[];
  interval: NodeJS.Timeout;
  /**
   * Roster the room's creator asked for, held so it can be restored later.
   * Set once, when the joining human is the one who created the room; every
   * later joiner inherits the room as it stands. Meaning is per mode — a
   * per-team target in TDM, a total squad size in zombie — because those are
   * the units each mode's `fillBots` counts in.
   */
  botTarget: number;

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
    this.history = [];
    this.botTarget = 0;
    this.interval = setInterval(() => this.update(), 1000 / TICK_RATE);
  }

  destroy(): void { clearInterval(this.interval); }

  humanCount(): number { return this.clients.size; }

  /**
   * Bank this player's kills/deaths into their persistent profile.
   *
   * Called at the two moments the in-memory counters stop being readable: match
   * end (the reset zeroes them) and departure (`leaveRoom` deletes the player).
   * What makes both calls safe is that it writes a **delta** — `banked*` records
   * what is already in the database, so flushing twice adds nothing.
   *
   * A no-op without a `profileId`, which is what keeps bots free and keeps
   * directly-constructed rooms (test/matchflow.ts) from opening a database.
   */
  flushStats(p: Player): void {
    if (!p.profileId) return;
    const k = p.kills - p.bankedKills;
    const d = p.deaths - p.bankedDeaths;
    if (k <= 0 && d <= 0) return;
    addStats(p.profileId, this.mode, k, d);
    p.bankedKills = p.kills;
    p.bankedDeaths = p.deaths;
  }

  /**
   * Flush everyone, then forget what was banked — for the match resets, which
   * zero `kills`/`deaths` immediately afterwards and would otherwise leave the
   * banked marks pointing above the counters, swallowing the next match.
   */
  flushAndClearStats(): void {
    for (const p of this.players.values()) {
      this.flushStats(p);
      p.bankedKills = 0;
      p.bankedDeaths = 0;
    }
  }

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
      // Drain at most 1.6x the tick's own duration (anti-speedhack), but bank
      // the rest for the next tick rather than dropping it: a client whose
      // packets were delayed flushes its whole stall at once, and discarding
      // the tail desyncs its prediction into a visible snap. An input that
      // does not fit whole is simulated up to the budget and its remainder
      // left on the queue, so the drain rate is exactly 1.6x regardless of the
      // client's frame time.
      p.inputBudget = tickDt * 1.6;
      let processed = 0;
      while (p.inputQueue.length && p.inputBudget > 0) {
        const m = p.inputQueue[0];
        const want = clampInputDt(m.dt, tickDt);
        const dt = Math.min(want, p.inputBudget);
        p.inputBudget -= dt;
        processed += dt;
        this.applyInput(p, m, dt);
        if (want - dt > 0.001) { m.dt = want - dt; break; } // finish it next tick
        p.lastSeq = m.seq || p.lastSeq;
        p.inputQueue.shift();
      }
      this.trimBacklog(p, tickDt);
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

  // Cap the banked backlog, dropping the stalest inputs first. They are acked
  // on the way out: seq is monotonic, so the client drops them from `pending`
  // and reconciles to the server position instead of replaying them forever.
  trimBacklog(p: Player, tickDt: number): void {
    let banked = 0;
    for (const m of p.inputQueue) banked += clampInputDt(m.dt, tickDt);
    while (p.inputQueue.length && banked > MAX_BACKLOG) {
      const m = p.inputQueue.shift()!;
      banked -= clampInputDt(m.dt, tickDt);
      p.lastSeq = m.seq || p.lastSeq;
    }
  }

  // ---- lag compensation ----
  // Positions exactly as they were broadcast, so a shot can be resolved against
  // the world the shooter's client was actually rendering. Recorded on
  // broadcast rather than per tick, and from the rounded snapshot values, so a
  // rewind reproduces the client's view instead of approximating it.
  recordHistory(snap: SnapshotBase & Record<string, unknown>): void {
    const pos = new Map<number, Vec2>();
    for (const s of snap.players) pos.set(s.id, { x: s.x, y: s.y });
    // Zombies only exist on ZombieRoom's snapshot. Reading them off the built
    // object keeps this in one place, instead of a per-mode override that a
    // future mode could silently forget to implement.
    const zs = snap.zombies as ZombieSnap[] | undefined;
    if (zs) for (const z of zs) pos.set(z.id, { x: z.x, y: z.y });
    this.history.push({ t: this.now, pos });
    if (this.history.length > HISTORY_FRAMES) this.history.shift();
  }

  // Interpolated positions at a past instant, or null if that instant is not in
  // the buffer's past. Mirrors the client's own snapshot interpolation, which is
  // what makes the reconstruction match what the shooter saw.
  rewindFrame(atTime: number): Map<number, Vec2> | null {
    const h = this.history;
    let bi = -1;
    for (let i = 1; i < h.length; i++) if (h[i].t >= atTime) { bi = i; break; }
    if (bi < 0) return null;
    const a = h[bi - 1], b = h[bi];
    if (atTime <= a.t) return a.pos; // older than the buffer — clamp to oldest
    const span = b.t - a.t;
    const f = span > 0 ? (atTime - a.t) / span : 0;
    const out = new Map<number, Vec2>();
    for (const [id, pa] of a.pos) {
      const pb = b.pos.get(id);
      out.set(id, pb ? { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f } : pa);
    }
    return out;
  }

  // The frame this player's shots resolve against: their reported render time,
  // clamped to MAX_REWIND_MS. Bots report nothing and get no rewind, which is
  // right — they are server-side and have no view lag.
  rewindFrameFor(p: Player): Map<number, Vec2> | null {
    if (!p.lastRt) return null;
    const lag = Math.min(this.now - p.lastRt, MAX_REWIND_MS);
    if (lag <= 0) return null;
    return this.rewindFrame(this.now - lag);
  }

  // Rewinds position only. Membership, liveness and spawn protection stay
  // present-time, so a target killed by an earlier pellet cannot be hit again,
  // and `ref` still points at the live entity for damageTarget.
  rewindTargets(targets: Target[], frame: Map<number, Vec2> | null): void {
    if (!frame) return;
    for (const t of targets) {
      const at = frame.get(t.id);
      if (at) { t.x = at.x; t.y = at.y; }
    }
  }

  inputAllowed(): boolean { return this.state === 'live'; }

  // Note: acking (p.lastSeq) happens in the drain loop, not here — a partially
  // simulated input must not be acked until its remainder has been applied.
  applyInput(p: Player, m: InputMsg, dt: number): void {
    if (!p.alive || !this.inputAllowed()) return;
    this.advanceTimers(p, dt);
    if (typeof m.aim === 'number' && isFinite(m.aim)) p.aim = m.aim;
    if (typeof m.rt === 'number' && isFinite(m.rt)) p.lastRt = m.rt;
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
    const rewind = this.rewindFrameFor(p); // resolved once; same view for every pellet
    const pellets: { a: number; d: number }[] = [];
    for (let i = 0; i < w.pellets; i++) {
      const a = p.aim + (Math.random() * 2 - 1) * spread;
      const dx = Math.cos(a), dy = Math.sin(a);
      // Rebuilt per pellet on purpose: an earlier pellet may have killed a
      // target, and a stale entry would be damaged (and credited) twice.
      const targets = this.hitscanTargets(p);
      this.rewindTargets(targets, rewind);
      const { dist: endDist, hits } = castPellet(this.grid, p.x, p.y, dx, dy, w.range, targets, w.pierce);
      pellets.push({ a: round2(a), d: Math.round(endDist) });
      // Each body along the ray is a distinct target, so damaging them in
      // order can't re-enter the no-dead-guard path within one pellet; falloff
      // uses each body's own hit distance, pierce decay stacks on top.
      for (let b = 0; b < hits.length; b++) {
        const { tgt, dist: hd } = hits[b];
        const dmg = damageAt(w, hd) * Math.pow(w.pierceMult, b);
        this.damageTarget(tgt, dmg, p, w.id, p.x + dx * hd, p.y + dy * hd);
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
  /**
   * Top the roster back up to `botTarget` with bots. Called when the room is
   * created and again whenever a human leaves — a human joining a full team
   * evicts a bot, so without the second call the roster only ever decays.
   * Never removes anyone: a room with more players than the target is a room
   * humans filled, which is the outcome the target was standing in for.
   */
  fillBots(): void {}
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
    // Bots never spend reserve, so they reload forever but never dry out. This
    // is the whole of "infinite bot ammo": the mag still empties and the reload
    // still takes reloadMs, so nothing about how a bot fights changes — only
    // that it cannot end up standing in a firefight with an empty gun, which is
    // a state no human ever has to accept (they can walk to a crate or a shop).
    // Gated on p.bot rather than a flag: being a bot *is* the reason, and a
    // flag is one edit away from being handed to a human. Ammo only ships in
    // the per-client `self` block, so this is invisible on the wire.
    if (!p.bot) ammo.reserve -= take;
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
    this.recordHistory(base);
    for (const [id, ws] of this.clients) {
      const p = this.players.get(id);
      if (!p) continue;
      base.ack = p.lastSeq;
      base.self = {
        slot: p.slot, slots: p.slots,
        ammo: p.slots.map(wid => p.ammo[wid]!),
        reloadT: Math.max(0, round2(p.reloadT)),
        reloadTotal: WEAPONS[p.slots[p.slot]].reloadMs / 1000,
        sw: Math.max(0, round2(p.switchT)),
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

function round2(v: number): number { return Math.round(v * 100) / 100; }
