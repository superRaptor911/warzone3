import { Container, Sprite, Text } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { PLAYER_RADIUS, TEAM } from '../../../shared/constants.ts';
import type { PlayerSnap, ZombieSnap } from '../../../shared/types.ts';
import { DISC_R, GfxTextures, TEAM_COLORS, ZTYPE, gunKey, ringKey } from './textures.ts';

// Stage layer tree. Order is load-bearing (encodes the old painter's order):
// world (lit, phase 2 darkens it) < light slot < worldFx (emissive/floats,
// never darkened) < screen-space UI < minimap.
export interface Layers {
  world: Container;
  ground: Container;   // map, decals (P4)
  under: Container;    // corpses
  actors: Container;   // zombies then players
  fxTop: Container;    // sparks/blood (P4: shells/smoke ParticleContainers)
  lightSlot: Container; // P2 puts the multiply-blended lightmap sprite here
  worldFx: Container;
  emissive: Container; // tracers, muzzle flashes (P3: bloom filter here)
  floats: Container;   // damage numbers
  screenUi: Container; // chevrons, crosshair
  minimap: Container;
}

export function buildLayers(stage: Container): Layers {
  const world = new Container();
  const ground = new Container();
  const under = new Container();
  const actors = new Container();
  const fxTop = new Container();
  world.addChild(ground, under, actors, fxTop);
  const lightSlot = new Container();
  const worldFx = new Container();
  const emissive = new Container();
  // bloom only on the emissive layer (tracers/flashes) — map and UI stay crisp
  emissive.filters = [new AdvancedBloomFilter({ threshold: 0.1, bloomScale: 0.9, blur: 6, quality: 4 })];
  const floats = new Container();
  worldFx.addChild(emissive, floats);
  const screenUi = new Container();
  const minimap = new Container();
  stage.addChild(world, lightSlot, worldFx, screenUi, minimap);
  return { world, ground, under, actors, fxTop, lightSlot, worldFx, emissive, floats, screenUi, minimap };
}

function makeBar(tx: GfxTextures, w: number, y: number): { bg: Sprite; fg: Sprite } {
  const bg = tx.sprite('white');
  bg.anchor.set(0, 0);
  bg.tint = 0x000000; bg.alpha = 0.55;
  bg.scale.set(w / 8, 4 / 8);
  bg.position.set(-w / 2, y);
  const fg = tx.sprite('white');
  fg.anchor.set(0, 0);
  fg.position.set(-w / 2, y);
  fg.scale.set(w / 8, 4 / 8);
  return { bg, fg };
}

const NAME_STYLE = { fontFamily: 'system-ui, sans-serif', fontSize: 11 } as const;

class PlayerVisual {
  root = new Container();
  private prot: Sprite;
  private gun: Sprite;
  private body: Sprite;
  private edge: Sprite;
  private dot: Sprite;
  private name: Text;
  private barBg: Sprite;
  private barFg: Sprite;
  private reload: Text;
  private tx: GfxTextures;
  private team = -1;
  private isMe = false;
  private weapon = '';

  constructor(tx: GfxTextures) {
    this.tx = tx;
    this.prot = tx.sprite(ringKey(PLAYER_RADIUS + 5, 1));
    this.gun = tx.sprite('gun-rifle');
    this.body = tx.sprite('disc');
    this.body.scale.set(PLAYER_RADIUS / DISC_R);
    this.edge = tx.sprite(ringKey(PLAYER_RADIUS, 3));
    this.dot = tx.sprite('disc');
    this.dot.scale.set(3 / DISC_R);
    this.dot.tint = 0xffffff; this.dot.alpha = 0.55;
    this.name = new Text({ text: '', style: { ...NAME_STYLE, fill: '#ffffff' } });
    this.name.anchor.set(0.5, 1);
    this.name.position.set(0, -PLAYER_RADIUS - 9);
    const bar = makeBar(tx, 30, -PLAYER_RADIUS - 8);
    this.barBg = bar.bg; this.barFg = bar.fg;
    this.barFg.tint = 0x59d97c;
    this.reload = new Text({ text: 'reloading', style: { ...NAME_STYLE, fill: '#e8a53f' } });
    this.reload.anchor.set(0.5, 1);
    this.reload.position.set(0, PLAYER_RADIUS + 19);
    this.root.addChild(this.prot, this.gun, this.body, this.edge, this.dot,
      this.name, this.barBg, this.barFg, this.reload);
  }

  update(p: PlayerSnap, x: number, y: number, aim: number, isMe: boolean, now: number): void {
    if (p.team !== this.team || isMe !== this.isMe) {
      this.team = p.team; this.isMe = isMe;
      const col = TEAM_COLORS[p.team] || TEAM_COLORS[TEAM.SURVIVOR];
      this.body.tint = col.body;
      const edgeE = this.tx.entry(ringKey(PLAYER_RADIUS, isMe ? 2.5 : 3));
      this.edge.texture = edgeE.tex;
      this.edge.tint = isMe ? 0xf2f5f9 : col.dark;
      this.name.style.fill = isMe ? '#ffffff' : col.name;
    }
    if (p.w !== this.weapon) {
      this.weapon = p.w;
      const e = this.tx.entry(gunKey(p.w));
      this.gun.texture = e.tex;
      this.gun.anchor.set(e.ax, e.ay);
    }
    if (this.name.text !== p.name) this.name.text = p.name;
    this.root.position.set(x, y);
    this.gun.rotation = aim;
    this.dot.position.set(Math.cos(aim) * 7, Math.sin(aim) * 7);
    this.prot.visible = !!p.prot;
    if (p.prot) this.prot.alpha = 0.5 + 0.3 * Math.sin(now / 90);
    const hurt = !isMe && p.hp < 100;
    this.barBg.visible = this.barFg.visible = hurt;
    if (hurt) this.barFg.scale.x = (30 * Math.max(0, p.hp / 100)) / 8;
    this.reload.visible = !!p.rld;
  }

