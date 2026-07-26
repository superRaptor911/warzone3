// Viewport math: zoom, render resolution, HUD scale.
//
// Pure functions with no DOM and no Pixi imports, so test/matchflow.ts can
// import this module directly under Node. Everything that decides "how much
// world fits on this screen" lives here and nowhere else — the renderer, the
// camera clamp and the input layer all derive from `zoomFor`.

export type QualityTier = 'sharp' | 'fast';

// World px we try to keep visible — and it now means that in BOTH directions.
//
// It used to be a floor only (`Math.min(1, …)`: never zoom in), on the argument
// that every ordinary desktop should then be bit-identical to the pre-zoom
// renderer. The cost of that parity was never written down and is large: with
// maps deliberately fixed at 40x30 and 44x34 (tasks/WORLD-ART.md), a 1:1 desktop
// sees most of the level at once. Measured at 1920x1080 — Outbreak 91% of the map
// width, Compound *all* of it, at which point `camera()` stops following the
// player sideways and pins to the map centre. A 34px body in a 1920px frame is
// what "feels tiny" is.
//
// So the target is now symmetric: a viewport smaller than this scales down, a
// larger one scales up, and everyone between the floor and the ceiling sees the
// same amount of world regardless of monitor. That is strictly more equal than
// what it replaced, where field of view grew with the window — a 1920x1080 client
// saw 2.6x the world area of a 1300x620 one.
export const VIEW_TARGET_W = 1300;
export const VIEW_TARGET_H = 620;

// Below this a 34px player sprite stops reading as a body (17 CSS px across).
// A very small landscape phone hits the floor rather than shrinking further.
export const ZOOM_MIN = 0.5;

/**
 * The zoom-in ceiling, and it is an art limit rather than a taste one. A tile is
 * 48 world px and its atlas cell is baked at 96px (`TILE_SS`), so the tilemap is
 * pixel-exact while `zoom * resolution <= 2` and magnified above it. At 2 a
 * DPR-1 screen lands exactly on the cell; a DPR-2 screen is already past it
 * (`resolutionFor` caps the backing store at 2), which is the one place going
 * higher visibly costs sharpness. Raising it wants 128px cells — the tilesheet's
 * native size — and that needs a 4096x2048 atlas, not a bigger number here.
 */
export const ZOOM_MAX = 2;

/**
 * World-px-per-CSS-px for a viewport, clamped to [ZOOM_MIN, ZOOM_MAX].
 *
 * Worth knowing what the tighter view does to gunfights, because it is the real
 * trade: at 1920x1080 the zoom is 1.48, so the visible half-width is 650 world px
 * and every weapon except the shotgun (420) out-ranges it — pistol 800, smg 700,
 * rifle 1100, sniper 1800. Rifle and sniper already did at 1:1 (960), so this
 * widens an existing property rather than introducing one, and damage falloff
 * starts well inside the screen for all of them. Outbreak's off-screen threat
 * chevrons (REACH 500, `gfx/ui.ts`) are what cover the approach warning; TDM has
 * none by design, so a long lane is now something you enter rather than survey.
 */
export function zoomFor(vw: number, vh: number): number {
  const z = Math.min(vw / VIEW_TARGET_W, vh / VIEW_TARGET_H);
  if (!(z > 0)) return 1; // NaN / zero-size viewport during layout
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

/**
 * Backing-store resolution for a quality tier. Capped at 2 so a DPR-3 phone
 * never pays 9x the fragment cost of the lightmap, bloom and composites.
 */
export function resolutionFor(tier: QualityTier, dpr: number): number {
  if (tier === 'fast') return 1;
  return Math.max(1, Math.min(2, dpr || 1));
}

/** Bloom is the other half of the tier — cosmetic, so it can differ per client. */
export function bloomFor(tier: QualityTier): boolean {
  return tier === 'sharp';
}

// HUD shrink factor for small/touch screens. The condition that selects it is
// duplicated as a CSS media query in style.css (`(pointer: coarse),
// (max-height: 500px)`) — keep the two in step.
export const UI_SCALE_SMALL = 0.62;

export function uiScaleFor(compact: boolean): number {
  return compact ? UI_SCALE_SMALL : 1;
}
