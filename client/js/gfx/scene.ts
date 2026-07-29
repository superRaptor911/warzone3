import { Container, Sprite, Text } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { GLOB_RADIUS, PLAYER_RADIUS, TEAM, TILE } from '../../../shared/constants.ts';
import {
  OVER, OVER_HEIGHT, T_FLOOR, T_WALL, matId, type Grid,
} from '../../../shared/maps.ts';
import type { GlobSnap, PickupSnap, PlayerSnap, PuddleSnap, ZombieSnap } from '../../../shared/types.ts';
import {
  ACID_GLOB, ACID_HOT, ACID_PUDDLE, DISC_R, GfxTextures, PICKUP_COLORS, TEAM_COLORS,
  ZTYPE, gunKey, pickupKey, ringKey,
} from './textures.ts';
import {
  BODY_SS, GUN_SS, HEAD, PICKUP_SS, WALK_FRAMES, bodyFlatKey, bodyKey, type BodyKind,
} from './art.ts';
import {
  TILE_SS, decorKey, floorKey, floorVariant, neighbourMask, overKey, overVariant,
  propKey, shadeKey, wallKey,
} from './tileset.ts';

/**
 * How solid an x-rayed actor's silhouette is.
 *
 * Below 1 so the overhead it is standing under still reads through it — the
 * point is "there is someone under the awning", not "the awning has a hole in
 * it". High enough that the shape is unambiguous at a glance, because it is
 * carrying the same information the unoccluded sprite would.
 */
const XRAY_ALPHA = 0.8;

// Stage layer tree. Order is load-bearing (encodes the old painter's order):
// world (lit, phase 2 darkens it) < light slot < worldFx (emissive/floats,
// never darkened) < screen-space UI < minimap.
export interface Layers {
  world: Container;
  ground: Container;   // map, decals (P4)
  under: Container;    // corpses
  actors: Container;   // zombies then players
  overhead: Container; // awnings/pipes: tiles that hang above the actors
  xray: Container;     // actors the overheads would otherwise hide
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
  // Overheads draw over the actors — that is what makes them overheads — and the
  // x-ray layer draws over the overheads, so an occluded actor is still visible.
  // Both stay INSIDE `world`, under the lightmap: above it, a player under an
  // awning would be brighter than one standing in the open, and that is an
  // information gain rather than a redraw. fxTop is above both because sparks and
  // blood are transient two-frame flecks, and losing them under a canopy would
  // read as the hit not registering.
  const overhead = new Container();
  const xray = new Container();
  const fxTop = new Container();
  world.addChild(ground, under, actors, overhead, xray, fxTop);
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
    world, ground, under, actors, overhead, xray, fxTop, lightSlot, worldFx, pickups,
    emissive, floats, screenUi, minimap,
  };
}

/**
 * Builds the world as real sprites instead of one pre-baked map texture.
 *
 * Every frame comes from the single tile-atlas source, so Pixi batches the lot:
 * ~2200 quads for Outbreak is one draw call's worth of work, and in exchange the
 * ground is resolution-independent (no 48px-per-tile ceiling to upscale at a
 * DPR-2 backing store), free of the old 4096px map-texture limit, and able to
 * vary per tile.
 *
 * Draw order inside `ground`, and each part's reason for being where it is:
 *   floor   every tile, including under walls — walls are opaque, and painting
 *           the floor everywhere means a prop never needs an under-tile baked in
 *   shade   ambient occlusion on floor tiles beside solids: the half of a wall's
 *           drop shadow that lands on the ground, which cannot live in the wall
 *           texture because a texture is clipped to its own cell
 *   decor   free-position dressing, above the ground and below anything solid
 *   solid   wall composites and props
 *
 * Nothing here is pooled or updated: the world is static for the life of a
 * match, so these are built once and never touched again. Decals add their
 * RenderTexture to the same layer afterwards, above all of it.
 */
function buildTilemap(ground: Container, tx: GfxTextures, grid: Grid): void {
  const scale = 1 / TILE_SS;             // atlas cells are baked at TILE * TILE_SS
  const solid = (x: number, y: number): boolean => grid.solid(x, y);
  const floors = new Container();
  const shades = new Container();
  const decors = new Container();
  const solids = new Container();

  for (let ty = 0; ty < grid.h; ty++) {
    for (let tx0 = 0; tx0 < grid.w; tx0++) {
      const t = grid.get(tx0, ty);
      const m = grid.matAt(tx0, ty);
      const id = matId(m);
      const px = tx0 * TILE, py = ty * TILE;

      // Floor under everything except walls. A wall composite covers its whole
      // cell (asserted by the invariant test), so a floor sprite beneath one is
      // ~10% of the tilemap's sprites drawing nothing anyone can see. Props DO
      // get one: none of their art fills the cell.
      if (t !== T_WALL) {
        const fid = t === T_FLOOR ? id : matId(grid.floorMatUnder(tx0, ty));
        const fkey = floorKey(fid, floorVariant(fid, tx0, ty));
        if (tx.has(fkey)) {
          const s = tx.sprite(fkey);
          s.position.set(px, py);
          s.scale.set(scale);
          floors.addChild(s);
        }
      }

      if (t === T_FLOOR) {
        const mask = neighbourMask(solid, tx0, ty);
        if (mask) {
          const s = tx.sprite(shadeKey(mask));
          s.position.set(px, py);
          s.scale.set(scale);
          shades.addChild(s);
        }
        continue;
      }

      // Solid: a wall composite picked by which faces front onto floor, or a
      // prop drawn over the floor sprite above.
      const key = t === T_WALL
        ? wallKey(id, neighbourMask(solid, tx0, ty))
        : propKey(id);
      if (tx.has(key)) {
        const s = tx.sprite(key);
        s.position.set(px, py);
        s.scale.set(scale);
        solids.addChild(s);
      }
    }
  }

  for (const d of grid.decor) {
    const key = decorKey(d.f);
    if (!tx.has(key)) continue;
    const s = tx.sprite(key);
    s.position.set(d.x, d.y);
    s.rotation = d.rot;
    s.scale.set(scale * d.s);
    decors.addChild(s);
  }

  ground.addChild(floors, shades, decors, solids);
}

