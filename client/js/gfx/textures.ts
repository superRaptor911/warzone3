import { Assets, Rectangle, Sprite, Texture } from 'pixi.js';
import type { Spritesheet } from 'pixi.js';
import { PICKUP_RADIUS, PLAYER_RADIUS, TEAM, ZOMBIE_RADII } from '../../../shared/constants.ts';
import { MAT, T_CRATE, T_WALL, matId, matIndoor, type Grid } from '../../../shared/maps.ts';
import { WEAPONS, type WeaponId } from '../../../shared/weapons.ts';
import type { PickupKind, ZombieTypeId } from '../../../shared/types.ts';
import {
  BODY_KINDS, BODY_SS, GUN_SPEC, GUN_SS, GUN_START, PICKUP_SS, WALK_FRAMES,
  bodyKey, drawBody, drawPickup, drawGun, gunKey, pickupKey, type BodyKind,
} from './art.ts';
import {
  CELL, DECOR_ART, FLOOR_ART, MASKS, PROP_ART, SHEET_URL, WALL_ART,
  decorKey, drawDecor, drawFloor, drawProp, drawShade, drawWall,
  floorKey, floorVariants, propKey, shadeKey, wallKey,
} from './tileset.ts';

export { gunKey, pickupKey };

// Supply crates: greyscale bakes, tinted per kind at draw time. Semantic
// colours, so they live here beside TEAM_COLORS rather than in the art.
export const PICKUP_COLORS: Record<PickupKind, number> = {
  ammo: 0x8fd6ff,
  health: 0x9fe870,
};

export interface TeamColor { body: string; dark: string; name: string }
export const TEAM_COLORS: Record<number, TeamColor> = {
  [TEAM.RED]: { body: '#c94439', dark: '#8a2d25', name: '#ff8b81' },
  [TEAM.BLUE]: { body: '#3d6fc2', dark: '#294b85', name: '#8ebbff' },
  [TEAM.SURVIVOR]: { body: '#4c9e5f', dark: '#336b41', name: '#9fe870' },
};
// Radii come from shared/constants.ts so body frames and rings are baked at the
// authoritative hitbox size — visuals cannot drift from collision.
export const ZTYPE: Record<ZombieTypeId, { color: string; dark: string; r: number }> = {
  walker: { color: '#5d8a42', dark: '#3d5c2b', r: ZOMBIE_RADII.walker },
  runner: { color: '#8fb457', dark: '#5c7a36', r: ZOMBIE_RADII.runner },
  brute: { color: '#39602c', dark: '#24401b', r: ZOMBIE_RADII.brute },
};

export const BODY_RADIUS: Record<BodyKind, number> = {
  player: PLAYER_RADIUS,
  walker: ZOMBIE_RADII.walker,
  runner: ZOMBIE_RADII.runner,
  brute: ZOMBIE_RADII.brute,
};

export const DISC_R = 32;        // 'disc' bake radius; scale = wantedRadius / DISC_R
export const TRACER_W = 64;      // 'tracer' strip length in texture px
export const TRACER_H = 4;
export const CHEVRON_S = 18;     // 'chevron' baked at this nominal size

export function ringKey(r: number, w: number): string { return `ring:${r}x${w}`; }

/**
 * The tilesheet, fetched once per page. Everything the world is drawn from
 * comes out of this one image, so a missing or corrupt file is a hard failure
 * rather than a degraded look — see the note on `MissingArtError`.
 */
let sheetLoad: Promise<HTMLImageElement> | null = null;
function loadSheet(): Promise<HTMLImageElement> {
  sheetLoad ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new MissingArtError(SHEET_URL));
    img.src = SHEET_URL;
  });
  return sheetLoad;
}

/**
 * Thrown when the world tilesheet cannot be loaded.
 *
 * The optional entity atlas (`tryLoadArtAtlas`) degrades silently on purpose —
 * it is an override, and its absence is the normal case. The tilesheet is the
 * opposite: it ships in the repository, so it can only be absent because a
 * checkout or a deploy is broken, and a world quietly rendered as flat nothing
 * would send someone hunting through the renderer for an hour. main.ts turns
 * this into a visible message.
 */
export class MissingArtError extends Error {
  constructor(url: string) {
    super(`world art failed to load: ${url} — the file ships in client/assets/, `
      + 'so this is a broken checkout or deploy, not a missing download');
    this.name = 'MissingArtError';
  }
}

