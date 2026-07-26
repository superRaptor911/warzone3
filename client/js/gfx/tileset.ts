// World art: which cell of the third-party tilesheet each material is drawn
// from, and how the composites are assembled.
//
// Pure Canvas2D draw functions with no Pixi import, exactly like art.ts — the
// bake in gfx/textures.ts is one consumer and the map preview page is another,
// so there is one definition per shape and the two cannot drift.
//
// The sheet is Kenney's Topdown Shooter tilesheet, shipped unmodified; see
// client/assets/LICENSE-ART.md for provenance and the cell-index formula. Every
// cell reference below was picked by measuring the sheet, not by eye: the
// comment on each entry says what the measurement was.
//
// ---------------------------------------------------------------------------
// Why walls are composited rather than used as shipped
//
// The pack's wall tiles are already an autotile set, but with the OPPOSITE
// convention to this grid: one of their cells is a room's floor with 12px wall
// bands along whichever edges are walled, i.e. walls live on tile BORDERS. Here
// `solid()` makes an entire 48px tile impassable, so dropping their tiles in
// would draw a thin line and collide with the whole cell — players bouncing off
// what looks like open floor.
//
// So the geometry is ours and the pixels are theirs: a wall cell is filled edge
// to edge with a material texture from the sheet, and the pack's own edge
// language (a 2px dark keyline, a lighter top face) is redrawn on the faces that
// actually front onto floor, selected by a neighbour mask. The visual edge is
// the collision edge by construction, which is the property the whole scheme
// exists to guarantee.
import { TILE } from '../../../shared/constants.ts';
import { DEC, MAT } from '../../../shared/maps.ts';

type Ctx = CanvasRenderingContext2D;
/** A cell on the sheet, [col, row]. */
export type Cell = [number, number];

export const SHEET_URL = '/assets/tilesheet.png';
export const SHEET_COLS = 27;
export const SHEET_ROWS = 20;
export const SHEET_CELL = 128;      // the 2X sheet; see LICENSE-ART.md

/**
 * Cells are baked at TILE_SS x the world tile size. `sharp` is the default
 * quality tier on every device and `resolutionFor` gives it a backing store of
 * up to 2x DPR, so baking at 1x would upscale the art on exactly the screens
 * where the new detail is meant to show. 2 is also the most the source
 * supports: 128px in, 96px out is a downscale, and going higher would just
 * resample 128px art into a bigger box.
 */
export const TILE_SS = 2;
export const CELL = TILE * TILE_SS;  // 96

// Edge treatment widths, in baked (CELL-scale) px. Derived from the sheet, not
// invented: measured against a wall cell, the pack uses a 2px keyline and an
// 8px lit face per 64px cell, which is 3px and 12px at CELL=96.
const KEYLINE = 3;
const CAP = 12;
/** Ambient-occlusion band cast onto a floor tile by an adjacent solid one. */
const SHADE = 11;

// Neighbour mask bits. Set = that neighbour is SOLID, so no edge is drawn
// there; a wall only wears a face where it actually fronts onto floor.
export const N = 1, E = 2, S = 4, W = 8;
export const MASKS = 16;

// ---- floors ---------------------------------------------------------------
// Multiple cells per material are genuine variants of the same surface, chosen
// per tile by position hash. The old renderer varied the floor by +-6 of
// brightness; these are different art.
export const FLOOR_ART: Record<number, Cell[]> = {
  // The ONLY two flat (74,74,74) cells on the sheet. The neighbouring cells that
  // look like faint specks are road dot markings, not texture — used as variants
  // they tile into visible polka dots across every street.
  [MAT.ASPHALT]: [[4, 3], [11, 3]],
  // yellow lane marking down the tile centre: vertical / horizontal
  [MAT.ROAD_LINE_V]: [[0, 2]],
  [MAT.ROAD_LINE_H]: [[1, 2]],
  [MAT.GRAVEL]: [[4, 0], [5, 0]],                     // (187,128,68) earth + grit
  [MAT.GRASS]: [[0, 0], [1, 0], [2, 0], [3, 0]],      // (39,174,96) + speckle
  // paving with real slab joints, not the flat (156,192,194) fills beside them
  [MAT.CONCRETE]: [[8, 0], [9, 0], [10, 0], [0, 12], [2, 12]],
  [MAT.WOOD]: [[14, 3], [15, 3], [16, 3]],            // (212,157,104) boards
  [MAT.FLOORTILE]: [[11, 0]],                         // (245,245,245) checker
};

