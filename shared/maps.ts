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
  TILE_RED: 9,      // terracotta slabs: a lobby / shopfront floor
  CARPET_RED: 10,   // fitted carpet. A hard edge against boards is CORRECT here
  CARPET_GREEN: 11, // — see the note on material seams in tasks/WORLD-ART.md
  // walls (tiles[] === T_WALL)
  WALL_BRICK: 16,
  WALL_CONCRETE: 17,
  WALL_WOOD: 18,
  WALL_PLASTER: 19, // pale interior partition: what divides one flat from the next
  WALL_PLANK: 20,   // nailed boards: hoardings, site fencing, a boarded shopfront
  // Solid props (tiles[] === T_CRATE). Every one of these has the SAME collision
  // as a crate — a whole 48px tile — so the vocabulary below is entirely about
  // what a room is furnished with, never about how it plays. Furniture that must
  // not collide is `decor` instead.
  CRATE: 24,
  CRATE_BLUE: 25,
  CRATE_GREEN: 26,
  WORKBENCH: 27,    // full-cell timber surface: benches, stacked stock, dock edge
  DESK: 28,
  TABLE: 29,
  TABLE_ROUND: 30,
  COUNTER: 31,      // kitchen worktop
  SINK: 32,
  STOVE: 33,
  OVEN: 34,
  // Multi-tile furniture: one mat per tile, and the pieces only read in order.
  // `propRun` places them; authoring one out of sequence draws a sofa with two
  // left arms rather than throwing, so keep the runs to that helper.
  SOFA_L: 35, SOFA_M: 36, SOFA_R: 37,           // green, back to the north
  SOFA_RED_L: 38, SOFA_RED_M: 39, SOFA_RED_R: 40,
  ARMCHAIR: 41,
  BED_FOOT: 42, BED_HEAD: 43,                   // green blanket, head to the south
  BED_RED_FOOT: 44, BED_RED_HEAD: 45,
};

// ---- Overheads (`Grid.over`) ----------------------------------------------
//
// Props that hang ABOVE the play field: awnings, pipe runs, walkways. They are a
// third parallel array rather than another `mat` value for a simple reason — an
// overhead does not replace the ground under it. A canopy over the forecourt has
// asphalt beneath it, and a mat byte can only name one material, so folding the
// two together would either lose the floor or need a combined id per pairing.
//
// Nothing renders these yet (phase 3 draws them above `actors` and x-rays what
// they hide, see tasks/WORLD-ART.md). They are authored now so that neither map
// has to be laid out twice.
export const OVER = {
  NONE: 0,
  AWNING: 1,    // timber loading-dock / shopfront awning, autotiled as a 9-slice
  PIPE: 2,      // fat industrial pipe, straight runs only
  CONDUIT: 3,   // thin conduit, straight runs only
};

/**
 * Declared height of each overhead: the clearance under it, in world px.
 *
 * It is real data rather than decoration. Phase 3 draws overlapping overheads in
 * height order (a conduit crosses over a pipe, both cross over an awning), and
 * the occlusion test is "is anything above the actor at all", which is only a
 * safe question to ask because every declared clearance is well above head
 * height — nothing here is a knee-high obstacle that would need a body compared
 * against it.
 */
export const OVER_HEIGHT: Record<number, number> = {
  [OVER.AWNING]: 190,
  [OVER.PIPE]: 250,
  [OVER.CONDUIT]: 275,
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
  // Interiors. Dressing a room needs things too small to stop a bullet: crockery
  // on a counter, a houseplant in a corner, a shrub in a lot.
  PLATE: 12,
  CUPS: 13,
  POT: 14,
  PLANT: 15,
  BUSH: 16,
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
  /**
   * Overhead prop per tile — RENDER ONLY, and parallel to `tiles` like `mat`.
   * 0 is "nothing above this tile". See the note on OVER for why this is its own
   * array rather than another material value.
   */
  over: Uint8Array;
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
    this.over = new Uint8Array(w * h);
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
  /** Overhead prop id above a tile, 0 for none. Out of bounds reads none. */
  overAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return OVER.NONE;
    return this.over[this.idx(tx, ty)];
  }
  setOver(tx: number, ty: number, v: number): void {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.over[this.idx(tx, ty)] = v;
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
      over: Array.from(this.over), decor: this.decor,
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
    if (o.over) g.over.set(o.over);
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
function hollowRect(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x++) { g.set(x, y0, T_WALL); g.set(x, y1, T_WALL); }
  for (let y = y0; y <= y1; y++) { g.set(x0, y, T_WALL); g.set(x1, y, T_WALL); }
}
function door(g: Grid, x: number, y: number): void { g.set(x, y, T_FLOOR); }
function crate(g: Grid, x: number, y: number, m: number = MAT.CRATE): void {
  g.set(x, y, T_CRATE); g.setMat(x, y, m);
}
/**
 * A prop that spans several tiles — a sofa, a bed, a counter run. Collision is
 * the same tile-by-tile solid a single crate is; the run only exists because the
 * pieces of the art are separate cells and only read in order.
 */
