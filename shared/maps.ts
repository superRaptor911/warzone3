import { TILE } from './constants.ts';
import type { DecorSpec, SerializedGrid, Vec2 } from './types.ts';

// Tile values. These three are the ENTIRE collision vocabulary and `solid()`
// below is the only thing that reads them for gameplay. Adding a fourth value
// here would make it solid on arrival (solid() is `!== T_FLOOR`), which is why
// visual variety lives in `mat` instead — see below.
export const T_FLOOR = 0;
export const T_WALL = 1;
export const T_CRATE = 2;

// ---- Render-only materials -------------------------------------------------
//
// `Grid.mat` is a second array, parallel to `tiles`, that says what a tile is
// MADE OF. It is render data and nothing else: `solid()`, `raycast()`, `los()`,
// shared/physics.ts and server/pathfinding.ts never look at it, so no material
// can shift a hitbox or desync prediction. The split is what lets T_CRATE mean
// "any waist-high solid prop" — a crate, a shipping box and a workbench have
// identical collision and differ only in `mat`.
//
// A mat byte is `id | MAT_INDOOR?`. The low 7 bits pick the material; the top
// bit says the tile is under a roof, which is the only thing gfx/lights.ts
// reads it for (a two-entry ambient lookup instead of one constant). Keeping
// indoor-ness a flag rather than baking it into the id means the same concrete
// can be a lit forecourt in one place and a dark corridor in another.
export const MAT_INDOOR = 0x80;

export const MAT = {
  VOID: 0,
  // outdoor floors
  ASPHALT: 1,
  ROAD_LINE_V: 2,   // lane marking down the middle of the tile, vertical
  ROAD_LINE_H: 3,
  GRAVEL: 4,
  GRASS: 5,
  // indoor floors
  CONCRETE: 6,
  WOOD: 7,
  FLOORTILE: 8,
  // walls (tiles[] === T_WALL)
  WALL_BRICK: 16,
  WALL_CONCRETE: 17,
  WALL_WOOD: 18,
  // solid props (tiles[] === T_CRATE)
  CRATE: 24,
  CRATE_BLUE: 25,
  CRATE_GREEN: 26,
};

// Decor frame ids. Free-position, non-colliding, non-occluding scenery; the
// art table that maps these onto sheet cells is client-side (gfx/tileset.ts).
export const DEC = {
  RUBBLE_A: 0,
  RUBBLE_B: 1,
  RUBBLE_C: 2,
  CONCRETE_CHUNK: 3,
  GLASS: 4,
  PLANK: 5,
  BOARD: 6,
  BRICK_DEBRIS: 7,
  STAIN_A: 8,
  STAIN_B: 9,
  PAPER: 10,
  WEED: 11,
};

export function matId(v: number): number { return v & 0x7f; }
export function matIndoor(v: number): boolean { return (v & MAT_INDOOR) !== 0; }

