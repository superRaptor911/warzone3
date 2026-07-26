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
import { DEC, MAT, OVER } from '../../../shared/maps.ts';

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
  // (216,127,74) slabs — the same orange as the brick, which is why this one
  // cannot be used unwashed: a lobby floor the colour of the wall behind it
  // reads as one continuous surface.
  [MAT.TILE_RED]: [[12, 0], [13, 0]],
  // The one fully-interior cell of each of the pack's two rugs. Measured, because
  // it matters: of the rug's four rows only row 14 is pure fill — rows 13 and 15
  // carry a slice of the rug's own pale border, which tiled across a room draws a
  // stripe every tile. The border cells themselves are a proper autotile set and
  // are deliberately unused: a fitted carpet meets boards on a hard line, and
  // that is the one place in this pipeline where a hard material seam is the
  // correct drawing rather than a missing transition (see tasks/WORLD-ART.md).
  [MAT.CARPET_RED]: [[19, 14]],
  [MAT.CARPET_GREEN]: [[22, 14]],
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
  // The wash is not cosmetic: WALL_CONCRETE's body cell is one of this material's
  // own floor variants, so unwashed, a concrete room and the concrete wall around
  // it are the same colour and the room reads as one flat field with a keyline
  // drawn on it. Floors sit in shadow and walls catch the light, so the floor
  // going darker is also the right way round.
  [MAT.CONCRETE]: { variants: 5, grain: 0.16, wash: 'rgba(26,36,42,0.30)' },
  // The pack's outdoor green is a kelly green that reads as astroturf over any
  // real area, so the lots get the same knock-back treatment the earth already
  // had.
  [MAT.GRASS]: { variants: 4, wash: 'rgba(34,48,26,0.32)' },
  // The pack's interior colours are shop-window bright — its rugs are a signal
  // orange (232,106,23) and a green that is the EXACT grass colour (39,174,96),
  // so an unwashed carpet reads as a lawn indoors. The washes take them to the
  // worn tones a lit-from-one-lamp room wants, and darken the terracotta enough
  // to separate it from the brickwork. Both carpets are ONE flat colour at
  // source, which is the same problem asphalt has, so they lean on grain and
  // variants for their surface exactly as it does.
  [MAT.TILE_RED]: { variants: 3, grain: 0.14, wash: 'rgba(38,22,26,0.32)' },
  [MAT.CARPET_RED]: { variants: 4, grain: 0.42, wash: 'rgba(48,18,10,0.42)' },
  [MAT.CARPET_GREEN]: { variants: 4, grain: 0.42, wash: 'rgba(12,32,22,0.50)' },
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
  // The pale third of the pack's three masonry tones — (212,157,104) with
  // (187,138,91) joints. Interior partitions: what one flat is divided from the
  // next by, so it must not read as an outside wall.
  [MAT.WALL_PLASTER]: { body: [14, 3], keyline: '#8a6444', cap: '#e2ab77' },
  // Nailed boards, the same palette as WALL_WOOD by measurement (196,134,71 /
  // 180,123,65) but with the pack's actual plank-and-nail face rather than its
  // bond pattern — hoardings and boarded shopfronts.
  [MAT.WALL_PLANK]: { body: [18, 1], keyline: '#956536', cap: '#c98948' },
};

// ---- solid props (tiles[] === T_CRATE) ------------------------------------
// Drawn on a TRANSPARENT background over the floor sprite, because none of them
// fills the cell — a crate sits on the ground it happens to be standing on
// (see Grid.floorMatUnder). Collision is identical for all of them.
//
// Cells here were chosen on *extent* as much as on subject, because a prop's tile
// is solid edge to edge: every one below spans at least 0.79 of the cell in both
// directions (measured in test/touchdrive.ts — worst is SOFA_M at 0.797, and the
// plain crate is only 0.844), which is what keeps "the visual edge is the
// collision edge" as true for furniture as it already was for boxes. The pack's
// thinner pieces — bare chairs, stools, low benches — are all under half a cell
// and are therefore not here at all: a chair you bounce off two feet away is
// worse than no chair.
//
// Nothing is rotated. The pieces with a facing (sofas, beds, worktops) are all
// drawn with their back to the north and are authored against a north wall;
// giving the table a rotation field would let a future author put a sofa's back
// against open floor without noticing, and no room here needs it.
export const PROP_ART: Record<number, Cell> = {
  [MAT.CRATE]: [20, 4],         // wooden crate, 54x54 of a 64 cell
  [MAT.CRATE_BLUE]: [22, 4],    // blue shipping box
  [MAT.CRATE_GREEN]: [22, 5],   // green shipping box
  // Timber frame with a pale top, full cell. Note what it is NOT: the middle cell
  // of the pack's big table, which is one flat brown with no detail at all —
  // baked as a prop that draws as a hole in the room rather than a bench.
  [MAT.WORKBENCH]: [24, 19],
  [MAT.DESK]: [23, 17],         // desk with a grey worktop
  [MAT.TABLE]: [23, 16],        // plain table
  [MAT.TABLE_ROUND]: [19, 18],  // round table — the one prop with no facing
  [MAT.COUNTER]: [24, 11],      // white worktop, back edge to the north
  [MAT.SINK]: [25, 11],
  [MAT.STOVE]: [26, 11],        // four-burner hob
  [MAT.OVEN]: [25, 10],
  // Sofas and beds are runs: the pieces only read left-to-right / foot-to-head,
  // which is what `propRun` in shared/maps.ts exists to keep true.
  [MAT.SOFA_L]: [14, 16], [MAT.SOFA_M]: [15, 16], [MAT.SOFA_R]: [16, 16],
  [MAT.SOFA_RED_L]: [14, 17], [MAT.SOFA_RED_M]: [15, 17], [MAT.SOFA_RED_R]: [16, 17],
  [MAT.ARMCHAIR]: [17, 17],
  [MAT.BED_FOOT]: [20, 2], [MAT.BED_HEAD]: [20, 3],
  [MAT.BED_RED_FOOT]: [23, 2], [MAT.BED_RED_HEAD]: [23, 3],
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
  [DEC.PLATE]: [25, 7],         // stacked plates (PAPER above is the single one)
  [DEC.CUPS]: [19, 11],
  [DEC.POT]: [20, 11],
  [DEC.PLANT]: [25, 4],
  [DEC.BUSH]: [20, 6],
};