function propRun(g: Grid, x: number, y: number, dir: 'h' | 'v', mats: number[]): void {
  mats.forEach((m, i) => crate(g, x + (dir === 'h' ? i : 0), y + (dir === 'v' ? i : 0), m));
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

/**
 * Hangs an overhead over a region. Unlike `paint` there is no tile-kind filter:
 * an awning bolted to a building legitimately covers the wall it is bolted to as
 * well as the pavement in front of it, and only the covered *floor* counts
 * against the overhead budget (nobody is ever hidden standing inside a wall).
 */
function paintOver(g: Grid, x0: number, y0: number, x1: number, y1: number, id: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.setOver(x, y, id);
}

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
 *
 * Returns what it actually placed, which is how `rotated` gets a symmetric twin
 * for each item: re-running the same seed over the rotated region would litter
 * the same *pattern*, not the same *places*, and the two halves would visibly
 * disagree about which tiles are dirty.
 */
function scatter(
  g: Grid, x0: number, y0: number, x1: number, y1: number,
  frames: number[], n: number, seed: number, sMin = 0.5, sMax = 0.9,
): DecorSpec[] {
  const r = rnd(seed);
  const placed: DecorSpec[] = [];
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
    placed.push(g.decor[g.decor.length - 1]);
  }
  return placed;
}

// ---- rotational symmetry ---------------------------------------------------
//
// Compound is authored through this and nothing else, which is what makes it
// provably fair: every write lands twice, once as given and once rotated 180°
// about the map centre, so each team's half is the other's exactly.
//
// It replaces the mirror the map used to be built with. A mirror is just as fair
// and reads as a mirror: with an axis of symmetry down the middle of the screen,
// paired features sit side by side in one field of view and the eye finds them
// immediately. Under a 180° rotation the pairs are a map apart, so the same
// guarantee costs nothing and stops advertising itself — which is why modern
// competitive shooters are built this way.
//
// Compound is 40x30 — both dimensions even, so no tile is its own twin and the
// symmetry is exact rather than approximate along a seam. `test/matchflow.ts`
// asserts that too, since an odd dimension would silently make one row or column
// a special case.
interface Sym {
  set(x: number, y: number, v: number): void;
  hollow(x0: number, y0: number, x1: number, y1: number): void;
  door(x: number, y: number): void;
  crate(x: number, y: number, m?: number): void;
  paint(x0: number, y0: number, x1: number, y1: number, m: number, only?: number | 'all'): void;
  over(x0: number, y0: number, x1: number, y1: number, id: number): void;
  dec(tx: number, ty: number, f: number, rot?: number, s?: number, ox?: number, oy?: number): void;
  scatter(x0: number, y0: number, x1: number, y1: number,
          frames: number[], n: number, seed: number, sMin?: number, sMax?: number): void;
  /** Authored spawns land in `redSpawns`; their rotations become `blueSpawns`. */
  spawns(pts: [number, number][]): void;
}

