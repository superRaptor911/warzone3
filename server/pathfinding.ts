import { TILE } from '../shared/constants.ts';
import { T_FLOOR, type Grid } from '../shared/maps.ts';
import type { Vec2 } from '../shared/types.ts';

interface HeapNode { x: number; y: number; f: number }

// Binary min-heap keyed by f-score.
class Heap {
  a: HeapNode[] = [];
  push(n: HeapNode): void {
    const a = this.a; a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): HeapNode {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size(): number { return this.a.length; }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function nearestOpen(grid: Grid, tx: number, ty: number): [number, number] | null {
  if (grid.get(tx, ty) === T_FLOOR) return [tx, ty];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid.get(tx + dx, ty + dy) === T_FLOOR) return [tx + dx, ty + dy];
      }
    }
  }
  return null;
}

// LOS check with clearance for a moving circle: casts the center ray plus two
// rays offset perpendicular by ~radius.
export function clearLos(grid: Grid, x0: number, y0: number, x1: number, y1: number, radius: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const nx = -dy / d, ny = dx / d, off = radius * 0.85;
  return grid.los(x0, y0, x1, y1) &&
    grid.los(x0 + nx * off, y0 + ny * off, x1 + nx * off, y1 + ny * off) &&
    grid.los(x0 - nx * off, y0 - ny * off, x1 - nx * off, y1 - ny * off);
}

// A* from world (x0,y0) to (x1,y1). Returns array of world waypoints
// (excluding start, including goal), smoothed, or null if unreachable.
export function findPath(grid: Grid, x0: number, y0: number, x1: number, y1: number, radius = 14): Vec2[] | null {
  const s = nearestOpen(grid, Math.floor(x0 / TILE), Math.floor(y0 / TILE));
  const g = nearestOpen(grid, Math.floor(x1 / TILE), Math.floor(y1 / TILE));
  if (!s || !g) return null;
  const [sx, sy] = s, [gx, gy] = g;
  if (sx === gx && sy === gy) return [{ x: x1, y: y1 }];

  const W = grid.w;
  const gScore = new Float64Array(grid.w * grid.h).fill(Infinity);
  const cameFrom = new Int32Array(grid.w * grid.h).fill(-1);
  const closed = new Uint8Array(grid.w * grid.h);
  const h = (x: number, y: number) => Math.hypot(x - gx, y - gy);
  const heap = new Heap();
  gScore[sy * W + sx] = 0;
  heap.push({ x: sx, y: sy, f: h(sx, sy) });

  let found = false;
  while (heap.size) {
    const n = heap.pop();
    const ni = n.y * W + n.x;
    if (closed[ni]) continue;
    closed[ni] = 1;
    if (n.x === gx && n.y === gy) { found = true; break; }
    for (const [dx, dy, cost] of DIRS) {
      const nx = n.x + dx, ny = n.y + dy;
      if (grid.get(nx, ny) !== T_FLOOR) continue;
      // no corner cutting on diagonals
      if (dx !== 0 && dy !== 0 &&
        (grid.get(n.x + dx, n.y) !== T_FLOOR || grid.get(n.x, n.y + dy) !== T_FLOOR)) continue;
      const ii = ny * W + nx;
      if (closed[ii]) continue;
      const tentative = gScore[ni] + cost;
      if (tentative < gScore[ii]) {
        gScore[ii] = tentative;
        cameFrom[ii] = ni;
        heap.push({ x: nx, y: ny, f: tentative + h(nx, ny) });
      }
    }
  }
  if (!found) return null;

  // reconstruct tile path
  const tiles: Vec2[] = [];
  let cur = gy * W + gx;
  while (cur !== -1 && cur !== sy * W + sx) {
    tiles.push({ x: (cur % W) * TILE + TILE / 2, y: Math.floor(cur / W) * TILE + TILE / 2 });
    cur = cameFrom[cur];
  }
  tiles.reverse();
  tiles.push({ x: x1, y: y1 });

  // smooth: greedily skip waypoints reachable with clearance
  const out: Vec2[] = [];
  let anchor = { x: x0, y: y0 };
  let i = 0;
  while (i < tiles.length) {
    let j = i;
    while (j + 1 < tiles.length && clearLos(grid, anchor.x, anchor.y, tiles[j + 1].x, tiles[j + 1].y, radius)) j++;
    out.push(tiles[j]);
    anchor = tiles[j];
    i = j + 1;
  }
  return out;
}