// ---- overheads (Grid.over) ------------------------------------------------
//
// Two shapes of overhead, because the pack gives two and they autotile
// differently:
//
//   slab  a 9-slice, exactly like the wall composites but keyed on "is the
//         neighbour the same overhead" instead of "is the neighbour solid". The
//         pack ships the timber deck as a real 3x3 with edges and corners, so an
//         awning of any rectangular size draws with its own trim. It has no
//         piece with a north AND a south edge, so a slab must be at least two
//         tiles in each direction — `test/matchflow.ts` asserts that, since a
//         one-tile-thin awning would silently draw with a side missing.
//   line  a pipe run: one cell horizontal, one vertical, picked by whether the
//         neighbours are up/down or left/right. There is no elbow in the set, so
//         runs must be straight — also asserted.
export type OverArt =
  | { kind: 'slab'; cells: Cell[] }   // 9 cells, row-major NW..SE
  | { kind: 'line'; h: Cell; v: Cell };

export const OVER_ART: Record<number, OverArt> = {
  // Timber deck, (193,132,70) planking with a dark rim: a loading-dock or
  // shopfront awning seen from above.
  [OVER.AWNING]: {
    kind: 'slab',
    cells: [[24, 12], [25, 12], [26, 12], [24, 13], [25, 13], [26, 13],
            [24, 14], [25, 14], [26, 14]],
  },
  // Fat orange pipe, centred in its cell (measured: 56px of a 128px cell,
  // centred — the pack's other pipe cells hug a cell edge and would draw a run
  // that looks half a tile off).
  [OVER.PIPE]: { kind: 'line', h: [8, 17], v: [8, 16] },
  // The thin pale run, 36px of 128: conduit rather than plumbing.
  [OVER.CONDUIT]: { kind: 'line', h: [12, 19], v: [12, 18] },
};

/** How many baked variants an overhead has: 9 for a slab, 2 for a line. */
export function overVariants(id: number): number {
  const a = OVER_ART[id];
  return a ? (a.kind === 'slab' ? 9 : 2) : 0;
}

/**
 * Which variant a tile of overhead uses, from the mask of same-overhead
 * neighbours. Slabs pick a 9-slice cell; lines pick vertical when the run is
 * vertical (N or S neighbour) and horizontal otherwise, which makes a lone tile
 * horizontal — a single-tile pipe is a nonsense either way, and there is a test
 * for the corner case that actually matters (an elbow, which has no art).
 */
export function overVariant(id: number, mask: number): number {
  const a = OVER_ART[id];
  if (!a) return 0;
  if (a.kind === 'line') return (mask & (N | S)) ? 1 : 0;
  const row = !(mask & N) ? 0 : !(mask & S) ? 2 : 1;
  const col = !(mask & W) ? 0 : !(mask & E) ? 2 : 1;
  return row * 3 + col;
}

// ---- registry keys --------------------------------------------------------
export const floorKey = (m: number, v: number): string => `floor-${m}-${v}`;
export const wallKey = (m: number, mask: number): string => `wall-${m}-${mask}`;
export const shadeKey = (mask: number): string => `shade-${mask}`;
export const propKey = (m: number): string => `prop-${m}`;
export const decorKey = (f: number): string => `decor-${f}`;
export const overKey = (id: number, v: number): string => `over-${id}-${v}`;

export const isFloorMat = (id: number): boolean => id in FLOOR_ART;
export const isWallMat = (id: number): boolean => id in WALL_ART;
export const isPropMat = (id: number): boolean => id in PROP_ART;
export const isOverId = (id: number): boolean => id in OVER_ART;

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

/**
 * One tile of an overhead prop. Transparent where the prop is not — a pipe is a
 * band across its cell, and what shows either side of it is the world below,
 * which is the whole point of drawing these above the actors.
 */
export function drawOver(g: Ctx, img: Img, id: number, variant: number): void {
  const a = OVER_ART[id];
  if (!a) return;
  blit(g, img, a.kind === 'slab' ? a.cells[variant % 9] : (variant ? a.v : a.h));
}

/**
 * Neighbour mask for a tile, in the N/E/S/W bit order above. `same` answers "is
 * the tile on that side the same thing as this one" — solidity for walls, the
 * same overhead id for overheads.
 */
export function neighbourMask(
  same: (tx: number, ty: number) => boolean, tx: number, ty: number,
): number {
  return (same(tx, ty - 1) ? N : 0) | (same(tx + 1, ty) ? E : 0)
    | (same(tx, ty + 1) ? S : 0) | (same(tx - 1, ty) ? W : 0);
}