// Minimap colours, per material family. The minimap is a schematic, not a
// thumbnail: it needs "wall / prop / indoor floor / outdoor floor" to be
// separable at 4px per tile, which is well below the size any texture survives.
const MINI_INDOOR = '#2c3a3c';
const MINI_OUTDOOR = 'rgba(10,13,18,0.78)';
const MINI_WALL: Record<number, string> = {
  [MAT.WALL_BRICK]: '#a8582c',
  [MAT.WALL_WOOD]: '#8e6238',
  [MAT.WALL_CONCRETE]: '#7d949a',
  [MAT.WALL_PLASTER]: '#c69a6d',
  [MAT.WALL_PLANK]: '#8e6238',   // deliberately WALL_WOOD's colour: at 4px per
};                               // tile "timber" is as fine a distinction as the
                                 // minimap can carry, and a fifth grey-brown
                                 // would only blur the four that mean something.

function buildMiniCanvas(g: Grid): HTMLCanvasElement {
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = g.w * scale; c.height = g.h * scale;
  const x = c.getContext('2d')!;
  x.fillStyle = MINI_OUTDOOR;
  x.fillRect(0, 0, c.width, c.height);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const v = g.get(tx, ty), m = g.matAt(tx, ty);
      let fill = '';
      if (v === T_WALL) fill = MINI_WALL[matId(m)] || '#57647a';
      else if (v === T_CRATE) fill = '#6e5232';
      else if (matIndoor(m)) fill = MINI_INDOOR;
      if (!fill) continue;
      x.fillStyle = fill;
      x.fillRect(tx * scale, ty * scale, scale, scale);
    }
  }
  return c;
}

interface AtlasEntry { tex: Texture; ax: number; ay: number }

// probe once per page load (one 404 in devtools at most, none on reconnect)
let artProbe: Promise<Spritesheet | null> | null = null;
function loadArtSheet(): Promise<Spritesheet | null> {
  artProbe ??= (async () => {
    const head = await fetch('/assets/atlas.json', { method: 'HEAD' });
    if (!head.ok) return null;
    return Assets.load<Spritesheet>('/assets/atlas.json');
  })().catch(() => null);
  return artProbe;
}

interface Atlas { base: Texture; entries: Map<string, AtlasEntry> }

/**
 * The shape atlas, baked once for the life of the page and shared by every
 * match's `GfxTextures` (the map/minimap bakes below stay per-match, since they
 * are the only part that depends on the grid).
 *
 * Sharing it is not an optimisation — **freeing this TextureSource breaks the
 * renderer.** Pixi builds the particle pipe's shader once per renderer
 * (`renderPipes.particle.defaultShader`) and keeps the source of whatever
 * texture the particles use in one of its bind groups; our shells/sparks/smoke
 * draw from the atlas, so destroying the atlas destroyed that bind group, and
 * from the next match on every single `render()` threw before it presented a
 * frame. main.ts draws from the rAF loop, so the canvas froze on the last good
 * frame while the sim, the audio and the DOM HUD carried on — "I quit and
 * rejoined and my player isn't there, but I can hear the game".
 */
let sharedAtlas: Atlas | null = null;

/**
 * The world-tile atlas: every floor variant, wall composite, AO shade, prop and
 * decor frame, baked at CELL px into one texture source so the whole ground
 * plane draws in a single batch however many sprites it is made of.
 *
 * Page-lifetime for the same reason as `sharedAtlas` — and additionally because
 * it depends only on the tilesheet and the material tables, never on the grid,
 * so a per-match rebake would be pure waste. **Never destroy it**: read the
 * note above sharedAtlas for what freeing a live TextureSource does to the
 * particle pipe's bind group.
 */
let sharedTiles: Atlas | null = null;

// All small shapes are baked into one 1024x1024 canvas atlas so every sprite
// shares a single texture source (full batching) — 1024 because the body walk
// frame sets (4 kinds x 5 frames, supersampled) overflow 512; 46 cells fill
// ~29% of the 1024 height, leaving room for more frame sets. Shapes
// that vary by team or zombie type are baked white/greyscale and tinted at
// runtime — this is also the spritesheet contract for real art (see
// tryLoadArtAtlas).
export class GfxTextures {
  mini!: Texture;
  private entries = new Map<string, AtlasEntry>();

  entry(key: string): AtlasEntry {
    const e = this.entries.get(key);
    if (!e) throw new Error(`unknown texture key: ${key}`);
    return e;
  }

  /** True if a key exists, for callers that can pick a fallback. */
  has(key: string): boolean { return this.entries.has(key); }