export class Grid {
  w: number;
  h: number;
  tiles: Uint8Array;
  /**
   * Material per tile — RENDER ONLY. Parallel to `tiles`, same length, same
   * indexing. Nothing in the simulation may read this: collision, the DDA
   * raycast, LOS and A* all go through `tiles` via `solid()`. If you find
   * yourself wanting `mat` in a gameplay path, the thing you want belongs in
   * `tiles` instead.
   */
  mat: Uint8Array;
  /** Free-position decorative scenery. Never collides, never occludes. */
  decor: DecorSpec[];
  redSpawns: Vec2[];
  blueSpawns: Vec2[];
  survivorSpawns: Vec2[];
  zombieSpawns: Vec2[];

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.tiles = new Uint8Array(w * h);
    this.mat = new Uint8Array(w * h);
    this.decor = [];
    this.redSpawns = []; this.blueSpawns = [];
    this.survivorSpawns = []; this.zombieSpawns = [];
  }
  idx(tx: number, ty: number): number { return ty * this.w + tx; }
  get(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return T_WALL;
    return this.tiles[this.idx(tx, ty)];
  }
  set(tx: number, ty: number, v: number): void {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.tiles[this.idx(tx, ty)] = v;
  }
  /** Material byte at a tile (id + MAT_INDOOR flag). Out of bounds reads VOID. */
  matAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return MAT.VOID;
    return this.mat[this.idx(tx, ty)];
  }
  setMat(tx: number, ty: number, v: number): void {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.mat[this.idx(tx, ty)] = v;
  }
  /**
   * Material of the floor a solid tile stands on, for drawing beneath props
   * whose art does not fill the cell. Takes the first non-solid 4-neighbour so
   * a crate in a wood room sits on wood and one in the street sits on asphalt;
   * falls back to the tile's own material when a prop is walled in on all
   * sides. Render-only, like everything else about `mat`.
   */
  floorMatUnder(tx: number, ty: number): number {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      if (!this.solid(tx + dx, ty + dy)) return this.matAt(tx + dx, ty + dy);
    }
    return this.matAt(tx, ty);
  }
  solid(tx: number, ty: number): boolean { return this.get(tx, ty) !== T_FLOOR; }
  solidAtPx(x: number, y: number): boolean { return this.solid(Math.floor(x / TILE), Math.floor(y / TILE)); }
  pxW(): number { return this.w * TILE; }
  pxH(): number { return this.h * TILE; }

  // Raycast through the tile grid (DDA). Returns distance to first solid tile
  // along (dx,dy) from (x,y), capped at maxDist. dx,dy must be normalized.
  raycast(x: number, y: number, dx: number, dy: number, maxDist: number): number {
    let tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (this.solid(tx, ty)) return 0;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
    let tMaxX = dx !== 0
      ? ((dx > 0 ? (tx + 1) * TILE - x : x - tx * TILE) / Math.abs(dx)) : Infinity;
    let tMaxY = dy !== 0
      ? ((dy > 0 ? (ty + 1) * TILE - y : y - ty * TILE) / Math.abs(dy)) : Infinity;
    let dist = 0;
    while (dist <= maxDist) {
      if (tMaxX < tMaxY) { dist = tMaxX; tMaxX += tDeltaX; tx += stepX; }
      else { dist = tMaxY; tMaxY += tDeltaY; ty += stepY; }
      if (dist > maxDist) break;
      if (this.solid(tx, ty)) return dist;
    }
    return maxDist;
  }

  // Line of sight between two points (centers), true if no solid tile between.
  los(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return true;
    return this.raycast(x0, y0, dx / d, dy / d, d) >= d - 0.5;
  }

  serialize(): SerializedGrid {
    return {
      w: this.w, h: this.h, tiles: Array.from(this.tiles), mat: Array.from(this.mat),
      decor: this.decor,
      redSpawns: this.redSpawns, blueSpawns: this.blueSpawns,
      survivorSpawns: this.survivorSpawns, zombieSpawns: this.zombieSpawns,
    };
  }
  static deserialize(o: SerializedGrid): Grid {
    const g = new Grid(o.w, o.h);
    g.tiles.set(o.tiles);
    // Tolerated rather than required: an older server sends no `mat`, and a
    // world with no materials should still be a playable world with a loud
    // renderer error, not a client that throws while parsing `welcome`.
    if (o.mat) g.mat.set(o.mat);
    g.decor = o.decor || [];
    g.redSpawns = o.redSpawns; g.blueSpawns = o.blueSpawns;
    g.survivorSpawns = o.survivorSpawns; g.zombieSpawns = o.zombieSpawns;
    return g;
  }
}

// ---- builder helpers ----
function border(g: Grid): void {
  for (let x = 0; x < g.w; x++) { g.set(x, 0, T_WALL); g.set(x, g.h - 1, T_WALL); }
  for (let y = 0; y < g.h; y++) { g.set(0, y, T_WALL); g.set(g.w - 1, y, T_WALL); }
}
function fillRect(g: Grid, x0: number, y0: number, x1: number, y1: number, v: number = T_WALL): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.set(x, y, v);
}
function hollowRect(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x++) { g.set(x, y0, T_WALL); g.set(x, y1, T_WALL); }
  for (let y = y0; y <= y1; y++) { g.set(x0, y, T_WALL); g.set(x1, y, T_WALL); }
}
function door(g: Grid, x: number, y: number): void { g.set(x, y, T_FLOOR); }
function crate(g: Grid, x: number, y: number, m: number = MAT.CRATE): void {
  g.set(x, y, T_CRATE); g.setMat(x, y, m);
}
const px = (t: number) => t * TILE + TILE / 2; // tile -> world center

