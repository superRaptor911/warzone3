import { TILE } from './constants.ts';
import type { SerializedGrid, Vec2 } from './types.ts';

// Tile values
export const T_FLOOR = 0;
export const T_WALL = 1;
export const T_CRATE = 2;

export class Grid {
  w: number;
  h: number;
  tiles: Uint8Array;
  redSpawns: Vec2[];
  blueSpawns: Vec2[];
  survivorSpawns: Vec2[];
  zombieSpawns: Vec2[];

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.tiles = new Uint8Array(w * h);
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
      w: this.w, h: this.h, tiles: Array.from(this.tiles),
      redSpawns: this.redSpawns, blueSpawns: this.blueSpawns,
      survivorSpawns: this.survivorSpawns, zombieSpawns: this.zombieSpawns,
    };
  }
  static deserialize(o: SerializedGrid): Grid {
    const g = new Grid(o.w, o.h);
    g.tiles.set(o.tiles);
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
function crate(g: Grid, x: number, y: number): void { g.set(x, y, T_CRATE); }
const px = (t: number) => t * TILE + TILE / 2; // tile -> world center

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