  sprite(key: string): Sprite {
    const e = this.entry(key);
    const s = new Sprite(e.tex);
    s.anchor.set(e.ax, e.ay);
    return s;
  }

  /**
   * Async because the world art has to arrive before it can be baked. Only the
   * minimap is per-match now: the shape atlas and the tile atlas both depend
   * solely on constants, so they are built once per page.
   *
   * Throws MissingArtError if the tilesheet is unreachable. Deliberate — see
   * the note on that class.
   */
  async bake(grid: Grid): Promise<void> {
    const sheet = await loadSheet();
    this.mini = Texture.from(buildMiniCanvas(grid));
    sharedAtlas ??= bakeAtlas();
    sharedTiles ??= bakeTiles(sheet);
    this.entries = new Map([...sharedAtlas.entries, ...sharedTiles.entries]);
  }

  // Real-art hook: if /assets/atlas.json (a Pixi spritesheet whose frame names
  // match the registry keys) exists, its textures replace the procedural bakes.
  // Contract:
  //  - body frames are `body-<player|walker|runner|brute>-<0..3|idle>`, drawn
  //    facing +x, centred, and are TINTED at runtime — paint them as greyscale
  //    luminance ramps (white = full team/type colour), not in final colours.
  //  - the silhouette must stay inside the entity's collision radius
  //    (PLAYER_RADIUS / ZOMBIE_RADII) scaled by BODY_SS.
  //  - guns are `gun-<weaponId>` for all five weapons, pre-coloured (not
  //    tinted), grip end at the left edge, and their frame width must match
  //    GUN_SPEC[id].len or the muzzle flash will detach from the barrel.
  //  - rings/corpse parts/splats are tinted too, so paint them white.
  // No atlas shipped -> the procedural look stands.
  async tryLoadArtAtlas(): Promise<void> {
    try {
      const sheet = await loadArtSheet();
      if (!sheet) return;
      for (const [key, e] of this.entries) {
        const t = sheet.textures[key];
        if (t) e.tex = t;
      }
    } catch { /* no art shipped — procedural bake stands */ }
  }

  // Only the minimap bake is ours to free; both atlases are page-lifetime on
  // purpose (see sharedAtlas / sharedTiles) and outlive every Renderer.
  destroy(): void {
    this.mini.destroy(true);
  }
}

/**
 * Bakes every world-tile frame from the tilesheet into one atlas at CELL px.
 *
 * Tiles get their own atlas rather than joining the shape atlas because they
 * have a different lifetime story (they need an async fetch first) and because
 * separating them keeps the ground plane and the entities in one batch each
 * anyway — they are drawn from different layers, so nothing is gained by
 * sharing a source.
 *
 * Frames are baked with `imageSmoothingEnabled` on: the source is 128px and the
 * target is 96px, so every blit is a downscale and smoothing is what makes it
 * clean rather than aliased.
 */
function bakeTiles(sheet: HTMLImageElement): Atlas {
  // Counted, not guessed: floors (sum of variants, 36) + walls (5 families x 16)
  // + shades (16) + props (22) + decor (17) = 171 cells of 96px. At 2048 wide
  // that is 20 per row and 9 of the 10 available rows, so phase 3's overheads
  // (9-slice + two straight pairs = 13) fit — but only just. The next family
  // after that wants a taller canvas rather than a bigger cell.
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 1024;
  const x = c.getContext('2d')!;
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  const PAD = 2;
  let cx = PAD, cy = PAD;
  const pending: { key: string; rect: Rectangle; ax: number; ay: number }[] = [];
  const cell = (key: string, ax: number, ay: number,
                draw: (g: CanvasRenderingContext2D) => void): void => {
    if (cx + CELL + PAD > c.width) { cx = PAD; cy += CELL + PAD; }
    if (cy + CELL + PAD > c.height) throw new Error('tile atlas overflow');
    x.save();
    x.translate(cx, cy);
    draw(x);
    x.restore();
    pending.push({ key, rect: new Rectangle(cx, cy, CELL, CELL), ax, ay });
    cx += CELL + PAD;
  };

  // Floors: anchored top-left, since a tile sprite is positioned at its corner.
  // Variant count comes from floorVariants, not the cell list — a material can
  // have more baked faces than source cells (see FLOOR_FX grain).
  for (const key of Object.keys(FLOOR_ART)) {
    const id = Number(key);
    for (let v = 0; v < floorVariants(id); v++) {
      cell(floorKey(id, v), 0, 0, g => drawFloor(g, sheet, id, v));
    }
  }
  // Wall composites: one per material per neighbour mask.
  for (const key of Object.keys(WALL_ART)) {
    const id = Number(key);
    for (let mask = 0; mask < MASKS; mask++) {
      cell(wallKey(id, mask), 0, 0, g => drawWall(g, sheet, id, mask));
    }
  }
  // Floor-side ambient occlusion, one per mask — shared by every material.
  for (let mask = 0; mask < MASKS; mask++) {
    cell(shadeKey(mask), 0, 0, g => drawShade(g, mask));
  }
  // Props sit on the floor sprite, so they keep their transparency.
  for (const key of Object.keys(PROP_ART)) {
    const id = Number(key);
    cell(propKey(id), 0, 0, g => drawProp(g, sheet, id));
  }
  // Decor is placed by centre and rotated, so it anchors in the middle.
  for (const key of Object.keys(DECOR_ART)) {
    const f = Number(key);
    cell(decorKey(f), 0.5, 0.5, g => drawDecor(g, sheet, f));
  }

  const base = Texture.from(c);
  const entries = new Map<string, AtlasEntry>();
  for (const p of pending) {
    entries.set(p.key, {
      tex: new Texture({ source: base.source, frame: p.rect }),
      ax: p.ax, ay: p.ay,
    });
  }
  return { base, entries };
}

