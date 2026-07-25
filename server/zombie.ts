import { Room, type AddPlayerOpts, type Target } from './room.ts';
import { createPlayer, refillAmmo, createZombie, setPrimary, makeAmmo, type Player, type Zombie } from './entities.ts';
import { createBotController, nextBotName } from './bot.ts';
import { findPath } from './pathfinding.ts';
import { dist, stepToward, resolveCircleAxis } from '../shared/physics.ts';
import {
  TEAM, PLAYER_RADIUS, PLAYER_HP, WAVE_BREAK_MS, MAX_ZOMBIES_ALIVE,
  MAX_SURVIVORS, MATCH_RESTART_MS, SHOP, ZOMBIE_KILL_POINTS, SPAWN_PROTECT_MS,
  type ShopItemId,
} from '../shared/constants.ts';
import type { WeaponId } from '../shared/weapons.ts';
import type { Vec2, ZombieModeState, ZombieSnap, ZombieTypeId } from '../shared/types.ts';

const START_POINTS = 400;
const BOT_BUY_ORDER: WeaponId[] = ['smg', 'rifle', 'sniper'];
const CHECKPOINT_EVERY = 5; // reaching wave 5/10/15… records a checkpoint
const CHECKPOINT_MAX = 995;

// Starting cash for a run that begins at wave `cp`: base cash plus the
// wave-clear bonuses of every skipped wave (kill income counts as "spent").
export function checkpointPoints(cp: number): number {
  let pts = START_POINTS;
  for (let w = 1; w < cp; w++) pts += 100 + 25 * w;
  return pts;
}

export class ZombieRoom extends Room {
  declare mode: 'zombie';
  wave: number;
  zombies: Map<number, Zombie>;
  toSpawn: ZombieTypeId[];
  spawnT: number;
  breakT: number;
  restartT: number;
  waveAge: number;
  frenzyAnnounced: boolean;
  checkpoint: number;

  constructor(id: string) {
    super(id, 'zombie', 'outbreak');
    this.wave = 0;
    this.checkpoint = 0;
    this.zombies = new Map();
    this.toSpawn = [];
    this.spawnT = 0;
    this.state = 'break';
    this.breakT = WAVE_BREAK_MS / 1000;
    this.restartT = 0;
    this.waveAge = 0;
    this.frenzyAnnounced = false;
  }

  // Stragglers can't be kited forever: once a wave is nearly done (or drags on),
  // remaining zombies ramp up to faster-than-walking speed so survivors must
  // burn sprint stamina or turn and fight.
  frenzyActive(): boolean {
    if (this.state !== 'wave') return false;
    const remaining = this.toSpawn.length + this.zombies.size;
    return remaining <= 3 || this.waveAge > 75;
  }

  frenzySpeed(z: Zombie): number {
    if (z.type === 'brute') return Math.max(z.speed, 150);
    if (z.type === 'runner') return Math.max(z.speed, 215);
    return Math.max(z.speed, 195);
  }

  override addPlayer({ name, bot = false }: AddPlayerOpts): Player | null {
    if (this.players.size >= MAX_SURVIVORS) {
      if (!bot) {
        // kick the newest bot to make room for a human
        let newest: Player | null = null;
        for (const q of this.players.values()) {
          if (q.bot && (!newest || q.joinedAt > newest.joinedAt)) newest = q;
        }
        if (!newest) return null;
        this.players.delete(newest.id);
        this.event({ e: 'leave', name: newest.name });
      } else return null;
    }
    const p = createPlayer({ name, team: TEAM.SURVIVOR, bot, primary: 'pistol' });
    p.slots = ['pistol'];
    p.ammo = { pistol: makeAmmo('pistol') };
    p.slot = 0;
    p.points = checkpointPoints(this.wave); // wave-appropriate cash for mid-run joiners
    if (bot) p.botCtl = createBotController();
    this.players.set(p.id, p);
    this.spawnAt(p, this.grid.survivorSpawns[this.players.size % this.grid.survivorSpawns.length]);
    p.protectT = SPAWN_PROTECT_MS / 1000;
    this.event({ e: 'join', name: p.name, team: TEAM.SURVIVOR });
    return p;
  }

  // One squad, so `botTarget` is the whole roster: "2 squadmates" is a target
  // of 3, and three humans in the room means no bots at all. addPlayer returns
  // null at MAX_SURVIVORS, which is what stops the loop.
  override fillBots(): void {
    while (this.players.size < this.botTarget) {
      if (!this.addPlayer({ name: nextBotName(), bot: true })) break;
    }
  }