  destroy(): void {
    this.name.destroy(true);
    this.reload.destroy(true);
    this.root.destroy({ children: true });
  }
}

class ZombieVisual {
  root = new Container();
  type: ZombieSnap['type'];
  private fring: Sprite;
  private claws: [Sprite, Sprite];
  private body: Sprite;
  private edge: Sprite;
  private eyes: [Sprite, Sprite];
  private barBg: Sprite;
  private barFg: Sprite;
  private r: number;

  constructor(tx: GfxTextures, type: ZombieSnap['type']) {
    this.type = type;
    const zt = ZTYPE[type] || ZTYPE.walker;
    this.r = zt.r;
    this.fring = tx.sprite(ringKey(zt.r + 5, 2.5));
    this.fring.tint = 0xff4030;
    const claw = (): Sprite => {
      const s = tx.sprite('disc');
      s.scale.set((zt.r * 0.38) / DISC_R);
      s.tint = zt.dark;
      return s;
    };
    this.claws = [claw(), claw()];
    this.body = tx.sprite('disc');
    this.body.scale.set(zt.r / DISC_R);
    this.body.tint = zt.color;
    this.edge = tx.sprite(ringKey(zt.r, 3));
    this.edge.tint = zt.dark;
    const eye = (): Sprite => {
      const s = tx.sprite('disc');
      s.scale.set(2.2 / DISC_R);
      s.tint = 0xff5040;
      return s;
    };
    this.eyes = [eye(), eye()];
    const bar = makeBar(tx, 34, -zt.r - 9);
    this.barBg = bar.bg; this.barFg = bar.fg;
    this.barFg.tint = 0x8fd14f;
    this.root.addChild(this.fring, this.claws[0], this.claws[1], this.body, this.edge,
      this.eyes[0], this.eyes[1], this.barBg, this.barFg);
  }

  update(z: ZombieSnap, now: number): void {
    const r = this.r;
    const wob = Math.sin(now / (z.fr ? 55 : 90) + z.id * 2.7) * 0.15;
    this.root.position.set(z.x, z.y);
    this.fring.visible = !!z.fr;
    if (z.fr) this.fring.alpha = 0.45 + 0.3 * Math.sin(now / 80 + z.id);
    const sides = [-0.5, 0.5];
    for (let i = 0; i < 2; i++) {
      const a = z.aim + sides[i] + wob * sides[i] * 2;
      this.claws[i].position.set(Math.cos(a) * r, Math.sin(a) * r);
      const ea = z.aim + sides[i] * 0.7;
      this.eyes[i].position.set(Math.cos(ea) * r * 0.62, Math.sin(ea) * r * 0.62);
    }
    const hurt = z.hp < z.maxHp;
    this.barBg.visible = this.barFg.visible = hurt;
    if (hurt) this.barFg.scale.x = (34 * Math.max(0, z.hp / z.maxHp)) / 8;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

export class Scene {
  layers: Layers;
  private tx: GfxTextures;
  private players = new Map<number, PlayerVisual>();
  private zombies = new Map<number, ZombieVisual>();
  private seen = new Set<number>();

  constructor(stage: Container, tx: GfxTextures) {
    this.tx = tx;
    this.layers = buildLayers(stage);
    const mapSprite = new Sprite(tx.map);
    this.layers.ground.addChild(mapSprite);
  }

  syncPlayers(players: PlayerSnap[], myId: number, me: { x: number; y: number; aim: number }, now: number): void {
    this.seen.clear();
    for (const p of players) {
      this.seen.add(p.id);
      let v = this.players.get(p.id);
      if (!v) {
        v = new PlayerVisual(this.tx);
        this.players.set(p.id, v);
        this.layers.actors.addChild(v.root);
      }
      if (!p.alive) { v.root.visible = false; continue; }
      v.root.visible = true;
      const isMe = p.id === myId;
      const x = isMe ? me.x : p.x, y = isMe ? me.y : p.y;
      v.update(p, x, y, isMe ? me.aim : p.aim, isMe, now);
    }
    for (const [id, v] of this.players) {
      if (!this.seen.has(id)) { v.destroy(); this.players.delete(id); }
    }
  }

  syncZombies(zombies: ZombieSnap[], now: number): void {
    this.seen.clear();
    for (const z of zombies) {
      this.seen.add(z.id);
      let v = this.zombies.get(z.id);
      if (v && v.type !== z.type) { v.destroy(); this.zombies.delete(z.id); v = undefined; }
      if (!v) {
        v = new ZombieVisual(this.tx, z.type);
        this.zombies.set(z.id, v);
        // zombies render under players: keep them at the front of `actors`
        this.layers.actors.addChildAt(v.root, 0);
      }
      v.update(z, now);
    }
    for (const [id, v] of this.zombies) {
      if (!this.seen.has(id)) { v.destroy(); this.zombies.delete(id); }
    }
  }

  destroy(): void {
    for (const v of this.players.values()) v.destroy();
    for (const v of this.zombies.values()) v.destroy();
    this.players.clear();
    this.zombies.clear();
  }
}
