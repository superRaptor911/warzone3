// Viewport math: zoom, render resolution, HUD scale.
//
// Pure functions with no DOM and no Pixi imports, so test/matchflow.ts can
// import this module directly under Node. Everything that decides "how much
// world fits on this screen" lives here and nowhere else — the renderer, the
// camera clamp and the input layer all derive from `zoomFor`.

export type QualityTier = 'sharp' | 'fast';

// World px we try to keep visible. Any viewport at least this large renders at
// zoom 1, so every ordinary desktop is bit-identical to the pre-zoom renderer;
// only phones, tablets and small windows scale down.
export const VIEW_TARGET_W = 1300;
export const VIEW_TARGET_H = 620;

// Below this a 34px player sprite stops reading as a body (17 CSS px across).
// A very small landscape phone hits the floor rather than shrinking further.
export const ZOOM_MIN = 0.5;

/** World-px-per-CSS-px for a viewport. Never zooms in; clamped at ZOOM_MIN. */
export function zoomFor(vw: number, vh: number): number {
  const z = Math.min(1, vw / VIEW_TARGET_W, vh / VIEW_TARGET_H);
  if (!(z > 0)) return 1; // NaN / zero-size viewport during layout
  return Math.max(ZOOM_MIN, Math.min(1, z));
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