  override removeBot(): boolean {
    let newest: Player | null = null;
    for (const q of this.players.values()) {
      if (q.bot && (!newest || q.joinedAt > newest.joinedAt)) newest = q;
    }
    if (newest) {
      this.players.delete(newest.id);
      this.event({ e: 'leave', name: newest.name });
      return true;
    }
    return false;
  }

  override inputAllowed(): boolean { return this.state === 'break' || this.state === 'wave'; }

  // Arm a saved checkpoint from a joining client. Only honored while the room
  // is still fresh (first human, nothing started) so a later joiner can't
  // yank an in-progress run to a different wave. Wire input: validate hard.
  applyCheckpoint(raw: unknown): void {
    let humans = 0;
    for (const p of this.players.values()) if (!p.bot) humans++;
    if (humans !== 1 || this.wave !== 0 || this.state !== 'break') return;
    const n = Math.floor(Number(raw) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    if (!Number.isFinite(n) || n < CHECKPOINT_EVERY) return;
    this.checkpoint = Math.min(n, CHECKPOINT_MAX);
    this.wave = this.checkpoint - 1; // break ends -> startWave(checkpoint)
    for (const p of this.players.values()) p.points = checkpointPoints(this.checkpoint);
  }

  // ---- shop ----
  buy(p: Player, item: string): void {
    if (!Object.hasOwn(SHOP, item)) return;
    const key = item as ShopItemId;
    const entry = SHOP[key];
    if (!p.alive || p.points < entry.cost) return;
    if (key === 'ammo') {
      refillAmmo(p);
    } else if (key === 'health') {
      if (p.hp >= PLAYER_HP) return;
      p.hp = PLAYER_HP;
    } else {
      if (p.slots.includes(key)) return;
      if (p.slots.length === 1) p.slots.push(key);
      setPrimary(p, key);
    }
    p.points -= entry.cost;
    this.event({ e: 'buy', id: p.id, item: key });
  }

  // ---- waves ----
  compose(wave: number): ZombieTypeId[] {
    const alive = Math.max(1, this.players.size);
    const mult = 0.7 + 0.3 * alive;
    const queue: ZombieTypeId[] = [];
    const walkers = Math.round((6 + 3 * wave) * mult);
    const runners = wave >= 2 ? Math.min(14, Math.round(2 * (wave - 1) * mult)) : 0;
    const brutes = wave >= 4 ? Math.min(6, Math.floor((wave - 2) / 2)) : 0;
    for (let i = 0; i < walkers; i++) queue.push('walker');
    for (let i = 0; i < runners; i++) queue.push('runner');
    for (let i = 0; i < brutes; i++) queue.push('brute');
    // shuffle
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  startWave(n: number): void {
    this.wave = n;
    if (n % CHECKPOINT_EVERY === 0 && n > this.checkpoint) this.checkpoint = n;
    this.toSpawn = this.compose(n);
    this.spawnT = 0;
    this.state = 'wave';
    this.waveAge = 0;
    this.frenzyAnnounced = false;
    this.event({ e: 'wave', n, count: this.toSpawn.length });
  }

  endWave(): void {
    const bonus = 100 + 25 * this.wave;
    for (const p of this.players.values()) {
      p.points += bonus;
      if (!p.alive) {
        this.spawnAt(p, this.bestSpawn(this.grid.survivorSpawns, []));
        p.protectT = SPAWN_PROTECT_MS / 1000;
        this.event({ e: 'revive', id: p.id });
      }
      if (p.bot) this.botBuy(p);
    }
    this.state = 'break';
    this.breakT = WAVE_BREAK_MS / 1000;
    this.event({ e: 'break', next: this.wave + 1, bonus });
  }

  botBuy(p: Player): void {
    if (p.hp < 55 && p.points >= SHOP.health.cost) { this.buy(p, 'health'); }
    const cur = p.slots[p.slots.length - 1];
    const idx = BOT_BUY_ORDER.indexOf(cur);
    const next = BOT_BUY_ORDER[idx + 1] || (cur === 'pistol' ? 'smg' : null);
    const target = cur === 'pistol' ? 'smg' : next;
    if (target && p.points >= SHOP[target as ShopItemId].cost + 150) this.buy(p, target);
    const ammo = p.ammo[p.slots[p.slots.length - 1]]!;
    const low = ammo.reserve < 20;
    if (low && p.points >= SHOP.ammo.cost) this.buy(p, 'ammo');
  }

  // ---- zombies ----
  hpMult(): number { return Math.min(2.4, 1 + 0.08 * (this.wave - 1)); }

  spawnZombie(type: ZombieTypeId): void {
    const spots = this.grid.zombieSpawns;
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const z = createZombie(type, spot.x + (Math.random() * 40 - 20), spot.y + (Math.random() * 40 - 20));
    z.hp = Math.round(z.hp * this.hpMult());
    z.maxHp = z.hp;
    this.zombies.set(z.id, z);
  }

  damageZombie(z: Zombie, dmg: number, shooter: Player | null, hx: number, hy: number): void {
    z.hp -= dmg;
    if (shooter) shooter.damageDealt += dmg;
    this.event({ e: 'hit', x: Math.round(hx), y: Math.round(hy), sid: shooter ? shooter.id : 0, vid: z.id, amt: Math.round(dmg), z: 1 });
    if (z.hp <= 0) {
      this.zombies.delete(z.id);
      if (shooter) {
        shooter.kills++;
        shooter.points += ZOMBIE_KILL_POINTS[z.type] || 10;
      }
      this.event({ e: 'zdie', x: Math.round(z.x), y: Math.round(z.y), type: z.type });
    }
  }

  override hitscanTargets(_p: Player): Target[] {
    const out: Target[] = [];
    for (const z of this.zombies.values()) {
      out.push({ id: z.id, x: z.x, y: z.y, radius: z.radius, kind: 'zombie', ref: z });
    }
    return out;
  }

  override damageTarget(tgt: Target, dmg: number, shooter: Player, _weaponId: string, hx: number, hy: number): void {
    if (tgt.kind !== 'zombie') return;
    this.damageZombie(tgt.ref, dmg, shooter, hx, hy);
  }

  override onPlayerDeath(victim: Player, _killer: Player | null): void {
    victim.respawnT = 0; // dead until wave ends
    let anyAlive = false;
    for (const p of this.players.values()) if (p.alive) anyAlive = true;
    if (!anyAlive && this.state !== 'over') {
      this.state = 'over';
      this.restartT = MATCH_RESTART_MS / 1000;
      this.event({ e: 'over', wave: this.wave });
    }
  }

  resetGame(): void {
    this.zombies.clear();
    this.toSpawn = [];
    this.wave = this.checkpoint > 0 ? this.checkpoint - 1 : 0; // resume at the checkpoint wave
    for (const p of this.players.values()) {
      p.slots = ['pistol'];
      p.ammo = { pistol: makeAmmo('pistol') };
      p.slot = 0;
      p.points = checkpointPoints(this.checkpoint);
      p.kills = 0; p.deaths = 0; p.damageDealt = 0;
      this.spawnAt(p, this.bestSpawn(this.grid.survivorSpawns, []));
      p.protectT = SPAWN_PROTECT_MS / 1000;
    }
    this.state = 'break';
    this.breakT = WAVE_BREAK_MS / 1000;
    this.event({ e: 'matchstart' });
  }

  override modeUpdate(dt: number): void {
    if (this.state === 'break') {
      this.breakT -= dt;
      if (this.breakT <= 0 && this.players.size > 0) this.startWave(this.wave + 1);
      this.updateZombies(dt); // stragglers (none normally)
    } else if (this.state === 'wave') {
      this.waveAge += dt;
      this.spawnT -= dt;
      if (this.toSpawn.length && this.zombies.size < MAX_ZOMBIES_ALIVE && this.spawnT <= 0) {
        this.spawnZombie(this.toSpawn.pop()!);
        this.spawnT = 0.35;
      }
      this.updateZombies(dt);
      if (!this.toSpawn.length && this.zombies.size === 0) this.endWave();
    } else if (this.state === 'over') {
      this.restartT -= dt;
      this.updateZombies(dt);
      if (this.restartT <= 0) this.resetGame();
    }
  }

  updateZombies(dt: number): void {
    const alivePlayers = [...this.players.values()].filter(p => p.alive);
    const frenzyOn = this.frenzyActive();
    if (frenzyOn && !this.frenzyAnnounced && this.zombies.size > 0) {
      this.frenzyAnnounced = true;
      this.event({ e: 'frenzy' });
    }
    for (const z of this.zombies.values()) {
      z.attackCd -= dt;
      // frenzy ramps in over ~6s, fades if a new batch spawns
      z.frenzy = Math.max(0, Math.min(1, (z.frenzy || 0) + (frenzyOn ? dt / 6 : -dt / 3)));
      z.effSpeed = z.speed + (this.frenzySpeed(z) - z.speed) * z.frenzy;
      if (!alivePlayers.length) continue;
      let target: Player | null = null, td = Infinity;
      for (const p of alivePlayers) {
        const d = dist(z, p);
        if (d < td) { td = d; target = p; }
      }
      if (!target) continue;
      z.aim = Math.atan2(target.y - z.y, target.x - z.x);
      const reach = z.radius + PLAYER_RADIUS + 8;
      if (td <= reach) {
        if (z.attackCd <= 0 && this.state !== 'over') {
          z.attackCd = z.attackMs / 1000;
          this.damagePlayer(target, z.damage, null, 'claws', target.x, target.y);
        }
        continue;
      }
      if (td < 650 && this.grid.los(z.x, z.y, target.x, target.y)) {
        stepToward(this.grid, z, target.x, target.y, z.effSpeed, dt, z.radius);
        z.path = null;
      } else {
        z.pathT -= dt;
        if (!z.path || !z.path.length || z.pathT <= 0 || z.targetId !== target.id) {
          z.path = findPath(this.grid, z.x, z.y, target.x, target.y, z.radius);
          z.pathT = 0.7 + Math.random() * 0.5;
          z.targetId = target.id;
        }
        if (z.path && z.path.length) {
          while (z.path.length && dist(z, z.path[0]) < 24) z.path.shift();
          const wp = z.path[0];
          if (wp) stepToward(this.grid, z, wp.x, wp.y, z.effSpeed, dt, z.radius);
        }
      }
    }
    // pairwise separation so zombies don't stack
    const zs = [...this.zombies.values()];
    for (let i = 0; i < zs.length; i++) {
      for (let j = i + 1; j < zs.length; j++) {
        const a = zs[i], b = zs[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy), min = a.radius + b.radius - 4;
        if (d > 0.01 && d < min) {
          const push = (min - d) / 2;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }
    for (const z of zs) {
      z.x = resolveCircleAxis(this.grid, z.x, z.y, z.radius, 'x');
      z.y = resolveCircleAxis(this.grid, z.x, z.y, z.radius, 'y');
    }
  }

  // ---- bot hooks ----
  override botEnemies(_p: Player): Target[] { return this.hitscanTargets(_p); }

  override botThreat(p: Player): Zombie | null {
    let best: Zombie | null = null, bd = 185;
    for (const z of this.zombies.values()) {
      const d = dist(p, z);
      if (d < bd) { bd = d; best = z; }
    }
    return best;
  }

  override botGoal(p: Player): Vec2 {
    if (this.state === 'wave' || this.state === 'over') {
      let best: Zombie | null = null, bd = Infinity;
      for (const z of this.zombies.values()) {
        const d = dist(p, z);
        if (d < bd) { bd = d; best = z; }
      }
      if (best) return { x: best.x, y: best.y };
    }
    // regroup at the compound during breaks
    const c = this.grid.survivorSpawns[p.id % this.grid.survivorSpawns.length];
    return c;
  }

  zombieSnapshot(): ZombieSnap[] {
    const out: ZombieSnap[] = [];
    for (const z of this.zombies.values()) {
      out.push({
        id: z.id, x: Math.round(z.x * 10) / 10, y: Math.round(z.y * 10) / 10,
        hp: Math.round(z.hp), maxHp: z.maxHp, type: z.type, aim: Math.round(z.aim * 100) / 100,
        fr: (z.frenzy || 0) > 0.4 ? 1 : 0,
      });
    }
    return out;
  }

  override modeSnapshot(): ZombieModeState {
    return {
      mode: 'zombie', wave: this.wave,
      zombies: this.zombieSnapshot(),
      left: this.toSpawn.length + this.zombies.size,
      breakT: this.state === 'break' ? Math.ceil(this.breakT) : 0,
      restartT: this.state === 'over' ? Math.ceil(this.restartT) : 0,
      cp: this.checkpoint,
    };
  }
}