/**
 * Per-material bake adjustments, for the places where the sheet does not have
 * what a top-down shooter floor needs.
 *
 * `grain` exists because the pack has NO textured asphalt: its dark grey is a
 * flat interior-floor colour, and the only alternatives on the sheet carry road
 * markings. A large expanse of one flat value is exactly the mush this whole
 * change is meant to remove, so the grain is generated here — in the pack's own
 * palette, deterministically per variant, so it reads as surface rather than as
 * noise and never differs between clients.
 *
 * `variants` decouples the number of baked cells from the number of source
 * cells: two flat asphalt cells plus six grain seeds give six distinct tiles.
 *
 * `wash` knocks back a source that is too saturated to sit under the rest of the
 * palette — the pack's earth is a vivid orange-brown that competes with the
 * brick if it covers any real area.
 */
export interface FloorFx { variants?: number; grain?: number; wash?: string }
export const FLOOR_FX: Record<number, FloorFx> = {
  [MAT.ASPHALT]: { variants: 6, grain: 0.55 },
  [MAT.GRAVEL]: { variants: 4, grain: 0.40, wash: 'rgba(52,44,36,0.26)' },
  [MAT.CONCRETE]: { variants: 5, grain: 0.16 },
};

/** How many baked variants a floor material has. */
export function floorVariants(id: number): number {
  return FLOOR_FX[id]?.variants ?? FLOOR_ART[id]?.length ?? 1;
}

// ---- walls ----------------------------------------------------------------
export interface WallArt {
  /** Full-cell material texture, tiled edge to edge across the whole cell. */
  body: Cell;
  /** Dark keyline on every face fronting onto floor. From the pack's own art. */
  keyline: string;
  /** Lighter top face. The pack lights from the north; so do we. */
  cap: string;
}
export const WALL_ART: Record<number, WallArt> = {
  // running-bond brick, orange: body (216,127,74)/(221,130,76), mortar (198,116,68)
  [MAT.WALL_BRICK]: { body: [14, 2], keyline: '#a64a0f', cap: '#dd824c' },
  // boards, tan: body (196,134,71)/(201,137,72), gap (180,123,65)
  [MAT.WALL_WOOD]: { body: [14, 1], keyline: '#956536', cap: '#c98948' },
  // poured concrete: (156,192,194) with (166,201,203) highlights
  [MAT.WALL_CONCRETE]: { body: [0, 12], keyline: '#648587', cap: '#a6c9cb' },
};

// ---- solid props (tiles[] === T_CRATE) ------------------------------------
// Drawn on a TRANSPARENT background over the floor sprite, because none of them
// fills the cell — a crate sits on the ground it happens to be standing on
// (see Grid.floorMatUnder). Collision is identical for all of them.
export const PROP_ART: Record<number, Cell> = {
  [MAT.CRATE]: [20, 4],         // wooden crate, 54x54 of a 64 cell
  [MAT.CRATE_BLUE]: [22, 4],    // blue shipping box
  [MAT.CRATE_GREEN]: [22, 5],   // green shipping box
};

// ---- decor (free-position, never collides, never occludes) ----------------
export const DECOR_ART: Record<number, Cell> = {
  [DEC.RUBBLE_A]: [20, 8],
  [DEC.RUBBLE_B]: [21, 8],
  [DEC.RUBBLE_C]: [22, 8],
  [DEC.CONCRETE_CHUNK]: [18, 9],
  [DEC.GLASS]: [20, 9],
  [DEC.PLANK]: [21, 9],
  [DEC.BOARD]: [23, 9],
  [DEC.BRICK_DEBRIS]: [18, 10],
  [DEC.STAIN_A]: [21, 11],
  [DEC.STAIN_B]: [22, 11],
  [DEC.PAPER]: [24, 7],
  [DEC.WEED]: [18, 8],
};

// ---- registry keys --------------------------------------------------------
export const floorKey = (m: number, v: number): string => `floor-${m}-${v}`;
export const wallKey = (m: number, mask: number): string => `wall-${m}-${mask}`;
export const shadeKey = (mask: number): string => `shade-${mask}`;
export const propKey = (m: number): string => `prop-${m}`;
export const decorKey = (f: number): string => `decor-${f}`;

export const isFloorMat = (id: number): boolean => id in FLOOR_ART;
export const isWallMat = (id: number): boolean => id in WALL_ART;
export const isPropMat = (id: number): boolean => id in PROP_ART;

/**
 * Picks a floor variant for a tile. Deterministic in position, so two clients
 * looking at the same tile see the same art and a reconnect does not reshuffle
 * the ground. Same hash the old floor-brightness jitter used.
 */
export function floorVariant(id: number, tx: number, ty: number): number {
  const n = floorVariants(id);
  if (n <= 1) return 0;
  let h = (tx * 374761393 + ty * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) % n;
}