function rotated(g: Grid, fn: (r: Sym) => void): void {
  const rx = (x: number): number => g.w - 1 - x;
  const ry = (y: number): number => g.h - 1 - y;
  // A rotated rectangle keeps its corners but swaps which is which.
  const rect = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] =>
    [rx(x1), ry(y1), rx(x0), ry(y0)];
  const twin = (d: DecorSpec): void => {
    g.decor.push({ x: g.pxW() - d.x, y: g.pxH() - d.y, rot: d.rot + Math.PI, s: d.s, f: d.f });
  };
  fn({
    set: (x, y, v) => { g.set(x, y, v); g.set(rx(x), ry(y), v); },
    hollow: (x0, y0, x1, y1) => {
      hollowRect(g, x0, y0, x1, y1); hollowRect(g, ...rect(x0, y0, x1, y1));
    },
    door: (x, y) => { door(g, x, y); door(g, rx(x), ry(y)); },
    crate: (x, y, m = MAT.CRATE) => { crate(g, x, y, m); crate(g, rx(x), ry(y), m); },
    paint: (x0, y0, x1, y1, m, only = 'all') => {
      paint(g, x0, y0, x1, y1, m, only); paint(g, ...rect(x0, y0, x1, y1), m, only);
    },
    over: (x0, y0, x1, y1, id) => {
      paintOver(g, x0, y0, x1, y1, id); paintOver(g, ...rect(x0, y0, x1, y1), id);
    },
    dec: (tx, ty, f, rot = 0, s = 1, ox = 0, oy = 0) => {
      dec(g, tx, ty, f, rot, s, ox, oy);
      twin(g.decor[g.decor.length - 1]);
    },
    scatter: (x0, y0, x1, y1, frames, n, seed, sMin, sMax) => {
      for (const d of scatter(g, x0, y0, x1, y1, frames, n, seed, sMin, sMax)) twin(d);
    },
    spawns: (pts) => {
      for (const [x, y] of pts) {
        g.redSpawns.push({ x: px(x), y: px(y) });
        g.blueSpawns.push({ x: px(rx(x)), y: px(ry(y)) });
      }
    },
  });
}