/**
 * The props that hang above the field, from `Grid.over`.
 *
 * Static sprites like the rest of the tilemap, and autotiled the same way — the
 * only difference is which question the neighbour mask asks (`is my neighbour the
 * same overhead` rather than `is it solid`) and which layer they land in.
 *
 * Grouped by id and added in ascending `OVER_HEIGHT` order, so where two runs
 * meet the higher one crosses over: a conduit passes over a pipe, both pass over
 * an awning. A tile holds one overhead id, so this can only matter where two runs
 * are adjacent — but the clearances are real data, and letting the draw order
 * disagree with them is how a pipe ends up threaded through a canopy.
 */
function buildOverheads(overhead: Container, tx: GfxTextures, grid: Grid): void {
  const scale = 1 / TILE_SS;
  const ids = Object.keys(OVER_HEIGHT).map(Number)
    .sort((a, b) => OVER_HEIGHT[a] - OVER_HEIGHT[b]);
  for (const id of ids) {
    const same = (x: number, y: number): boolean => grid.overAt(x, y) === id;
    const layer = new Container();
    for (let ty = 0; ty < grid.h; ty++) {
      for (let tx0 = 0; tx0 < grid.w; tx0++) {
        if (grid.overAt(tx0, ty) !== id) continue;
        const key = overKey(id, overVariant(id, neighbourMask(same, tx0, ty)));
        if (!tx.has(key)) continue;
        const s = tx.sprite(key);
        s.position.set(tx0 * TILE, ty * TILE);
        s.scale.set(scale);
        layer.addChild(s);
      }
    }
    if (layer.children.length) overhead.addChild(layer);
    else layer.destroy();
  }
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
  private xray = false;

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

  /**
   * `xray` says this player is under an overhead, so the ONLY thing that changes
   * is the body: the flat silhouette of the same walk frame, at the same team
   * tint, slightly transparent. The edge ring, the spawn-protection ring, the
   * gun, the aim dot, the name, the health bar and the reload label all draw
   * exactly as they do in the open — an occluded player must be neither harder
   * nor easier to read than an exposed one, which is the whole reason occluding
   * props are allowed at all (see tasks/WORLD-ART.md).
   */
  update(p: PlayerSnap, x: number, y: number, aim: number, isMe: boolean, now: number,
         xray: boolean): void {
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
    if (f !== this.frame || xray !== this.xray) {
      this.frame = f; this.xray = xray;
      const key = xray ? bodyFlatKey('player', f) : bodyKey('player', f);
      this.body.texture = this.tx.entry(key).tex;
      this.body.alpha = xray ? XRAY_ALPHA : 1;
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
  private color: number | string;
  private tx: GfxTextures;
  private cycle = new WalkCycle();
  private frame: number | 'idle' | null = null;
  private xray = false;

  constructor(tx: GfxTextures, type: ZombieSnap['type']) {
    this.tx = tx;
    this.type = type;
    const zt = ZTYPE[type] || ZTYPE.walker;
    this.r = zt.r;
    this.color = zt.color;
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

  // `xray` as for a player: the body goes flat, the frenzy ring, the eyes and the
  // health bar are untouched. The eyes matter most here — they are the tell that
  // something under the awning has noticed you, and they are a separate tint the
  // flat body could not carry.
  update(z: ZombieSnap, now: number, xray: boolean): void {
    const r = this.r;
    this.root.position.set(z.x, z.y);
    const f = this.cycle.frame(z.x, z.y);
    if (f !== this.frame || xray !== this.xray) {
      this.frame = f; this.xray = xray;
      const key = xray ? bodyFlatKey(this.type, f) : bodyKey(this.type, f);
      this.body.texture = this.tx.entry(key).tex;
      this.body.alpha = xray ? XRAY_ALPHA : 1;
    }
    this.body.rotation = z.aim;
    // windup tell: a winding-up spitter strobes toward acid-bright. The flicker
    // is the point — a static hue shift reads as a different type, a strobe
    // reads as "about to". X-ray keeps it too: the flat bake is white, so the
    // tint carries through and an occluded spitter telegraphs like an open one.
    this.body.tint = z.wu && Math.sin(now / 70) > 0 ? ACID_HOT : this.color;
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
  private grid: Grid;
  private players = new Map<number, PlayerVisual>();
  private zombies = new Map<number, ZombieVisual>();
  private crates = new Map<number, Sprite>();
  private globs = new Map<number, Sprite>();
  private puddles = new Map<number, Sprite>();
  private seen = new Set<number>();
  private textScale = 1;

  constructor(stage: Container, tx: GfxTextures, bloom: boolean, grid: Grid) {
    this.tx = tx;
    this.grid = grid;
    this.layers = buildLayers(stage, bloom);
    buildTilemap(this.layers.ground, tx, grid);
    buildOverheads(this.layers.overhead, tx, grid);
  }

  /**
   * Is this actor under an overhead?
   *
   * One grid lookup on the tile the actor's centre is in: O(1) per actor per
   * frame, no AABB against the sprite and no partial state, so an actor cannot
   * flicker between occluded and not while standing on a boundary — it crosses
   * once, at the tile edge. Deliberately not a test against `OVER_HEIGHT`: every
   * declared clearance is far above head height (asserted in matchflow), so "is
   * there anything above me" is the whole question.
   *
   * Note this is not view-dependent, and must not become so. The camera is fixed
   * top-down, so an awning drawn over the tile north of it hides that player from
   * every player at once — including one at 90° with clear line of sight whose
   * shots still land. That is exactly why the x-ray exists.
   */
  private occluded(x: number, y: number): boolean {
    return this.grid.overAt(Math.floor(x / TILE), Math.floor(y / TILE)) !== OVER.NONE;
  }

  /**
   * Moves a visual between `actors` and `xray` when its occlusion changes, and
   * only then — reparenting every frame would rebuild both layers' render groups
   * for nothing. `front` keeps the actors convention: zombies at the front of the
   * list so they draw under players, in either layer.
   */
  private place(root: Container, xray: boolean, front: boolean): void {
    const to = xray ? this.layers.xray : this.layers.actors;
    if (root.parent === to) return;
    if (front) to.addChildAt(root, 0);
    else to.addChild(root);
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
      const xray = this.occluded(x, y);
      v.update(p, x, y, isMe ? me.aim : p.aim, isMe, now, xray);
      this.place(v.root, xray, false);
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
      }
      const xray = this.occluded(z.x, z.y);
      v.update(z, now, xray);
      // zombies render under players: keep them at the front of their layer
      this.place(v.root, xray, true);
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

  /**
   * Acid globs in flight. Small tinted discs in `fxTop`: above the actors —
   * a glob is in the air, and one crossing the horde must not vanish into it —
   * but still inside `world`, under the lightmap, so darkness dims it exactly
   * as it dims everything else.
   */
  syncGlobs(globs: GlobSnap[]): void {
    this.seen.clear();
    for (const g of globs) {
      this.seen.add(g.id);
      let s = this.globs.get(g.id);
      if (!s) {
        s = this.tx.sprite('disc');
        s.scale.set(GLOB_RADIUS / DISC_R);
        s.tint = ACID_GLOB;
        this.globs.set(g.id, s);
        this.layers.fxTop.addChild(s);
      }
      s.position.set(g.x, g.y);
    }
    for (const [id, s] of this.globs) {
      if (!this.seen.has(id)) { s.destroy(); this.globs.delete(id); }
    }
  }

  /**
   * Acid puddles. In `under` — ON the ground, beneath every actor — and inside
   * `world` so the lightmap darkens them honestly (a hazard is not a light
   * source). Baked once at PUDDLE_RADIUS, so scale 1 is the exact circle the
   * server burns; variety comes from a per-id rotation, and the last 0.6s of
   * `t` fades the sprite out so expiry never pops.
   */
  syncPuddles(puddles: PuddleSnap[], now: number): void {
    this.seen.clear();
    for (const p of puddles) {
      this.seen.add(p.id);
      let s = this.puddles.get(p.id);
      if (!s) {
        s = this.tx.sprite('puddle');
        s.tint = ACID_PUDDLE;
        s.rotation = p.id * 2.4; // deterministic variety, stable per puddle
        s.position.set(p.x, p.y);
        this.puddles.set(p.id, s);
        this.layers.under.addChild(s);
      }
      s.alpha = (0.66 + 0.08 * Math.sin(now / 260 + p.id)) * Math.min(1, p.t / 0.6);
    }
    for (const [id, s] of this.puddles) {
      if (!this.seen.has(id)) { s.destroy(); this.puddles.delete(id); }
    }
  }

  destroy(): void {
    for (const v of this.players.values()) v.destroy();
    for (const v of this.zombies.values()) v.destroy();
    for (const s of this.crates.values()) s.destroy();
    for (const s of this.globs.values()) s.destroy();
    for (const s of this.puddles.values()) s.destroy();
    this.players.clear();
    this.zombies.clear();
    this.crates.clear();
    this.globs.clear();
    this.puddles.clear();
  }
}
