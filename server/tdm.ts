import { Room, type AddPlayerOpts, type Target } from './room.ts';
import { createPlayer, refillAmmo, type Player } from './entities.ts';
import { createBotController, nextBotName } from './bot.ts';
import { T_FLOOR } from '../shared/maps.ts';
import { PRIMARIES } from '../shared/weapons.ts';
import {
  TEAM, TILE, PLAYER_RADIUS, RESPAWN_MS, SPAWN_PROTECT_MS,
  TDM_SCORE_LIMIT, TDM_TIME_LIMIT_MS, MATCH_RESTART_MS, MAX_TEAM_SIZE,
} from '../shared/constants.ts';
import type { TdmModeState, Vec2 } from '../shared/types.ts';

export class TDMRoom extends Room {
  declare mode: 'tdm';
  scores: number[];
  matchEndAt: number;
  restartT: number;
  openLeft: Vec2[];
  openRight: Vec2[];

  constructor(id: string) {
    super(id, 'tdm', 'compound');
    this.scores = [0, 0];
    this.matchEndAt = this.now + TDM_TIME_LIMIT_MS;
    this.restartT = 0;
    // open tiles per half, for bot roaming
    this.openLeft = []; this.openRight = [];
    for (let ty = 1; ty < this.grid.h - 1; ty++) {
      for (let tx = 1; tx < this.grid.w - 1; tx++) {
        if (this.grid.get(tx, ty) !== T_FLOOR) continue;
        const pt = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
        (tx < this.grid.w / 2 ? this.openLeft : this.openRight).push(pt);
      }
    }
  }

  teamCount(team: number): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  pickTeam(): number {
    const r = this.teamCount(TEAM.RED), b = this.teamCount(TEAM.BLUE);
    if (r === b) return Math.random() < 0.5 ? TEAM.RED : TEAM.BLUE;
    return r < b ? TEAM.RED : TEAM.BLUE;
  }

  // Make room for a human on `team` by kicking its newest bot, if needed.
  evictBotIfFull(team: number): boolean {
    if (this.teamCount(team) < MAX_TEAM_SIZE) return true;
    let newest: Player | null = null;
    for (const p of this.players.values()) {
      if (p.team === team && p.bot && (!newest || p.joinedAt > newest.joinedAt)) newest = p;
    }
    if (!newest) return false;
    this.players.delete(newest.id);
    this.event({ e: 'leave', name: newest.name });
    return true;
  }

  override addPlayer({ name, bot = false, team = null, primary = 'rifle' }: AddPlayerOpts): Player | null {
    if (team === null) team = this.pickTeam();
    if (this.teamCount(team) >= MAX_TEAM_SIZE) {
      const other = team === TEAM.RED ? TEAM.BLUE : TEAM.RED;
      if (!bot && this.evictBotIfFull(team)) { /* freed a slot */ }
      else if (this.teamCount(other) < MAX_TEAM_SIZE) team = other;
      else return null;
    }
    const p = createPlayer({ name, team, bot, primary });
    if (bot) p.botCtl = createBotController();
    this.players.set(p.id, p);
    this.respawn(p);
    this.event({ e: 'join', name: p.name, team });
    return p;
  }

  // `botTarget` counts players per team here, so it reads as the match you
  // asked for ("5v5") rather than a bot headcount. The addPlayer guard is not
  // decoration: it returns null once a team is full, and without breaking on
  // it a target above MAX_TEAM_SIZE would spin forever.
  override fillBots(): void {
    for (const team of [TEAM.RED, TEAM.BLUE]) {
      while (this.teamCount(team) < this.botTarget) {
        const added = this.addPlayer({
          name: nextBotName(), bot: true, team,
          primary: PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)],
        });
        if (!added) break;
      }
    }
  }

  override removeBot(team?: number): boolean {
    let newest: Player | null = null;
    for (const p of this.players.values()) {
      if (p.team === team && p.bot && (!newest || p.joinedAt > newest.joinedAt)) newest = p;
    }
    if (newest) {
      this.players.delete(newest.id);
      this.event({ e: 'leave', name: newest.name });
      return true;
    }
    return false;
  }

  override respawn(p: Player): void {
    const spots = p.team === TEAM.RED ? this.grid.redSpawns : this.grid.blueSpawns;
    const enemies = [...this.players.values()].filter(q => q.team !== p.team && q.alive);
    this.spawnAt(p, this.bestSpawn(spots, enemies));
    refillAmmo(p);
    p.protectT = SPAWN_PROTECT_MS / 1000;
  }

  override hitscanTargets(p: Player): Target[] {
    const out: Target[] = [];
    for (const q of this.players.values()) {
      if (q.team === p.team || !q.alive || q.protectT > 0) continue;
      out.push({ id: q.id, x: q.x, y: q.y, radius: PLAYER_RADIUS, kind: 'player', ref: q });
    }
    return out;
  }

  override damageTarget(tgt: Target, dmg: number, shooter: Player, weaponId: string, hx: number, hy: number): void {
    if (tgt.kind !== 'player') return;
    this.damagePlayer(tgt.ref, dmg, shooter, weaponId, hx, hy);
  }

  override onPlayerDeath(victim: Player, killer: Player | null): void {
    victim.respawnT = RESPAWN_MS / 1000;
    if (killer && killer.team !== victim.team) {
      this.scores[killer.team]++;
      if (this.state === 'live' && this.scores[killer.team] >= TDM_SCORE_LIMIT) {
        this.endMatch(killer.team);
      }
    }
  }

  override modeUpdate(_dt: number): void {
    if (this.state === 'live') {
      if (this.now >= this.matchEndAt) {
        const [r, b] = this.scores;
        this.endMatch(r === b ? -1 : (r > b ? TEAM.RED : TEAM.BLUE));
      }
    } else if (this.state === 'over') {
      this.restartT -= _dt;
      if (this.restartT <= 0) this.resetMatch();
    }
  }

  endMatch(winner: number): void {
    this.state = 'over';
    this.restartT = MATCH_RESTART_MS / 1000;
    this.event({ e: 'matchend', winner });
  }

  resetMatch(): void {
    this.scores = [0, 0];
    this.matchEndAt = this.now + TDM_TIME_LIMIT_MS;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.damageDealt = 0;
      this.respawn(p);
    }
    this.state = 'live';
    this.event({ e: 'matchstart' });
  }

  // ---- bot hooks ----
  override botEnemies(p: Player): Target[] {
    return this.hitscanTargets(p);
  }

  override botGoal(p: Player): Vec2 | null {
    const c = p.botCtl!;
    if (!c.goal) {
      const pool = p.team === TEAM.RED ? this.openRight : this.openLeft;
      c.goal = pool[Math.floor(Math.random() * pool.length)];
    }
    return c.goal;
  }

  override botGoalReached(p: Player): void { p.botCtl!.goal = null; }

  override modeSnapshot(): TdmModeState {
    return {
      mode: 'tdm', scores: this.scores,
      timeLeft: Math.max(0, Math.round((this.matchEndAt - this.now) / 1000)),
      restartT: this.state === 'over' ? Math.round(this.restartT) : 0,
    };
  }
}
