import { Container, Sprite, Text } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { PLAYER_RADIUS, TEAM } from '../../../shared/constants.ts';
import type { PickupSnap, PlayerSnap, ZombieSnap } from '../../../shared/types.ts';
import { DISC_R, GfxTextures, PICKUP_COLORS, TEAM_COLORS, ZTYPE, gunKey, pickupKey, ringKey } from './textures.ts';
import { BODY_SS, GUN_SS, HEAD, PICKUP_SS, WALK_FRAMES, bodyKey, type BodyKind } from './art.ts';

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
  pickups: Container;  // supply crates — above the lightmap, so never darkened
  emissive: Container; // tracers, muzzle flashes (P3: bloom filter here)
  floats: Container;   // damage numbers
  screenUi: Container; // chevrons, crosshair
  minimap: Container;
}

export function buildLayers(stage: Container, bloom: boolean): Layers {
  const world = new Container();
  const ground = new Container();
  const under = new Container();
  const actors = new Container();
  const fxTop = new Container();
  world.addChild(ground, under, actors, fxTop);
  const lightSlot = new Container();
  const worldFx = new Container();
  // Crates sit in worldFx beside the emissive layer rather than inside it, for
  // two reasons: fxsync toggles `emissive.visible` off on idle frames (they
  // would blink with tracer activity), and being inside it would keep the bloom
  // filter running every frame of every Outbreak match for four sprites.
  // Sitting above the lightmap is what actually makes them read in the dark.
  const pickups = new Container();
  const emissive = new Container();
  // bloom only on the emissive layer (tracers/flashes) — map and UI stay crisp.
  // Purely cosmetic, so the `fast` quality tier drops it (see view.ts).
  if (bloom) {
    emissive.filters = [new AdvancedBloomFilter({ threshold: 0.1, bloomScale: 0.9, blur: 6, quality: 4 })];
  }
  const floats = new Container();
  worldFx.addChild(pickups, emissive, floats);
  const screenUi = new Container();
  const minimap = new Container();
  stage.addChild(world, lightSlot, worldFx, screenUi, minimap);
  return {
    world, ground, under, actors, fxTop, lightSlot, worldFx, pickups, emissive, floats,
    screenUi, minimap,
  };
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

// World px of travel per walk frame. Distance-driven rather than time-driven, so
// feet never skate: sprinting and frenzied zombies speed the cycle for free, and
// an interpolation hitch can't advance a stationary entity's legs.
const WALK_STEP_PX = 11;

// Picks the walk frame for an entity from how far it has actually moved on
// screen. Fed rendered positions (predicted for self, interpolated for remotes).
class WalkCycle {
  private px = NaN;
  private py = NaN;
  private acc = 0;
  private still = 0;

  frame(x: number, y: number): number | 'idle' {
    if (!Number.isNaN(this.px)) {
      const d = Math.hypot(x - this.px, y - this.py);
      if (d < 0.05) this.still++;
      else { this.still = 0; this.acc = (this.acc + d) % (WALK_STEP_PX * WALK_FRAMES); }
    }
    this.px = x; this.py = y;
    if (this.still > 4) return 'idle'; // a few frames of hysteresis vs jitter
    return Math.floor(this.acc / WALK_STEP_PX) % WALK_FRAMES;
  }
}

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
  private cycle = new WalkCycle();
  private frame: number | 'idle' | null = null;

  constructor(tx: GfxTextures, textScale: number) {
    this.tx = tx;
    this.prot = tx.sprite(ringKey(PLAYER_RADIUS + 5, 1));
    this.gun = tx.sprite(gunKey('rifle'));
    this.gun.scale.set(1 / GUN_SS); // guns bake supersampled, see art.ts
    this.body = tx.sprite(bodyKey('player', 'idle'));
    this.body.scale.set(1 / BODY_SS); // baked supersampled, see art.ts
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
    // gun sits ABOVE the body so it lands in the baked empty hands
    this.root.addChild(this.prot, this.body, this.edge, this.gun, this.dot,
      this.name, this.barBg, this.barFg, this.reload);
    this.setTextScale(textScale);
  }

  // Counter-scales the labels against the world zoom so they keep their
  // designed pixel size (positions stay in world units and still scale).
  setTextScale(s: number): void {
    this.name.scale.set(s);
    this.reload.scale.set(s);
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
    const f = this.cycle.frame(x, y);
    if (f !== this.frame) {
      this.frame = f;
      this.body.texture = this.tx.entry(bodyKey('player', f)).tex;
    }
    this.root.position.set(x, y);
    this.body.rotation = aim;
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
  private body: Sprite;
  private edge: Sprite;
  private eyes: [Sprite, Sprite];
  private barBg: Sprite;
  private barFg: Sprite;
  private r: number;
  private tx: GfxTextures;
  private cycle = new WalkCycle();
  private frame: number | 'idle' | null = null;

  constructor(tx: GfxTextures, type: ZombieSnap['type']) {
    this.tx = tx;
    this.type = type;
    const zt = ZTYPE[type] || ZTYPE.walker;
    this.r = zt.r;
    this.fring = tx.sprite(ringKey(zt.r + 5, 2.5));
    this.fring.tint = 0xff4030;
    // claws are baked into the body frames now — they are the animated arms
    this.body = tx.sprite(bodyKey(type, 'idle'));
    this.body.scale.set(1 / BODY_SS);
    this.body.tint = zt.color;
    this.edge = tx.sprite(ringKey(zt.r, 3));
    this.edge.tint = zt.dark;
    // red eyes stay a separate overlay: the greyscale body takes one tint, so
    // an off-hue detail cannot be baked in
    const eye = (): Sprite => {
      const s = tx.sprite('disc');
      s.scale.set(2.4 / DISC_R);
      s.tint = 0xff5040;
      return s;
    };
    this.eyes = [eye(), eye()];
    const bar = makeBar(tx, 34, -zt.r - 9);
    this.barBg = bar.bg; this.barFg = bar.fg;
    this.barFg.tint = 0x8fd14f;
    this.root.addChild(this.fring, this.body, this.edge,
      this.eyes[0], this.eyes[1], this.barBg, this.barFg);
  }

  update(z: ZombieSnap, now: number): void {
    const r = this.r;
    this.root.position.set(z.x, z.y);
    const f = this.cycle.frame(z.x, z.y);
    if (f !== this.frame) {
      this.frame = f;
      this.body.texture = this.tx.entry(bodyKey(this.type, f)).tex;
    }
    this.body.rotation = z.aim;
    this.fring.visible = !!z.fr;
    if (z.fr) this.fring.alpha = 0.45 + 0.3 * Math.sin(now / 80 + z.id);
    // eyes ride the baked head, rotated with aim
    const h = HEAD[this.type as BodyKind];
    const ca = Math.cos(z.aim), sa = Math.sin(z.aim);
    const hx = h.x * r, hy = h.y * r, hr = h.r * r;
    for (let i = 0; i < 2; i++) {
      const lx = hx + 0.30 * hr, ly = hy + (i ? 0.45 : -0.45) * hr;
      this.eyes[i].position.set(lx * ca - ly * sa, lx * sa + ly * ca);
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
  private crates = new Map<number, Sprite>();
  private seen = new Set<number>();
  private textScale = 1;

  constructor(stage: Container, tx: GfxTextures, bloom: boolean) {
    this.tx = tx;
    this.layers = buildLayers(stage, bloom);
    const mapSprite = new Sprite(tx.map);
    this.layers.ground.addChild(mapSprite);
  }

  setTextScale(s: number): void {
    if (s === this.textScale) return;
    this.textScale = s;
    for (const v of this.players.values()) v.setTextScale(s);
  }

  syncPlayers(players: PlayerSnap[], myId: number, me: { x: number; y: number; aim: number }, now: number): void {
    this.seen.clear();
    for (const p of players) {
      this.seen.add(p.id);
      let v = this.players.get(p.id);
      if (!v) {
        v = new PlayerVisual(this.tx, this.textScale);
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

  /**
   * Supply crates. Pooled by id and mark-and-swept like the entity visuals, but
   * a single sprite each — they do not move, they only appear and vanish.
   * The alpha pulse is the whole of the "notice me": the lightmap does not
   * darken this layer, so a still sprite would read as part of the floor art.
   */
  syncPickups(pickups: PickupSnap[], now: number): void {
    this.seen.clear();
    for (const c of pickups) {
      this.seen.add(c.id);
      let s = this.crates.get(c.id);
      if (!s) {
        s = this.tx.sprite(pickupKey(c.kind));
        s.scale.set(1 / PICKUP_SS); // baked supersampled, see art.ts
        s.tint = PICKUP_COLORS[c.kind];
        s.position.set(c.x, c.y);
        this.crates.set(c.id, s);
        this.layers.pickups.addChild(s);
      }
      // slow, shallow, and offset per crate so a pair does not throb in unison
      s.alpha = 0.82 + 0.18 * Math.sin(now / 320 + c.id);
    }
    for (const [id, s] of this.crates) {
      if (!this.seen.has(id)) { s.destroy(); this.crates.delete(id); }
    }
  }

  destroy(): void {
    for (const v of this.players.values()) v.destroy();
    for (const v of this.zombies.values()) v.destroy();
    for (const s of this.crates.values()) s.destroy();
    this.players.clear();
    this.zombies.clear();
    this.crates.clear();
  }
}