// ---- Map: "Compound" (5v5 TDM), 40 x 30 ----
//
// A vehicle depot behind a checkpoint: two three-room base buildings, a forecourt
// with a covered loading dock, a gravel plant yard, and a brick guard post in the
// middle that both teams cross to reach each other.
//
// Every write below goes through `rotated`, so the west half is authored and the
// east half is its 180° twin. Two rules come with that:
//   - Directional furniture is out. A sofa authored with its back to the north
//     wall lands, rotated, with its back to open floor; the props used here read
//     the same either way up (benches, desks, round tables, crates, counters).
//   - Anything authored across the centre line is written twice over the same
//     tiles, which is harmless but must still be symmetric in itself — the guard
//     post is authored as one L and closed by its own rotation.
function buildCompound(): Grid {
  const g = new Grid(40, 30);
  border(g);

  rotated(g, (r) => {
    // ---- the base building: three rooms behind a wall with three lane mouths.
    // The gap rows are symmetric about the centre line on purpose, so the lanes
    // stay straight while everything else about the two halves rotates.
    for (let y = 1; y <= 28; y++) r.set(7, y, T_WALL);
    for (const y of [5, 6, 14, 15, 23, 24]) r.set(7, y, T_FLOOR);
    // Internal partitions: muster room (y 1-9), office (11-18), workshop (20-28).
    for (let x = 1; x <= 6; x++) { r.set(x, 10, T_WALL); r.set(x, 19, T_WALL); }
    r.door(2, 10); r.door(5, 19);

    // Muster room: stock stacked down the outside wall, a bench, a brew table.
    r.crate(1, 1); r.crate(1, 2);
    r.crate(5, 2, MAT.WORKBENCH); r.crate(6, 2, MAT.WORKBENCH);
    r.crate(4, 6, MAT.TABLE_ROUND);
    r.crate(2, 8, MAT.DESK);
    // Office: desks on the rug where they read against it, the white filing
    // counter on the boards where it does. Spawn tiles (3,14)/(3,15) stay clear.
    r.crate(2, 12, MAT.DESK); r.crate(4, 16, MAT.TABLE);
    r.crate(5, 13, MAT.DESK); r.crate(1, 17, MAT.COUNTER);
    // Workshop: a bench run against the partition, stock stacked in the corner.
    r.crate(4, 21, MAT.WORKBENCH); r.crate(5, 21, MAT.WORKBENCH);
    r.crate(6, 21, MAT.WORKBENCH);
    r.crate(1, 27); r.crate(1, 28); r.crate(2, 28);

    // ---- forecourt, north: the loading dock. Timber shed, open to the road,
    // with its awning over the truck bay in front of it.
    r.hollow(9, 2, 14, 6);
    r.door(11, 6); r.door(12, 6);
    r.crate(10, 3, MAT.WORKBENCH); r.crate(11, 3, MAT.WORKBENCH);
    r.crate(13, 5);
    r.over(10, 7, 13, 8, OVER.AWNING);
    // A stub of wall east of the dock, so the top lane is not a straight run.
    for (let x = 16; x <= 18; x++) r.set(x, 5, T_WALL);
    r.set(16, 6, T_WALL);
    r.crate(19, 4, MAT.CRATE_GREEN); r.crate(19, 5, MAT.CRATE_GREEN);

    // ---- forecourt, mid: the flank hoarding and the crate stack behind it.
    for (let y = 12; y <= 17; y++) r.set(11, y, T_WALL);
    r.crate(13, 14, MAT.CRATE_BLUE); r.crate(13, 15, MAT.CRATE_BLUE);
    r.crate(9, 12); r.crate(9, 17);
    // Conduit crossing the mid lane, the one overhead a duel happens under.
    r.over(12, 13, 14, 13, OVER.CONDUIT);

    // ---- forecourt, south: the plant yard. Gravel, a hoarding along its east
    // side, drums and stock left out in it.
    for (let y = 22; y <= 25; y++) r.set(16, y, T_WALL);
    r.crate(14, 22); r.crate(14, 23);
    r.crate(10, 26, MAT.WORKBENCH); r.crate(11, 26, MAT.WORKBENCH);
    r.crate(9, 22, MAT.TABLE_ROUND);

    // ---- the guard post in the middle. One L is authored; its own rotation
    // closes the box and leaves a single tile open at each of two corners, so
    // the room has four mouths on the lanes and two diagonal ways in.
    for (let x = 17; x <= 22; x++) r.set(x, 12, T_WALL);
    r.door(19, 12); r.door(20, 12);
    for (let y = 12; y <= 15; y++) r.set(17, y, T_WALL);
    r.crate(19, 14, MAT.DESK);
    r.crate(18, 16);

    // ---- materials. Broad first, specific over the top — and every broad pass
    // is filtered to ONE tile kind. An unfiltered "everything is asphalt" opener
    // silently relabels every desk, bench and bed placed above as tarmac, which
    // the old blanket crate pass at the end used to paper over; now that props
    // carry authored materials there is nothing to paper over it with, and the
    // furniture simply draws as bare ground.
    r.paint(0, 0, 39, 29, MAT.ASPHALT, T_FLOOR);
    r.paint(1, 1, 6, 9, MAT.CONCRETE | MAT_INDOOR, T_FLOOR);      // muster
    r.paint(1, 11, 6, 18, MAT.WOOD | MAT_INDOOR, T_FLOOR);        // office
    r.paint(2, 12, 4, 16, MAT.CARPET_RED | MAT_INDOOR, T_FLOOR);  // ...and its rug
    r.paint(1, 20, 6, 28, MAT.CONCRETE | MAT_INDOOR, T_FLOOR);    // workshop
    r.paint(9, 2, 14, 6, MAT.CONCRETE | MAT_INDOOR, T_FLOOR);     // the dock shed
    r.paint(17, 12, 22, 17, MAT.FLOORTILE | MAT_INDOOR, T_FLOOR); // the guard post
    // Gravel where nothing drives: the flank strip between base wall and
    // hoarding, and the plant yard. Both are bounded by walls rather than
    // fading out mid-forecourt, which is what keeps the seams deliberate.
    r.paint(8, 12, 10, 17, MAT.GRAVEL, T_FLOOR);
    r.paint(9, 22, 15, 26, MAT.GRAVEL, T_FLOOR);
    // Service roads: one along the dock frontage, one down the centre aisle.
    r.paint(8, 8, 31, 8, MAT.ROAD_LINE_H, T_FLOOR);
    r.paint(19, 1, 19, 11, MAT.ROAD_LINE_V, T_FLOOR);
    // Weeds where the tarmac has given up, against the base wall.
    r.paint(8, 1, 8, 4, MAT.GRASS, T_FLOOR);
    r.paint(8, 19, 10, 20, MAT.GRASS, T_FLOOR);

    r.paint(0, 0, 39, 29, MAT.WALL_CONCRETE, T_WALL);   // perimeter + base shells
    r.paint(1, 10, 6, 19, MAT.WALL_PLASTER, T_WALL);    // base partitions
    r.paint(17, 12, 22, 17, MAT.WALL_BRICK, T_WALL);    // the guard post
    r.paint(9, 2, 14, 6, MAT.WALL_WOOD, T_WALL);        // the dock shed
    r.paint(11, 12, 11, 17, MAT.WALL_PLANK, T_WALL);    // flank hoarding
    r.paint(16, 22, 16, 25, MAT.WALL_PLANK, T_WALL);    // yard hoarding
    r.paint(16, 5, 18, 6, MAT.WALL_PLANK, T_WALL);      // top-lane stub

    // ---- dressing. Oil on the forecourt, spoil round the post, offcuts by the
    // timber, litter indoors, weeds on the broken tarmac.
    r.dec(17, 9, DEC.STAIN_A, 0.3, 1.1);
    r.dec(12, 20, DEC.STAIN_B, 1.2, 0.9);
    r.dec(3, 13, DEC.POT, 0, 0.8);
    r.dec(2, 7, DEC.PLANT, 0, 0.8);
    r.scatter(15, 9, 24, 14, [DEC.RUBBLE_A, DEC.RUBBLE_B, DEC.CONCRETE_CHUNK], 14, 101);
    r.scatter(1, 1, 6, 28, [DEC.PAPER, DEC.RUBBLE_C], 14, 202, 0.4, 0.7);
    r.scatter(9, 2, 14, 8, [DEC.PLANK, DEC.BOARD], 9, 404);
    r.scatter(9, 21, 15, 26, [DEC.PLANK, DEC.RUBBLE_A, DEC.BOARD], 12, 505);
    // Weeds only on the tarmac: BUSH is a full-cell shrub and reads as something
    // you should not be able to walk through, which decor always is.
    r.scatter(8, 1, 10, 20, [DEC.WEED], 8, 606, 0.5, 0.8);
    r.scatter(24, 12, 31, 20, [DEC.WEED], 6, 707, 0.45, 0.75);
    r.scatter(8, 19, 10, 20, [DEC.BUSH], 3, 717, 0.5, 0.8);

    r.spawns([[3, 4], [3, 9], [3, 14], [3, 15], [3, 20], [3, 25]]);
  });

  // Survival fallbacks (unused in TDM, but the grid contract has four lists).
  g.survivorSpawns.push({ x: px(19), y: px(10) });
  g.zombieSpawns.push({ x: px(2), y: px(2) });
  return g;
}