// ---- material helpers ----
// A region almost never means "every tile in this box": you floor a room
// without recladding its walls, or reclad a building without repainting the
// floor inside. So the filter names the tile KIND rather than just solidity —
// a "solid" filter would have quietly relabelled every crate as wall the first
// time a perimeter was painted, which is exactly the bug this shape prevents.
function paint(
  g: Grid, x0: number, y0: number, x1: number, y1: number, m: number,
  only: number | 'all' = 'all',
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      if (only !== 'all' && g.get(x, y) !== only) continue;
      g.setMat(x, y, m);
    }
  }
}
const paintFloor = (g: Grid, x0: number, y0: number, x1: number, y1: number, m: number): void =>
  paint(g, x0, y0, x1, y1, m, T_FLOOR);
const paintWall = (g: Grid, x0: number, y0: number, x1: number, y1: number, m: number): void =>
  paint(g, x0, y0, x1, y1, m, T_WALL);
const paintCrate = (g: Grid, x0: number, y0: number, x1: number, y1: number, m: number): void =>
  paint(g, x0, y0, x1, y1, m, T_CRATE);

/** One authored piece of scenery, positioned in tile space with a sub-tile offset. */
function dec(g: Grid, tx: number, ty: number, f: number, rot = 0, s = 1,
             ox = 0, oy = 0): void {
  g.decor.push({ x: px(tx) + ox, y: px(ty) + oy, rot, s, f });
}

// Deterministic PRNG for scattering. Authoring stays intentional at the level
// that matters (which region, which frames, how dense) while the exact litter
// placement is generated — and generated the SAME way every build, so the two
// maps are byte-identical run to run and the tests can assert on them.
function rnd(seed: number): () => number {
  let s = (seed * 2654435761) | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0x1000000;
  };
}

/**
 * Litters `n` decor items from `frames` across the floor tiles of a region.
 * Skips solid tiles, so it can be aimed at a whole building without dressing
 * its walls, and keeps everything inside the tile so nothing straddles a wall.
 */
function scatter(
  g: Grid, x0: number, y0: number, x1: number, y1: number,
  frames: number[], n: number, seed: number, sMin = 0.5, sMax = 0.9,
): void {
  const r = rnd(seed);
  for (let i = 0; i < n; i++) {
    const tx = x0 + Math.floor(r() * (x1 - x0 + 1));
    const ty = y0 + Math.floor(r() * (y1 - y0 + 1));
    const f = frames[Math.floor(r() * frames.length)];
    const rot = r() * Math.PI * 2;
    const s = sMin + r() * (sMax - sMin);
    // keep the whole item inside its tile: at most a third of a tile off-centre
    const ox = (r() - 0.5) * TILE * 0.6, oy = (r() - 0.5) * TILE * 0.6;
    if (g.solid(tx, ty)) continue;
    dec(g, tx, ty, f, rot, s, ox, oy);
  }
}

// Mirror helper for symmetric TDM maps: applies fn(x,y) and fn(w-1-x, y).
type MirrorSet = (x: number, y: number, v: number) => void;
function mirrored(g: Grid, fn: (set: MirrorSet) => void): void {
  fn((x, y, v) => { g.set(x, y, v); g.set(g.w - 1 - x, y, v); });
}

