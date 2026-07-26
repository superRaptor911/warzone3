// The ambient floor of the lightmap, split indoor/outdoor.
//
// Pure, with no DOM and no Pixi import — the same rule view.ts and stick.ts
// follow, and for the same reason: `test/matchflow.ts` imports this under Node.
// Both of the things that can be wrong here are provable there and nowhere else.
// The two values must be ordered and neither may reach black; the mask must cover
// exactly the roofed part of the map, walls and furniture included. A screenshot
// can tell you the multiply happened — it cannot tell you a run overshot a room
// by one tile, or that a wall corner was left lit.
import { TILE } from '../../../shared/constants.ts';
import { matIndoor, type Grid } from '../../../shared/maps.ts';

export interface AmbientPair {
  /** Under open sky. */
  outdoor: number;
  /** Under a roof — always the darker of the two, never black. */
  indoor: number;
}

/**
 * The ambient floor per mode, as a multiply tint.
 *
 * The split is atmosphere, not information. Multiply scales the body and the
 * floor beneath it by the same factor, so the *contrast* an out-of-sight zombie
 * has against its room is identical at either value — which is what keeps
 * "darkness dims but never hides" true of the darker entry. That is also why
 * neither indoor value is anywhere near black: the rule is about a floor, and a
 * floor at 0 hides whatever stands on it however honest the contrast is.
 *
 * TDM is ambience only (no LOS masking, ever), so its pair is a mood split — a
 * daylit forecourt against a dimmer interior. Compound is authored through
 * `rotated()`, so both teams get exactly the same amount of each.
 */
export const AMBIENT: Record<'tdm' | 'zombie', AmbientPair> = {
  // ~18% luminance outside, ~13% in. THE tuning knob for Outbreak.
  zombie: { outdoor: 0x2e3446, indoor: 0x212636 },
  // barely below neutral outside, clearly an interior inside
  tdm: { outdoor: 0xd9dce3, indoor: 0xa8adba },
};

export function ambientFor(mode: string): AmbientPair {
  return mode === 'zombie' ? AMBIENT.zombie : AMBIENT.tdm;
}

/** A merged run of roofed tiles, in world px. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Which tiles are under a roof, as 0/1 per tile.
 *
 * `MAT_INDOOR` is authored on FLOORS (every `paint` that sets it is filtered to
 * `T_FLOOR`), so taking the flag alone would leave every wall and every piece of
 * furniture inside a building at full outdoor brightness — a sofa glowing in a
 * dark flat, and a bright keyline around every interior partition. The second
 * pass fixes that by derivation rather than by authoring: a solid tile is roofed
 * if it touches roofed floor, which makes a building's footprint — its
 * partitions, its outer walls and its contents — one lit region.
 *
 * Deriving it keeps the authored vocabulary at one flag on one tile kind, and
 * keeps this decision where it belongs, in render-only code. Pass 2 only ever
 * writes solid tiles and only ever reads non-solid ones, so it cannot feed on
 * its own output and creep across the map.
 *
 * The neighbourhood is 8, not 4, and that is measured rather than assumed: at 4
 * the two maps left 40 and 28 lit specks, every one of them a wall corner or a
 * crate wedged between two solids — tiles that touch the room only diagonally.
 * Diagonals take that to 10 and 7, and the survivors are all *outer* corners of a
 * footprint, where the roof edge honestly is. What it costs is that a crate on the
 * pavement diagonally across a doorway from an indoor tile now dims with the
 * building; that is a tile of pavement furniture reading as part of the porch,
 * which is the cheaper of the two errors.
 */
export function indoorTiles(g: Grid): Uint8Array {
  const m = new Uint8Array(g.w * g.h);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      if (matIndoor(g.matAt(tx, ty))) m[g.idx(tx, ty)] = 1;
    }
  }
  const roofedFloor = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < g.w && ty < g.h
    && !g.solid(tx, ty) && m[g.idx(tx, ty)] === 1;
  const nearRoofedFloor = (tx: number, ty: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && roofedFloor(tx + dx, ty + dy)) return true;
      }
    }
    return false;
  };
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      if (g.solid(tx, ty) && nearRoofedFloor(tx, ty)) m[g.idx(tx, ty)] = 1;
    }
  }
  return m;
}

/**
 * The roofed region as horizontal runs in world px, ready to fill.
 *
 * Merged per row rather than emitted per tile because this is drawn as one static
 * Graphics inside the lightmap: 356 roofed tiles collapse to 29 runs in Outbreak
 * and 544 to 80 in Compound, and the fill is built exactly once per match.
 */
export function indoorRects(g: Grid): Rect[] {
  const m = indoorTiles(g);
  const out: Rect[] = [];
  for (let ty = 0; ty < g.h; ty++) {
    let run = -1;
    for (let tx = 0; tx <= g.w; tx++) {
      const on = tx < g.w && m[g.idx(tx, ty)] === 1;
      if (on && run < 0) run = tx;
      else if (!on && run >= 0) {
        out.push({ x: run * TILE, y: ty * TILE, w: (tx - run) * TILE, h: TILE });
        run = -1;
      }
    }
  }
  return out;
}