// ---- Map: "Outbreak" (zombie survival), 44 x 34 ----
//
// One quarantined apartment block and the street around it. The squad holds the
// ground-floor lobby; the flats either side of the spine corridor are furnished
// as flats, which is what makes a room tellable from the room next to it while
// you are being chased through it. Outside: a cross-street, a back alley behind a
// hoarding, a boarded shop and a lock-up garage.
//
// No symmetry here, unlike Compound — this mode is five survivors against the
// map, so there is no fairness to preserve and furniture can face whichever way
// the room wants.
function buildOutbreak(): Grid {
  const g = new Grid(44, 34);
  border(g);

  // ---- the block: outer shell, spine corridor (y 16-17), three rooms each side.
  hollowRect(g, 13, 9, 30, 24);
  for (let x = 14; x <= 29; x++) { g.set(x, 15, T_WALL); g.set(x, 18, T_WALL); }
  for (const x of [18, 25]) {
    for (let y = 10; y <= 14; y++) g.set(x, y, T_WALL);
    for (let y = 19; y <= 23; y++) g.set(x, y, T_WALL);
  }
  // Doors off the corridor, one per room.
  door(g, 16, 15); door(g, 21, 15); door(g, 27, 15);
  door(g, 16, 18); door(g, 21, 18); door(g, 28, 18);
  // ...and between the lobby and the flats either side of it, so the squad's room
  // has four ways in like the compound it replaces — a single-door room is a camp.
  door(g, 18, 21); door(g, 25, 21);
  door(g, 18, 12);
  // Ways into the building: the main entrance south into the lobby, a fire exit
  // north into the alley, and one end of the corridor at each side.
  door(g, 21, 24); door(g, 22, 24);
  door(g, 16, 9);
  door(g, 13, 17); door(g, 30, 16);

  // ---- the back alley: a hoarding two tiles off the north wall, open at both
  // ends, with bins in it.
  for (let x = 14; x <= 29; x++) g.set(x, 6, T_WALL);
  door(g, 21, 6);
  for (const [x, y] of [[15, 7], [15, 8], [24, 8], [28, 7]] as const) crate(g, x, y);

  // ---- outbuildings: a boarded shop on the south-west corner and a lock-up on
  // the north-east one. Both are loot detours off the ring road.
  hollowRect(g, 3, 26, 9, 31); door(g, 6, 26); door(g, 3, 29);
  hollowRect(g, 34, 2, 40, 7); door(g, 37, 7); door(g, 34, 4);

  // ---- furniture, room by room.
  // North-west flat: a living room.
  propRun(g, 14, 10, 'h', [MAT.SOFA_L, MAT.SOFA_M, MAT.SOFA_R]);
  crate(g, 17, 13, MAT.ARMCHAIR);
  crate(g, 15, 13, MAT.TABLE_ROUND);
  // North-middle: the service core. Bare concrete and the stair block.
  crate(g, 21, 11, MAT.WORKBENCH); crate(g, 22, 11, MAT.WORKBENCH);
  crate(g, 21, 12, MAT.WORKBENCH); crate(g, 22, 12, MAT.WORKBENCH);
  crate(g, 19, 14); crate(g, 24, 10);
  // North-east flat: the kitchen, worktop along the outside wall.
  propRun(g, 26, 10, 'h', [MAT.COUNTER, MAT.SINK, MAT.COUNTER, MAT.STOVE]);
  crate(g, 26, 13, MAT.OVEN);
  crate(g, 28, 13, MAT.TABLE);
  // South-west flat: a bedroom. Beds head to the wall, which is why the run goes
  // foot-first and ends on the last row before it.
  propRun(g, 14, 22, 'v', [MAT.BED_FOOT, MAT.BED_HEAD]);
  propRun(g, 16, 22, 'v', [MAT.BED_RED_FOOT, MAT.BED_RED_HEAD]);
  crate(g, 17, 19, MAT.DESK);
  // The lobby the squad holds: a reception desk and a couch, spawns left clear.
  crate(g, 19, 19, MAT.DESK); crate(g, 20, 19, MAT.DESK);
  crate(g, 24, 23, MAT.TABLE_ROUND);
  // South-east flat: a second living room.
  propRun(g, 26, 19, 'h', [MAT.SOFA_RED_L, MAT.SOFA_RED_M, MAT.SOFA_RED_R]);
  crate(g, 29, 22, MAT.ARMCHAIR);
  // The shop counter, and the lock-up's bench.
  propRun(g, 4, 27, 'h', [MAT.COUNTER, MAT.SINK, MAT.COUNTER]);
  crate(g, 8, 30, MAT.TABLE);
  propRun(g, 35, 3, 'h', [MAT.WORKBENCH, MAT.WORKBENCH, MAT.WORKBENCH]);
  crate(g, 39, 6);

  // ---- street cover: cars are not in this pack, so the ring road is broken up
  // with stacked stock and bins instead.
  for (const [x, y] of [[10, 12], [10, 21], [33, 12], [33, 21], [21, 30], [22, 28],
    [8, 4], [35, 30], [11, 16], [32, 17]] as const) crate(g, x, y);
  crate(g, 10, 16, MAT.CRATE_BLUE); crate(g, 33, 16, MAT.CRATE_BLUE);
  crate(g, 21, 2, MAT.CRATE_GREEN); crate(g, 22, 31, MAT.CRATE_GREEN);
  crate(g, 2, 8, MAT.WORKBENCH); crate(g, 41, 25, MAT.WORKBENCH);

  // ---- overheads. Authored now, drawn in phase 3.
  //
  // A slab has to be at least two tiles each way (no piece of the 9-slice carries
  // both a north and a south edge), which is why the shop's awning includes the
  // wall row it is bolted to — that row is not floor, so it costs nothing against
  // the budget either. Which run goes where is a contrast decision: the pale
  // conduit reads against the alley's brown hoarding and dark concrete, the
  // orange pipe reads against open asphalt, and swapped over both vanish.
  paintOver(g, 20, 25, 23, 26, OVER.AWNING);   // canopy over the main entrance
  paintOver(g, 4, 25, 8, 26, OVER.AWNING);     // the shop's frontage
  paintOver(g, 14, 8, 20, 8, OVER.CONDUIT);    // conduit down the alley
  paintOver(g, 1, 17, 6, 17, OVER.PIPE);       // pipe across the west street

  // ---- materials: a quarantined city block ----
  // Geometry above is untouched; everything below only says what it is made of.
  //
  // Order is the whole game here: broad first, specific second, every pass
  // filtered to one tile KIND, and the paint sequence running from the street
  // inwards. Two mistakes this shape prevents, both of which happened: painting
  // the roads after the buildings ran lane markings straight through the shop and
  // the lock-up, and an unfiltered opening pass relabelled every piece of
  // furniture above as tarmac.
  paintFloor(g, 0, 0, 43, 33, MAT.ASPHALT);                  // the street
  // The broad wall pass runs FIRST so the per-building cladding below survives
  // it; the other way round, the perimeter silently re-concretes every building.
  paintWall(g, 0, 0, 43, 33, MAT.WALL_CONCRETE);
  // Streets: one crosstown either side of the block, one down each flank. Each
  // run stops where a building or a lot takes over rather than being overpainted
  // by it — a lane marking that dead-ends into a wall looks like an error.
  paintFloor(g, 6, 3, 33, 3, MAT.ROAD_LINE_H);
  paintFloor(g, 10, 30, 37, 30, MAT.ROAD_LINE_H);
  paintFloor(g, 6, 3, 6, 25, MAT.ROAD_LINE_V);
  paintFloor(g, 37, 8, 37, 30, MAT.ROAD_LINE_V);
  // The lot on the north-west corner and the gravel car park on the south-east.
  paintFloor(g, 1, 1, 5, 5, MAT.GRASS);
  paintFloor(g, 1, 12, 4, 21, MAT.GRASS);
  paintFloor(g, 33, 26, 42, 32, MAT.GRAVEL);
  paintFloor(g, 38, 10, 42, 21, MAT.GRAVEL);
  // The alley hoarding, and the alley floor: service concrete, never resurfaced.
  paintWall(g, 14, 6, 29, 6, MAT.WALL_PLANK);
  paintFloor(g, 13, 7, 30, 8, MAT.CONCRETE);
  // The block: brick outside, plaster partitions inside, and a floor per room.
  // Footprints, not interiors, so doorway tiles belong to the room they open into.
  paintFloor(g, 13, 9, 30, 24, MAT.WOOD | MAT_INDOOR);
  paintWall(g, 13, 9, 30, 24, MAT.WALL_PLASTER);
  paintWall(g, 13, 9, 30, 9, MAT.WALL_BRICK);
  paintWall(g, 13, 24, 30, 24, MAT.WALL_BRICK);
  paintWall(g, 13, 9, 13, 24, MAT.WALL_BRICK);
  paintWall(g, 30, 9, 30, 24, MAT.WALL_BRICK);
  // Every room's floor is chosen against what stands on it: the kitchen's white
  // worktops would vanish on the pack's white tile, so the tile goes in the
  // service core (where the stair block is timber) and the kitchen gets concrete.
  paintFloor(g, 14, 10, 17, 14, MAT.CARPET_RED | MAT_INDOOR);      // living room
  paintFloor(g, 19, 10, 24, 14, MAT.FLOORTILE | MAT_INDOOR);       // service core
  paintFloor(g, 26, 10, 29, 14, MAT.CONCRETE | MAT_INDOOR);        // kitchen
  paintFloor(g, 14, 16, 29, 17, MAT.TILE_RED | MAT_INDOOR);        // spine corridor
  paintFloor(g, 19, 19, 24, 23, MAT.TILE_RED | MAT_INDOOR);        // lobby
  paintFloor(g, 26, 19, 29, 23, MAT.CARPET_GREEN | MAT_INDOOR);    // living room 2
  paintFloor(g, 21, 24, 22, 24, MAT.TILE_RED | MAT_INDOOR);        // and its threshold
  // The outbuildings. Terracotta in the shop, for the same reason: its counter is
  // the same white worktop the kitchen has.
  paintFloor(g, 3, 26, 9, 31, MAT.TILE_RED | MAT_INDOOR);
  paintWall(g, 3, 26, 9, 31, MAT.WALL_PLANK);
  paintFloor(g, 34, 2, 40, 7, MAT.CONCRETE | MAT_INDOOR);
  paintWall(g, 34, 2, 40, 7, MAT.WALL_BRICK);

  // Note there is no blanket crate pass any more: `crate`/`propRun` set the
  // material as they place the prop, and a sweep over T_CRATE now would relabel
  // every sofa, bed and worktop above as a wooden box.

  // Dressing. Collapse spoil through the block, glass at its doorways, crockery
  // in the kitchen and the shop, oil down the streets, weeds on the lots.
  scatter(g, 14, 10, 29, 23, [DEC.RUBBLE_A, DEC.CONCRETE_CHUNK, DEC.PAPER], 22, 401);
  scatter(g, 13, 7, 30, 8, [DEC.GLASS, DEC.RUBBLE_B, DEC.PAPER], 14, 402);
  scatter(g, 12, 25, 31, 27, [DEC.GLASS, DEC.RUBBLE_B], 10, 403);
  dec(g, 27, 12, DEC.PLATE, 0.4, 0.7); dec(g, 28, 11, DEC.CUPS, 1.1, 0.7);
  dec(g, 5, 29, DEC.PLATE, 2.2, 0.7); dec(g, 7, 28, DEC.CUPS, 0.2, 0.7);
  dec(g, 15, 12, DEC.POT, 0, 0.8); dec(g, 27, 21, DEC.PLANT, 0, 0.8);
  dec(g, 20, 21, DEC.PLANT, 0, 0.8);
  scatter(g, 2, 3, 41, 3, [DEC.STAIN_A, DEC.STAIN_B], 9, 811, 0.7, 1.1);
  scatter(g, 2, 30, 41, 30, [DEC.STAIN_A, DEC.STAIN_B], 9, 822, 0.7, 1.1);
  scatter(g, 1, 1, 5, 5, [DEC.WEED, DEC.BUSH], 12, 901, 0.5, 0.9);
  scatter(g, 1, 12, 4, 21, [DEC.WEED, DEC.BUSH], 12, 902, 0.5, 0.9);
  scatter(g, 33, 26, 42, 32, [DEC.WEED, DEC.RUBBLE_C, DEC.PLANK], 16, 903, 0.5, 0.9);
  scatter(g, 38, 10, 42, 21, [DEC.WEED, DEC.RUBBLE_C], 12, 904, 0.5, 0.9);
  scatter(g, 34, 2, 40, 7, [DEC.PLANK, DEC.BOARD, DEC.RUBBLE_A], 10, 905);
  scatter(g, 3, 26, 9, 31, [DEC.PAPER, DEC.GLASS, DEC.RUBBLE_C], 10, 906, 0.4, 0.8);

  // Survivor spawns: the lobby floor, clear of its furniture.
  for (const [x, y] of [[20, 21], [23, 21], [20, 22], [23, 22], [22, 20]]) {
    g.survivorSpawns.push({ x: px(x), y: px(y) });
  }
  // Zombie spawns around the edges of the block, so a wave arrives from every
  // approach rather than one side.
  for (const [x, y] of [[2, 2], [41, 2], [2, 32], [41, 32], [21, 1], [22, 32], [1, 17], [42, 17]]) {
    g.zombieSpawns.push({ x: px(x), y: px(y) });
  }
  // TDM fallbacks (unused)
  g.redSpawns.push({ x: px(2), y: px(17) });
  g.blueSpawns.push({ x: px(41), y: px(17) });
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