// ---- Map: "Compound" (5v5 TDM), 40 x 30 ----
function buildCompound(): Grid {
  const g = new Grid(40, 30);
  border(g);

  // Base walls with three gaps each side (top / mid / bottom lanes)
  mirrored(g, (set) => {
    for (let y = 2; y <= 27; y++) set(7, y, T_WALL);
    for (const y of [5, 6, 14, 15, 23, 24]) set(7, y, T_FLOOR);
  });

  // Central building with 4 doors
  hollowRect(g, 16, 11, 23, 18);
  door(g, 19, 11); door(g, 20, 11);
  door(g, 19, 18); door(g, 20, 18);
  door(g, 16, 14); door(g, 16, 15);
  door(g, 23, 14); door(g, 23, 15);

  // Top-lane structures
  mirrored(g, (set) => {
    for (let x = 11; x <= 14; x++) set(x, 6, T_WALL);
    set(11, 7, T_WALL);
  });
  // Bottom-lane structures
  mirrored(g, (set) => {
    for (let x = 11; x <= 14; x++) set(x, 23, T_WALL);
    set(11, 22, T_WALL);
  });
  // Mid flank walls
  mirrored(g, (set) => {
    for (let y = 12; y <= 17; y++) set(11, y, T_WALL);
  });

  // Crates: cover sprinkled through lanes (mirrored)
  mirrored(g, (set) => {
    set(10, 3, T_CRATE); set(10, 4, T_CRATE);
    set(14, 9, T_CRATE);
    set(10, 26, T_CRATE); set(10, 25, T_CRATE);
    set(14, 20, T_CRATE);
    set(13, 14, T_CRATE); set(13, 15, T_CRATE);
    set(18, 5, T_CRATE);
    set(18, 24, T_CRATE);
  });
  crate(g, 19, 2); crate(g, 20, 27);

  // ---- materials: a vehicle depot ----
  // Geometry above is untouched; everything below only says what it is made of.
  paint(g, 0, 0, 39, 29, MAT.ASPHALT);                       // forecourt tarmac
  // The two spawn halves behind the base walls are the loading sheds — the one
  // place a 6x28 strip of nothing reads as a building rather than dead space.
  paintFloor(g, 1, 1, 6, 28, MAT.CONCRETE | MAT_INDOOR);
  paintFloor(g, 33, 1, 38, 28, MAT.CONCRETE | MAT_INDOOR);
  // Unpaved middle: the flank approach nobody drives on.
  paintFloor(g, 8, 11, 15, 18, MAT.GRAVEL);
  paintFloor(g, 24, 11, 31, 18, MAT.GRAVEL);
  // Service roads across the top and bottom lanes, and the centre aisle.
  paintFloor(g, 8, 3, 31, 3, MAT.ROAD_LINE_H);
  paintFloor(g, 8, 26, 31, 26, MAT.ROAD_LINE_H);
  paintFloor(g, 19, 1, 19, 9, MAT.ROAD_LINE_V);
  paintFloor(g, 19, 20, 19, 28, MAT.ROAD_LINE_V);
  // Weeds where the tarmac has given up, against the shed walls.
  paintFloor(g, 8, 8, 9, 10, MAT.GRASS);
  paintFloor(g, 30, 8, 31, 10, MAT.GRASS);
  paintFloor(g, 8, 19, 9, 21, MAT.GRASS);
  paintFloor(g, 30, 19, 31, 21, MAT.GRASS);
  // The depot office in the middle. Painted over the whole footprint, not just
  // the interior, so the four doorways are office floor too — a threshold tile
  // left as tarmac reads as a hole in the building.
  paintFloor(g, 16, 11, 23, 18, MAT.CONCRETE | MAT_INDOOR);

  // Walls: the broad pass FIRST, then everything specific over the top of it.
  paintWall(g, 0, 0, 39, 29, MAT.WALL_CONCRETE);             // perimeter + sheds
  paintWall(g, 16, 11, 23, 18, MAT.WALL_BRICK);              // the office
  // Timber barricades: the lane stubs and the mid flanks.
  paintWall(g, 11, 6, 14, 7, MAT.WALL_WOOD);
  paintWall(g, 25, 6, 28, 7, MAT.WALL_WOOD);
  paintWall(g, 11, 22, 14, 23, MAT.WALL_WOOD);
  paintWall(g, 25, 22, 28, 23, MAT.WALL_WOOD);
  paintWall(g, 11, 12, 11, 17, MAT.WALL_WOOD);
  paintWall(g, 28, 12, 28, 17, MAT.WALL_WOOD);

  // Crates last, since the perimeter pass above deliberately does not touch
  // them. Blue boxes flag the two mid-lane stacks both teams fight over.
  paintCrate(g, 0, 0, 39, 29, MAT.CRATE);
  paintCrate(g, 13, 14, 13, 15, MAT.CRATE_BLUE);
  paintCrate(g, 26, 14, 26, 15, MAT.CRATE_BLUE);
  paintCrate(g, 19, 2, 20, 2, MAT.CRATE_GREEN);
  paintCrate(g, 19, 27, 20, 27, MAT.CRATE_GREEN);

  // Dressing. Oil on the forecourt, spoil around the office, litter in the
  // sheds, offcuts by the timber.
  dec(g, 17, 8, DEC.STAIN_A, 0.3, 1.1); dec(g, 22, 21, DEC.STAIN_A, 2.1, 1.1);
  dec(g, 12, 25, DEC.STAIN_B, 1.2, 0.9); dec(g, 27, 4, DEC.STAIN_B, 4.0, 0.9);
  scatter(g, 15, 9, 24, 20, [DEC.RUBBLE_A, DEC.RUBBLE_B, DEC.CONCRETE_CHUNK], 22, 101);
  scatter(g, 1, 1, 6, 28, [DEC.PAPER, DEC.RUBBLE_C], 14, 202, 0.4, 0.7);
  scatter(g, 33, 1, 38, 28, [DEC.PAPER, DEC.RUBBLE_C], 14, 303, 0.4, 0.7);
  scatter(g, 10, 5, 15, 8, [DEC.PLANK, DEC.BOARD], 8, 404);
  scatter(g, 24, 21, 29, 24, [DEC.PLANK, DEC.BOARD], 8, 505);
  scatter(g, 8, 8, 9, 21, [DEC.WEED], 10, 606, 0.5, 0.8);
  scatter(g, 30, 8, 31, 21, [DEC.WEED], 10, 707, 0.5, 0.8);

  for (const y of [4, 9, 14, 15, 20, 25]) {
    g.redSpawns.push({ x: px(3), y: px(y) });
    g.blueSpawns.push({ x: px(36), y: px(y) });
  }
  // survival fallbacks (unused in TDM)
  g.survivorSpawns.push({ x: px(19), y: px(14) });
  g.zombieSpawns.push({ x: px(2), y: px(2) });
  return g;
}