function bakeAtlas(): Atlas {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const x = c.getContext('2d')!;
  const PAD = 3;
  let cx = PAD, cy = PAD, rowH = 0;
  const pending: { key: string; rect: Rectangle; ax: number; ay: number }[] = [];
  const cell = (key: string, w: number, h: number, ax: number, ay: number,
                draw: (g: CanvasRenderingContext2D) => void): void => {
    w = Math.ceil(w); h = Math.ceil(h);
    if (cx + w + PAD > c.width) { cx = PAD; cy += rowH + PAD; rowH = 0; }
    if (cy + h + PAD > c.height) throw new Error('atlas overflow');
    x.save();
    x.translate(cx, cy);
    draw(x);
    x.restore();
    pending.push({ key, rect: new Rectangle(cx, cy, w, h), ax, ay });
    cx += w + PAD;
    rowH = Math.max(rowH, h);
  };

  // solid white square — tinted/scaled for sparks, bars, crosshair
  cell('white', 8, 8, 0.5, 0.5, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); });

  // white disc, radius 32 — scaled down for bodies, claws, eyes, dots, blips
  cell('disc', DISC_R * 2 + 2, DISC_R * 2 + 2, 0.5, 0.5, g => {
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(DISC_R + 1, DISC_R + 1, DISC_R, 0, 7); g.fill();
  });

  // white rings marking each entity's exact collision radius. Deduped: radii
  // now come from shared constants and can legitimately coincide (a player and
  // a walker are both 17), which would otherwise bake the same cell twice.
  const rings: [number, number][] = [
    [PLAYER_RADIUS, 3], [PLAYER_RADIUS, 2.5], [PLAYER_RADIUS + 5, 1], // edge / my edge / prot
    [ZTYPE.runner.r, 3], [ZTYPE.walker.r, 3], [ZTYPE.brute.r, 3],    // zombie edges
    [ZTYPE.runner.r + 5, 2.5], [ZTYPE.walker.r + 5, 2.5], [ZTYPE.brute.r + 5, 2.5], // frenzy
  ];
  const ringSeen = new Set<string>();
  for (const [r, w] of rings) {
    if (ringSeen.has(ringKey(r, w))) continue;
    ringSeen.add(ringKey(r, w));
    const size = Math.ceil(2 * r + w + 4);
    cell(ringKey(r, w), size, size, 0.5, 0.5, g => {
      g.strokeStyle = '#fff'; g.lineWidth = w;
      g.beginPath(); g.arc(size / 2, size / 2, r, 0, 7); g.stroke();
    });
  }

  // Body walk frame sets — greyscale ramps tinted at runtime, every frame
  // facing +x, baked at BODY_SS x the on-screen size and scaled down at draw
  // time so rotating to arbitrary aim angles resamples cleanly.
  for (const kind of BODY_KINDS) {
    const R = BODY_RADIUS[kind] * BODY_SS;
    const size = Math.ceil(2 * R) + 2;
    const frames: (number | 'idle')[] = ['idle'];
    for (let f = 0; f < WALK_FRAMES; f++) frames.push(f);
    for (const f of frames) {
      cell(bodyKey(kind, f), size, size, 0.5, 0.5, g => {
        g.translate(size / 2, size / 2);
        drawBody(g, kind, R, f === 'idle' ? null : (f as number) / WALK_FRAMES);
      });
    }
  }

  // guns: one distinct silhouette and palette per weapon, pre-coloured (never
  // tinted). Baked at GUN_SS x so the detail survives rotation; the anchor is
  // a fraction of the cell, so it is unaffected by the supersample and still
  // places the grip end GUN_START world px in front of the player centre.
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const { len, h } = GUN_SPEC[id];
    cell(gunKey(id), len * GUN_SS, h * GUN_SS, -GUN_START / len, 0.5, g => {
      g.scale(GUN_SS, GUN_SS);
      drawGun(g, id);
    });
  }

  // tracer strip: transparent at the shooter end, opaque at the impact end
  cell('tracer', TRACER_W, TRACER_H, 0, 0.5, g => {
    const grad = g.createLinearGradient(0, 0, TRACER_W, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, TRACER_W, TRACER_H);
  });

  // muzzle flash: diamond + hot core (full color; alpha animated per sprite)
  cell('flash', 22, 14, 0, 0.5, g => {
    g.fillStyle = 'rgb(255,214,110)';
    g.beginPath();
    g.moveTo(0, 7); g.lineTo(14, 2); g.lineTo(20, 7); g.lineTo(14, 12);
    g.closePath(); g.fill();
    g.fillStyle = 'rgb(255,255,220)';
    g.beginPath(); g.arc(4, 7, 4, 0, 7); g.fill();
  });

  // threat chevron pointing +x, origin at (10,15) inside a 30x30 cell
  cell('chevron', 30, 30, 10 / 30, 0.5, g => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(10 + CHEVRON_S, 15);
    g.lineTo(10 - CHEVRON_S * 0.55, 15 - CHEVRON_S * 0.75);
    g.lineTo(10 - CHEVRON_S * 0.25, 15);
    g.lineTo(10 - CHEVRON_S * 0.55, 15 + CHEVRON_S * 0.75);
    g.closePath(); g.fill();
  });

  // corpse parts (white, tinted at runtime)
  cell('corpse-p-ell', 36, 26, 0.5, 0.5, g => {
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(18, 13, 16, 11, 0, 0, 7); g.fill();
  });
  cell('corpse-x', 24, 24, 0.5, 0.5, g => {
    g.strokeStyle = '#fff'; g.lineWidth = 5;
    g.beginPath();
    g.moveTo(3, 3); g.lineTo(21, 21);
    g.moveTo(21, 3); g.lineTo(3, 21);
    g.stroke();
  });
  cell('corpse-z-ell', 32, 22, 0.5, 0.5, g => {
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(16, 11, 14, 9, 0, 0, 7); g.fill();
  });
  cell('corpse-z-ell2', 24, 16, 0.5, 0.5, g => {
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(12, 8, 10, 6, 0, 0, 7); g.fill();
  });

  // supply crates, baked at the collision radius they are collected at
  for (const kind of ['ammo', 'health'] as PickupKind[]) {
    const R = PICKUP_RADIUS * PICKUP_SS;
    const size = Math.ceil(2 * R) + 2;
    cell(pickupKey(kind), size, size, 0.5, 0.5, g => {
      g.translate(size / 2, size / 2);
      drawPickup(g, kind, R);
    });
  }

  // soft radial falloff for lights (phase 2)
  cell('radial', 128, 128, 0.5, 0.5, g => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });

  // blood splat variants for decal stamping (phase 4) — deterministic blobs
  const SPLATS: number[][][] = [
    [[24, 24, 11], [34, 18, 5], [13, 30, 4], [30, 33, 3], [10, 16, 2.5]],
    [[24, 24, 9], [15, 15, 5.5], [35, 28, 4.5], [22, 37, 3], [37, 14, 2]],
    [[24, 24, 10], [12, 26, 4], [33, 12, 3.5], [36, 34, 4.5], [20, 10, 2.5]],
  ];
  SPLATS.forEach((blobs, i) => {
    cell(`splat-${i}`, 48, 48, 0.5, 0.5, g => {
      g.fillStyle = '#fff';
      for (const [bx, by, br] of blobs) {
        g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
      }
    });
  });

  const base = Texture.from(c);
  const entries = new Map<string, AtlasEntry>();
  for (const p of pending) {
    entries.set(p.key, {
      tex: new Texture({ source: base.source, frame: p.rect }),
      ax: p.ax, ay: p.ay,
    });
  }
  return { base, entries };
}