// ---- draw functions -------------------------------------------------------
// Every one of these fills the box (0,0)-(CELL,CELL) and assumes the caller has
// already translated. `img` is the loaded sheet.

type Img = CanvasImageSource;

function blit(g: Ctx, img: Img, c: Cell): void {
  g.drawImage(
    img, c[0] * SHEET_CELL, c[1] * SHEET_CELL, SHEET_CELL, SHEET_CELL,
    0, 0, CELL, CELL,
  );
}

export function drawFloor(g: Ctx, img: Img, id: number, variant: number): void {
  const cells = FLOOR_ART[id];
  if (!cells) return;
  blit(g, img, cells[variant % cells.length]);
  const fx = FLOOR_FX[id];
  if (!fx) return;
  if (fx.wash) {
    g.fillStyle = fx.wash;
    g.fillRect(0, 0, CELL, CELL);
  }
  if (fx.grain) drawGrain(g, id * 977 + variant * 31, fx.grain);
}

/**
 * Deterministic surface grain: scattered dark and light blobs at low alpha.
 * Seeded by material and variant rather than by tile, because it is baked into
 * the variant — which is what keeps the atlas small while still giving the
 * ground more than one face.
 */
function drawGrain(g: Ctx, seed: number, strength: number): void {
  let s = (seed * 2654435761) | 0;
  const r = (): number => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0x1000000;
  };
  const blobs = 26;
  for (let i = 0; i < blobs; i++) {
    const x = r() * CELL, y = r() * CELL;
    const rad = 1.5 + r() * 5.5;
    const dark = r() < 0.62;
    g.fillStyle = dark
      ? `rgba(0,0,0,${(0.05 + r() * 0.09) * strength})`
      : `rgba(255,255,255,${(0.03 + r() * 0.055) * strength})`;
    g.beginPath();
    g.ellipse(x, y, rad, rad * (0.55 + r() * 0.7), r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * A full-cell wall. Body first, then the lit top face and the keyline on every
 * side that fronts onto floor. Nothing is inset from the cell bounds: the paint
 * reaches the collision edge, which is what makes the silhouette honest.
 */
export function drawWall(g: Ctx, img: Img, id: number, mask: number): void {
  const a = WALL_ART[id];
  if (!a) return;
  blit(g, img, a.body);
  // Lit north face, drawn before the keyline so the keyline caps it.
  if (!(mask & N)) {
    g.fillStyle = a.cap;
    g.fillRect(0, 0, CELL, CAP);
  }
  g.fillStyle = a.keyline;
  if (!(mask & N)) g.fillRect(0, 0, CELL, KEYLINE);
  if (!(mask & S)) g.fillRect(0, CELL - KEYLINE, CELL, KEYLINE);
  if (!(mask & W)) g.fillRect(0, 0, KEYLINE, CELL);
  if (!(mask & E)) g.fillRect(CELL - KEYLINE, 0, KEYLINE, CELL);
}

/**
 * Ambient occlusion on a FLOOR tile, from whichever sides have a solid
 * neighbour. This is the half of the wall's drop shadow that lands on the
 * ground: it cannot live in the wall texture, because a texture is clipped to
 * its own cell and the shadow falls outside it.
 *
 * Drawn as gradients rather than flat bands so a corner reads as a corner
 * without needing 47 hand-authored variants — two overlapping falloffs already
 * darken their shared corner twice.
 */
export function drawShade(g: Ctx, mask: number): void {
  // Dark at the wall face, transparent SHADE px in. A gradient's colour past
  // its end stop is the end stop, so filling the whole cell each time is both
  // correct and simpler than clipping to a band.
  const band = (x0: number, y0: number, x1: number, y1: number): void => {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(0,0,0,0.42)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, CELL, CELL);
  };
  if (mask & N) band(0, 0, 0, SHADE);
  if (mask & S) band(0, CELL, 0, CELL - SHADE);
  if (mask & W) band(0, 0, SHADE, 0);
  if (mask & E) band(CELL, 0, CELL - SHADE, 0);
}

export function drawProp(g: Ctx, img: Img, id: number): void {
  const c = PROP_ART[id];
  if (!c) return;
  blit(g, img, c);
}

export function drawDecor(g: Ctx, img: Img, f: number): void {
  const c = DECOR_ART[f];
  if (!c) return;
  blit(g, img, c);
}

/** Solid-neighbour mask for a tile, in the N/E/S/W bit order above. */
export function neighbourMask(
  solid: (tx: number, ty: number) => boolean, tx: number, ty: number,
): number {
  return (solid(tx, ty - 1) ? N : 0) | (solid(tx + 1, ty) ? E : 0)
    | (solid(tx, ty + 1) ? S : 0) | (solid(tx - 1, ty) ? W : 0);
}