// ---- Map: "Outbreak" (zombie survival), 44 x 34 ----
function buildOutbreak(): Grid {
  const g = new Grid(44, 34);
  border(g);

  // Central compound the survivors start around (hollow, 4 doors)
  hollowRect(g, 18, 13, 25, 20);
  door(g, 21, 13); door(g, 22, 13);
  door(g, 21, 20); door(g, 22, 20);
  door(g, 18, 16); door(g, 18, 17);
  door(g, 25, 16); door(g, 25, 17);

  // Ruined buildings scattered around (each with openings)
  hollowRect(g, 5, 4, 11, 9);   door(g, 8, 9); door(g, 11, 6);
  hollowRect(g, 32, 4, 38, 9);  door(g, 35, 9); door(g, 32, 6);
  hollowRect(g, 5, 24, 11, 29); door(g, 8, 24); door(g, 11, 27);
  hollowRect(g, 32, 24, 38, 29); door(g, 35, 24); door(g, 32, 27);

  // Wall segments forming choke points
  for (let x = 14; x <= 16; x++) { g.set(x, 8, T_WALL); g.set(x, 25, T_WALL); }
  for (let x = 27; x <= 29; x++) { g.set(x, 8, T_WALL); g.set(x, 25, T_WALL); }
  for (let y = 14; y <= 19; y++) { g.set(13, y, T_WALL); g.set(30, y, T_WALL); }
  g.set(13, 16, T_FLOOR); g.set(13, 17, T_FLOOR);
  g.set(30, 16, T_FLOOR); g.set(30, 17, T_FLOOR);

  // Crates as kiting cover
  for (const [x, y] of [[15, 4], [28, 4], [15, 29], [28, 29], [21, 7], [22, 26],
    [8, 15], [8, 18], [35, 15], [35, 18], [16, 11], [27, 22], [16, 22], [27, 11]]) {
    crate(g, x, y);
  }

  // ---- materials: a quarantined city block ----
  // Geometry above is untouched; everything below only says what it is made of.
  paint(g, 0, 0, 43, 33, MAT.ASPHALT);                       // the street
  // The broad wall pass runs FIRST so the per-building cladding below survives
  // it; the other way round, the perimeter silently re-concretes every building.
  paintWall(g, 0, 0, 43, 33, MAT.WALL_CONCRETE);
  // Four buildings around a barricaded block. Two are flats (boarded floors),
  // two are shopfronts (tiled), so a survivor can tell which corner they are in
  // from the ground alone — the whole point of authoring materials by room.
  // Footprints, not interiors, so doorway tiles belong to the building.
  paintFloor(g, 5, 4, 11, 9, MAT.WOOD | MAT_INDOOR);
  paintWall(g, 5, 4, 11, 9, MAT.WALL_BRICK);
  paintFloor(g, 32, 4, 38, 9, MAT.FLOORTILE | MAT_INDOOR);
  paintFloor(g, 5, 24, 11, 29, MAT.FLOORTILE | MAT_INDOOR);
  paintFloor(g, 32, 24, 38, 29, MAT.WOOD | MAT_INDOOR);
  paintWall(g, 32, 24, 38, 29, MAT.WALL_BRICK);
  // The compound the squad holds: a stripped ground-floor lobby.
  paintFloor(g, 18, 13, 25, 20, MAT.WOOD | MAT_INDOOR);
  paintWall(g, 18, 13, 25, 20, MAT.WALL_BRICK);
  // Streets: two crosstown, one down the middle either side of the compound.
  paintFloor(g, 2, 11, 41, 11, MAT.ROAD_LINE_H);
  paintFloor(g, 2, 22, 41, 22, MAT.ROAD_LINE_H);
  paintFloor(g, 21, 1, 21, 10, MAT.ROAD_LINE_V);
  paintFloor(g, 21, 23, 21, 32, MAT.ROAD_LINE_V);
  // Overgrown lots between the buildings, and grit along the choke walls.
  paintFloor(g, 13, 1, 17, 6, MAT.GRASS);
  paintFloor(g, 26, 1, 30, 6, MAT.GRASS);
  paintFloor(g, 13, 27, 17, 32, MAT.GRASS);
  paintFloor(g, 26, 27, 30, 32, MAT.GRASS);
  paintFloor(g, 13, 12, 16, 21, MAT.GRAVEL);
  paintFloor(g, 27, 12, 30, 21, MAT.GRAVEL);
  // The loose choke walls: poured barriers at the corners, boarded hoardings
  // flanking the compound.
  paintWall(g, 13, 14, 13, 19, MAT.WALL_WOOD);
  paintWall(g, 30, 14, 30, 19, MAT.WALL_WOOD);

  paintCrate(g, 0, 0, 43, 33, MAT.CRATE);
  paintCrate(g, 8, 15, 8, 18, MAT.CRATE_BLUE);
  paintCrate(g, 35, 15, 35, 18, MAT.CRATE_BLUE);

  // Dressing. Collapse spoil in and around the four buildings, glass at their
  // doorways, oil down the streets, weeds on the lots.
  for (const [bx, by] of [[5, 4], [32, 4], [5, 24], [32, 24]]) {
    scatter(g, bx + 1, by + 1, bx + 5, by + 4,
      [DEC.RUBBLE_A, DEC.CONCRETE_CHUNK, DEC.BRICK_DEBRIS, DEC.PAPER], 16, bx * 31 + by);
    scatter(g, bx - 1, by - 1, bx + 7, by + 7, [DEC.GLASS, DEC.RUBBLE_B], 12, bx * 17 + by * 5);
  }
  scatter(g, 2, 11, 41, 11, [DEC.STAIN_A, DEC.STAIN_B], 9, 811, 0.7, 1.1);
  scatter(g, 2, 22, 41, 22, [DEC.STAIN_A, DEC.STAIN_B], 9, 822, 0.7, 1.1);
  scatter(g, 13, 1, 30, 6, [DEC.WEED, DEC.RUBBLE_C], 18, 901, 0.5, 0.9);
  scatter(g, 13, 27, 30, 32, [DEC.WEED, DEC.RUBBLE_C], 18, 902, 0.5, 0.9);
  scatter(g, 14, 12, 29, 21, [DEC.PLANK, DEC.BOARD, DEC.RUBBLE_A], 14, 903);

  // Survivor spawns inside the compound
  for (const [x, y] of [[20, 15], [23, 15], [20, 18], [23, 18], [21, 16]]) {
    g.survivorSpawns.push({ x: px(x), y: px(y) });
  }
  // Zombie spawns at map edges + far corners of buildings
  for (const [x, y] of [[2, 2], [41, 2], [2, 31], [41, 31], [21, 2], [22, 31], [2, 16], [41, 16]]) {
    g.zombieSpawns.push({ x: px(x), y: px(y) });
  }
  // TDM fallbacks (unused)
  g.redSpawns.push({ x: px(2), y: px(16) });
  g.blueSpawns.push({ x: px(41), y: px(16) });
  return g;
}

export const MAPS: Record<string, () => Grid> = {
  compound: buildCompound,
  outbreak: buildOutbreak,
};

export function buildMap(name: string): Grid {
  const fn = MAPS[name];
  if (!fn) throw new Error('unknown map: ' + name);
  return fn();
}
