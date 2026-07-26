// Procedural sprite art. Pure Canvas2D drawing functions with no Pixi
// dependency, so the exact same shape code feeds two consumers: the Pixi atlas
// bake (gfx/textures.ts) and the DOM weapon icons (toDataURL, see
// weaponIconDataUrl). One definition per shape — world and HUD cannot drift.
//
// Bodies are drawn as a GREYSCALE LUMINANCE RAMP and tinted at runtime (tint
// is a multiply, so grey -> a darker shade of the team/type color). The ramp is
// deliberately bright-biased — floor around 0.40, never near-black — because
// Outbreak's lightmap multiplies over the world layer and a dark ramp turns to
// mud in the dark. Off-hue details (zombie eyes, the player aim dot) are NOT
// baked in; they stay separate tinted sprites in gfx/scene.ts.
//
// Every body faces +x (aim = 0), matching the gun/tracer/chevron convention,
// and is drawn centred on (0,0) inside a circle of the given radius R. Nothing
// may extend past R: the silhouette is the hitbox.
import type { WeaponId } from '../../../shared/weapons.ts';
import type { PickupKind } from '../../../shared/types.ts';

type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;

export type BodyKind = 'player' | 'walker' | 'runner' | 'brute';
export const BODY_KINDS: BodyKind[] = ['player', 'walker', 'runner', 'brute'];

// 4-frame walk cycle: stride = sin(phase), weight sway = cos(phase), so the two
// mid-stride frames still differ by which side the body is leaning onto.
export const WALK_FRAMES = 4;

// Bodies bake at 2x their on-screen size and are scaled down at draw time, so
// rotating them to arbitrary aim angles resamples cleanly instead of aliasing.
export const BODY_SS = 2;

export function bodyKey(kind: BodyKind, frame: number | 'idle'): string {
  return `body-${kind}-${frame}`;
}

/** The x-ray silhouette of the same frame — see `drawBodyFlat`. */
export function bodyFlatKey(kind: BodyKind, frame: number | 'idle'): string {
  return `flat-${kind}-${frame}`;
}

// ---- Outbreak supply crates ----
// Named `pickup`, never `crate`, in code: shared/maps.ts already has T_CRATE
// tiles, which are scenery you take cover behind rather than loot.
// Greyscale like the bodies, tinted per kind at runtime (gfx/textures.ts), and
// bright-biased for the same reason: the lightmap does not reach them but the
// floor they sit on is rgb(24..30), so a dark crate is a smudge. The two kinds
// differ in silhouette as well as tint — a lid strap and a cross — because a
// player glancing at a distant blip should not have to resolve a hue.
export const PICKUP_SS = 2; // baked supersampled, like the bodies

export function pickupKey(kind: PickupKind): string { return `pickup-${kind}`; }

export function drawPickup(g: Ctx, kind: PickupKind, r: number): void {
  // Box side. The corners plus half the keyline are what reach furthest, and
  // they must stay inside r like every other silhouette here:
  // (1.25/2)*sqrt(2) + 0.16/2 = 0.96 of the radius, same band as the bodies.
  const s = r * 1.25;
  g.lineJoin = 'round';
  // body, with a lighter top face so it reads as a box from above
  g.fillStyle = '#8d8d8d';
  g.fillRect(-s / 2, -s / 2, s, s);
  g.fillStyle = '#b4b4b4';
  g.fillRect(-s / 2, -s / 2, s, s * 0.30);
  // keyline, same trick the guns use: a dark outline is what makes it read
  // against both the floor and a body standing on it
  g.strokeStyle = '#4a4a4a';
  g.lineWidth = Math.max(1, r * 0.16);
  g.strokeRect(-s / 2, -s / 2, s, s);
  if (kind === 'health') {
    // a cross, drawn as two bars so it stays crisp at the bake size
    const t = s * 0.22, arm = s * 0.62;
    g.fillStyle = '#f2f2f2';
    g.fillRect(-t / 2, -arm / 2, t, arm);
    g.fillRect(-arm / 2, -t / 2, arm, t);
  } else {
    // three rounds standing in a row
    g.fillStyle = '#efefef';
    for (let i = -1; i <= 1; i++) {
      const bw = s * 0.14, bh = s * 0.50;
      g.fillRect(i * s * 0.24 - bw / 2, -bh / 2, bw, bh);
    }
    g.fillStyle = '#4a4a4a';
    g.fillRect(-s * 0.42, -s * 0.06, s * 0.84, s * 0.12); // strap across them
  }
}

// Where each kind's head sits, in units of the entity radius. Off-hue overlay
// sprites (zombie eyes) are positioned from this so they land on the baked head
// instead of floating over the torso — keep in sync with the draw functions.
export const HEAD: Record<BodyKind, { x: number; y: number; r: number }> = {
  player: { x: 0.02, y: 0, r: 0.40 },
  walker: { x: 0.26, y: 0.10, r: 0.30 },
  runner: { x: 0.46, y: -0.04, r: 0.28 },
  brute: { x: 0.26, y: 0, r: 0.24 },
};

// ---- greyscale drawing helpers (v is luminance 0..1) ----
function gv(v: number): string {
  const n = Math.round(255 * Math.max(0, Math.min(1, v)));
  return `rgb(${n},${n},${n})`;
}

/**
 * Body keyline state. When `keyW > 0` every primitive below is drawn inflated by
 * that much in one flat dark value instead of its own ramp value, which is the
 * same two-pass trick drawGun uses: outline pass, then colour pass.
 *
 * The bodies need it now because the world does. The floor used to be
 * rgb(24..30) — near black — so a bright-biased ramp was all the contrast a
 * silhouette needed. The tilesheet's floors are mid-tone (asphalt is 74, poured
 * concrete 156, shop tile 245), and against those a tinted ramp with no rim
 * reads as a soft disc rather than a soldier. A dark keyline is also the
 * tileset's own visual language, which is what makes procedural bodies sit in it.
 *
 * KEY_V is deliberately below the 0.40 ramp floor that the rest of art.ts holds
 * to. That rule is about the body's MASSES turning to mud under Outbreak's
 * multiply lightmap; a one-pixel rim is the exception that makes the masses
 * legible in the first place.
 */
let keyW = 0;
const KEY_V = 0.14;

function ell(g: Ctx, x: number, y: number, rx: number, ry: number, rot: number, v: number): void {
  g.fillStyle = keyW ? gv(KEY_V) : gv(v);
  g.beginPath(); g.ellipse(x, y, rx + keyW, ry + keyW, rot, 0, TAU); g.fill();
}
function dot(g: Ctx, x: number, y: number, r: number, v: number): void {
  g.fillStyle = keyW ? gv(KEY_V) : gv(v);
  g.beginPath(); g.arc(x, y, r + keyW, 0, TAU); g.fill();
}
function limb(g: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, v: number): void {
  g.strokeStyle = keyW ? gv(KEY_V) : gv(v);
  g.lineWidth = w + keyW * 2; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
}

// ---- player: tactical silhouette, arms forward with EMPTY hands ----
// The held weapon is a separate sprite drawn above the body (scene.ts), so one
// body frame set serves all five weapons and the gun can recoil independently.
function drawSoldier(g: Ctx, R: number, ph: number | null): void {
  const t = ph == null ? null : ph * TAU;
  const stride = t == null ? 0 : Math.sin(t);
  const sway = (t == null ? 0 : Math.cos(t)) * 0.06 * R;

  // boots, under everything — the part that actually reads as walking.
  // Stride amplitude is bounded by the hitbox: the trailing foot at full
  // extension is the furthest-out part of the whole sprite.
  for (const side of [-1, 1]) {
    const bx = -0.26 * R + side * stride * 0.30 * R;
    const by = side * 0.40 * R + sway;
    ell(g, bx, by, 0.24 * R, 0.17 * R, side * 0.15, 0.45);
  }
  // backpack
  ell(g, -0.60 * R, sway * 0.8, 0.26 * R, 0.42 * R, 0, 0.52);
  // torso + vest panel
  ell(g, -0.10 * R, sway, 0.72 * R, 0.62 * R, 0, 0.68);
  ell(g, -0.02 * R, sway, 0.46 * R, 0.44 * R, 0, 0.60);
  // arms reaching forward, hands meeting ahead of the chest
  for (const side of [-1, 1]) {
    limb(g, 0.06 * R, side * 0.48 * R + sway, 0.66 * R, side * 0.19 * R, 0.24 * R, 0.56);
  }
  // shoulders
  for (const side of [-1, 1]) {
    dot(g, 0.06 * R, side * 0.50 * R + sway * 0.7, 0.27 * R, 0.78);
  }
  // gloves (empty hands)
  for (const side of [-1, 1]) dot(g, 0.72 * R, side * 0.19 * R, 0.15 * R, 0.42);
  // helmet, brightest mass, with a darker brim toward the aim direction
  dot(g, 0.02 * R, sway * 0.7, 0.40 * R, 0.95);
  dot(g, 0.22 * R, sway * 0.7, 0.22 * R, 0.74);
}

// ---- walker: hunched, shambling, asymmetric. Claws are baked in as the
// animated arm ends (the old trig-positioned claw sprites are gone). ----
function drawWalker(g: Ctx, R: number, ph: number | null): void {
  const t = ph == null ? null : ph * TAU;
  const stride = t == null ? 0 : Math.sin(t);
  const sway = (t == null ? 0 : Math.cos(t)) * 0.08 * R;
  const lurch = (t == null ? 0 : Math.sin(t)) * 0.10 * R;

  // dragging feet
  for (const side of [-1, 1]) {
    const bx = -0.32 * R + side * stride * 0.24 * R;
    ell(g, bx, side * 0.35 * R + sway, 0.23 * R, 0.16 * R, side * 0.3, 0.44);
  }
  // torso, tilted — the hunch
  ell(g, -0.14 * R, sway, 0.66 * R, 0.56 * R, -0.22, 0.62);
  // shoulder hump, raised on one side
  dot(g, -0.16 * R, -0.30 * R + sway, 0.34 * R, 0.72);
  dot(g, -0.06 * R, 0.34 * R + sway, 0.26 * R, 0.58);
  // arms outstretched, one high one low, swinging out of sync
  limb(g, -0.10 * R, -0.26 * R + sway, 0.64 * R, -0.34 * R + lurch, 0.20 * R, 0.55);
  limb(g, 0.00 * R, 0.30 * R + sway, 0.60 * R, 0.30 * R - lurch, 0.18 * R, 0.50);
  // claws — the furthest-forward part of the walker, kept inside the hitbox
  dot(g, 0.70 * R, -0.34 * R + lurch, 0.13 * R, 0.38);
  dot(g, 0.66 * R, 0.30 * R - lurch, 0.12 * R, 0.38);
  // head, lolling forward off-centre
  dot(g, 0.26 * R, 0.10 * R + sway * 0.6, 0.30 * R, 0.90);
  // ragged flesh: deterministic notches breaking the outline
  ell(g, -0.52 * R, 0.16 * R, 0.14 * R, 0.10 * R, 0.6, 0.50);
  ell(g, -0.30 * R, -0.44 * R, 0.11 * R, 0.08 * R, -0.4, 0.54);
}

// ---- runner: lean, pitched forward, arms swept back ----
function drawRunner(g: Ctx, R: number, ph: number | null): void {
  const t = ph == null ? null : ph * TAU;
  const stride = t == null ? 0 : Math.sin(t);
  const sway = (t == null ? 0 : Math.cos(t)) * 0.07 * R;

  // long stride — the runner's legs travel furthest, so this amplitude is what
  // the hitbox bound actually binds on
  for (const side of [-1, 1]) {
    const bx = -0.18 * R + side * stride * 0.40 * R;
    ell(g, bx, side * 0.30 * R + sway, 0.24 * R, 0.15 * R, side * 0.25, 0.44);
  }
  // narrow torso, pitched
  ell(g, -0.18 * R, sway, 0.58 * R, 0.44 * R, -0.34, 0.64);
  // arms swept back for speed
  for (const side of [-1, 1]) {
    limb(g, 0.04 * R, side * 0.36 * R + sway, -0.50 * R, side * 0.44 * R - stride * side * 0.14 * R, 0.16 * R, 0.52);
    dot(g, -0.54 * R, side * 0.44 * R - stride * side * 0.14 * R, 0.11 * R, 0.38);
  }
  // shoulders pulled in
  for (const side of [-1, 1]) dot(g, 0.06 * R, side * 0.34 * R + sway * 0.8, 0.22 * R, 0.74);
  // head thrust well forward — the runner's tell at a glance
  dot(g, 0.46 * R, -0.04 * R + sway * 0.5, 0.28 * R, 0.92);
  ell(g, 0.30 * R, -0.02 * R + sway * 0.5, 0.16 * R, 0.20 * R, 0, 0.70);
}

// ---- brute: wide, heavy, tiny head sunk between huge shoulders ----
function drawBrute(g: Ctx, R: number, ph: number | null): void {
  const t = ph == null ? null : ph * TAU;
  const stride = t == null ? 0 : Math.sin(t);
  const sway = (t == null ? 0 : Math.cos(t)) * 0.05 * R;

  // heavy plodding feet
  for (const side of [-1, 1]) {
    const bx = -0.28 * R + side * stride * 0.22 * R;
    ell(g, bx, side * 0.44 * R + sway, 0.27 * R, 0.19 * R, 0, 0.42);
  }
  // massive torso
  ell(g, -0.10 * R, sway, 0.74 * R, 0.68 * R, 0, 0.66);
  // armour plating across the back
  ell(g, -0.34 * R, sway, 0.30 * R, 0.52 * R, 0, 0.54);
  // thick arms forward
  for (const side of [-1, 1]) {
    limb(g, 0.00 * R, side * 0.54 * R + sway, 0.58 * R, side * 0.34 * R + stride * side * 0.06 * R, 0.30 * R, 0.58);
    dot(g, 0.62 * R, side * 0.34 * R + stride * side * 0.06 * R, 0.17 * R, 0.40);
  }
  // huge shoulders
  for (const side of [-1, 1]) dot(g, 0.02 * R, side * 0.56 * R + sway * 0.6, 0.34 * R, 0.76);
  // small head, sunk low between them
  dot(g, 0.26 * R, sway * 0.5, 0.24 * R, 0.88);
}

/** Keyline width as a fraction of R. ~1.5px at the baked radius of a player. */
const BODY_OL = 0.045;

/**
 * Draws a body, keyline pass first.
 *
 * THE RADIUS INVARIANT IS PRESERVED BY CONSTRUCTION, and this is the whole
 * reason the shapes are drawn at `R - ol` rather than at `R`. The keyline
 * inflates every primitive by `ol`, so the furthest-out pixel moves from
 * `p * R` to `p * (R - ol) + ol`, which is `p*R + ol*(1 - p)` — strictly less
 * than R for any silhouette that already fit. The four kinds peak at 0.90-0.96
 * of R, so the rim costs at most 0.4% of the radius and the sprite outline is
 * still inside the ring that marks the hitbox.
 *
 * Nothing type-checks that, exactly as the note in CLAUDE.md warns. Re-measure
 * if you change a body's proportions: the binding cases are the soldier's
 * trailing boot at full stride and the walker's reaching claw.
 */
export function drawBody(g: Ctx, kind: BodyKind, R: number, ph: number | null): void {
  const ol = R * BODY_OL;
  const Rs = R - ol;
  const paint = (): void => {
    if (kind === 'player') drawSoldier(g, Rs, ph);
    else if (kind === 'walker') drawWalker(g, Rs, ph);
    else if (kind === 'runner') drawRunner(g, Rs, ph);
    else drawBrute(g, Rs, ph);
  };
  keyW = ol;
  paint();
  keyW = 0;
  paint();
}

/**
 * The same frame as one flat shape: every painted pixel white, alpha untouched.
 *
 * This is what an occluded actor is drawn with (gfx/scene.ts reparents it above
 * the overhead and tints it its team colour). It has to be its own bake rather
 * than a tint of the normal frame because the normal frame is a luminance ramp:
 * tinting that gives a shaded body, and a shaded body under a roof would carry
 * *more* information than the exposed one beside it. Flat is the point.
 *
 * Made by compositing rather than by a second set of draw calls, so the
 * silhouette is the same shape code and cannot drift from it — which also means
 * the radius invariant it satisfies (nothing past R, keyline included) is
 * inherited rather than re-argued. `source-atop` keeps the destination's alpha,
 * so the anti-aliased rim survives; the clip is what confines both the composite
 * and the fill to this atlas cell.
 */
export function drawBodyFlat(g: Ctx, kind: BodyKind, R: number, ph: number | null,
                             size: number): void {
  g.save();
  g.beginPath();
  g.rect(-size / 2, -size / 2, size, size);
  g.clip();
  drawBody(g, kind, R, ph);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = '#fff';
  g.fillRect(-size / 2, -size / 2, size, size);
  g.restore();
}

// ---- weapons ----
// Guns are pre-coloured (never team-tinted), so unlike bodies they get full hue
// freedom — and each one gets a distinct palette, so a weapon is identifiable at
// a glance in the world, the HUD slots and the armory.
export interface GunPal {
  frame: string;      // receiver / slide — the metal spine of the gun
  barrel: string;     // barrel steel, darker metal
  furniture: string;  // stock, grip, handguard: polymer / wood / FDE
  accent: string;     // optics housing, muzzle device, sights
  glass: string;      // optic lens or red-dot
  shadow: string;     // vents, ejection port, ridges
  edge: string;       // top highlight along the barrel line
  outline: string;    // dark keyline, drawn inflated behind everything
}

// Deliberately MID-TONE, and each weapon gets a signature hue so it is
// identifiable in the world and in the HUD.
//
// The original reason for mid-tone was that the procedural floor was rgb(24..30)
// and a dark gun vanished into it. The tilesheet floors are brighter — asphalt
// 74, poured concrete 156, shop tile 245 — so that hazard is gone and the range
// these sit in reads against all of them; verified in-match on asphalt and on
// concrete. The values are unchanged because they still work, not by neglect:
// what carries them on the pale floors is the near-black `outline` keyline, so
// that is the entry to leave alone.
const GUN_PAL: Record<WeaponId, GunPal> = {
  // bright gunmetal sidearm, pale steel sights
  pistol: { frame: '#5a6675', barrel: '#3c444e', furniture: '#2e343c', accent: '#b9c6d4', glass: '#ff6a5e', shadow: '#1b1f24', edge: '#8f9dad', outline: '#0d1014' },
  // black polymer with burnt-orange furniture
  smg: { frame: '#4e5764', barrel: '#363d45', furniture: '#a35a28', accent: '#e08a3c', glass: '#ff6a5e', shadow: '#20242a', edge: '#8a97a6', outline: '#0d1014' },
  // flat-dark-earth furniture over a grey upper
  rifle: { frame: '#414a55', barrel: '#2f353d', furniture: '#b09a70', accent: '#6f7c8b', glass: '#7ce8ae', shadow: '#23272d', edge: '#d8c79c', outline: '#0d1014' },
  // walnut furniture, blued steel, brass bead
  shotgun: { frame: '#4a525d', barrel: '#3a4149', furniture: '#8b5e34', accent: '#f0c65e', glass: '#f0c65e', shadow: '#221c16', edge: '#b07f4a', outline: '#0d1014' },
  // olive drab marksman rifle with a big glass optic
  sniper: { frame: '#4d5560', barrel: '#333940', furniture: '#6e7a54', accent: '#3f4650', glass: '#8fdcff', shadow: '#1c2026', edge: '#93a06e', outline: '#0d1014' },
};

// Guns bake supersampled and scale down at draw time (same reason as bodies):
// they rotate to arbitrary aim angles, and the detail would alias at 1:1.
export const GUN_SS = 4;

// Width of the dark keyline. Parts are inset by this much from the cell edge, so
// GUN_SPEC sizes are OUTER dimensions including the outline.
const OL = 0.6;

// len drives both the sprite and the muzzle offset (see gunMuzzle) so the
// muzzle flash, tracer origin and flash light land on the actual barrel end.
export const GUN_SPEC: Record<WeaponId, { len: number; h: number }> = {
  pistol: { len: 20, h: 9 },
  smg: { len: 25, h: 10 },
  rifle: { len: 30, h: 10 },
  shotgun: { len: 30, h: 11.5 },
  sniper: { len: 36, h: 10.5 },
};

// Lifts a hex colour toward white — the HUD sits on near-black, where the
// world palettes go muddy.
function lift(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.round(v + (255 - v) * amt);
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

export function gunPal(id: WeaponId, forHud = false): GunPal {
  const p = GUN_PAL[id];
  if (!forHud) return p;
  return {
    frame: lift(p.frame, 0.34), barrel: lift(p.barrel, 0.28),
    furniture: lift(p.furniture, 0.24), accent: lift(p.accent, 0.3),
    glass: lift(p.glass, 0.1), shadow: lift(p.shadow, 0.16),
    edge: lift(p.edge, 0.38), outline: p.outline,
  };
}

// The grip end sits this far in front of the player centre (the hands sit at
// ~0.72 * PLAYER_RADIUS, so the gun meets them).
export const GUN_START = 9;

export function gunMuzzle(id: WeaponId): number { return GUN_START + GUN_SPEC[id].len; }
export function gunKey(id: WeaponId): string { return `gun-${id}`; }

// Guns are described declaratively as parts so drawGun can render them twice:
// once inflated in the outline colour, once in full colour. `c` names a GunPal
// role. Coordinates are WORLD units within [0,len] x [0,h], x=0 the grip end.
type Part =
  | { k: 'box'; x: number; y: number; w: number; h: number; c: keyof GunPal }
  | { k: 'pip'; x: number; y: number; r: number; c: keyof GunPal };

const bx = (x: number, y: number, w: number, h: number, c: keyof GunPal): Part =>
  ({ k: 'box', x, y, w, h, c });
const pp = (x: number, y: number, r: number, c: keyof GunPal): Part =>
  ({ k: 'pip', x, y, r, c });

function gunParts(id: WeaponId): Part[] {
  const cy = GUN_SPEC[id].h / 2;
  if (id === 'pistol') {
    return [
      bx(0.8, cy - 3.2, 7, 6.4, 'furniture'),     // polymer frame + grip
      bx(2, cy + 1.6, 4.5, 1.6, 'shadow'),        // grip stippling
      bx(6.5, cy + 2.0, 2.6, 1.4, 'shadow'),      // trigger guard
      bx(2.5, cy - 2.0, 14.5, 4.0, 'frame'),      // slide
      bx(3.6, cy - 2.0, 0.7, 4.0, 'shadow'),      // slide serrations
      bx(5.0, cy - 2.0, 0.7, 4.0, 'shadow'),
      bx(7, cy - 2.0, 4, 1.3, 'shadow'),          // ejection port
      bx(16.5, cy - 1.4, 2.7, 2.8, 'barrel'),     // muzzle end
      bx(18.2, cy - 1.4, 1.0, 2.8, 'accent'),     // muzzle ring
      bx(3.2, cy - 2.9, 1.5, 5.8, 'accent'),      // rear sight
      bx(15.3, cy - 2.6, 1.2, 5.2, 'accent'),     // front sight
      bx(3, cy - 2.0, 14, 0.8, 'edge'),
    ];
  }
  if (id === 'smg') {
    return [
      bx(0.8, cy - 4.0, 4.2, 8.0, 'frame'),       // folding stock plate
      bx(3.4, cy - 3.2, 9.5, 6.4, 'furniture'),
      bx(4.4, cy - 2.2, 12, 4.4, 'frame'),        // upper receiver
      bx(4.4, cy - 2.9, 8, 0.9, 'accent'),        // top rail
      bx(5.6, cy - 2.9, 0.7, 0.9, 'shadow'),      // rail slots
      bx(7.4, cy - 2.9, 0.7, 0.9, 'shadow'),
      bx(9.2, cy - 2.9, 0.7, 0.9, 'shadow'),
      pp(3.2, cy + 3.2, 0.7, 'accent'),           // sling loop
      bx(12.5, cy - 3.4, 6.5, 6.8, 'furniture'),  // fat foregrip
      bx(13.3, cy - 0.8, 1.2, 1.6, 'shadow'),
      bx(15.3, cy - 0.8, 1.2, 1.6, 'shadow'),
      bx(17.3, cy - 0.8, 1.2, 1.6, 'shadow'),
      bx(18.5, cy - 1.3, 4.5, 2.6, 'barrel'),
      bx(22.2, cy - 2.2, 2.0, 4.4, 'accent'),     // muzzle device
      bx(5.0, cy - 1.8, 6.0, 3.6, 'accent'),      // red-dot housing
      pp(8.0, cy, 1.1, 'glass'),
      bx(10.5, cy + 2.3, 3.4, 1.8, 'frame'),      // mag well bulge
      bx(5.0, cy - 3.6, 1.4, 1.6, 'accent'),      // charging handle
      bx(4.4, cy - 2.2, 13, 0.8, 'edge'),
    ];
  }
  if (id === 'rifle') {
    return [
      bx(0.8, cy - 3.6, 13, 7.2, 'furniture'),    // FDE stock + lower
      bx(1.6, cy - 2.4, 3, 4.8, 'shadow'),        // buttplate
      bx(3.4, cy - 2.3, 15, 4.6, 'frame'),        // upper receiver
      bx(3.4, cy - 3.0, 12, 0.9, 'accent'),       // flat-top rail
      bx(4.2, cy - 3.6, 1.2, 1.6, 'accent'),      // rear sight
      bx(12, cy - 1.0, 2.6, 1.2, 'shadow'),       // shell deflector
      bx(15.5, cy - 2.9, 9.5, 5.8, 'furniture'),  // FDE handguard
      bx(16.4, cy - 0.7, 1.3, 1.4, 'shadow'),
      bx(18.5, cy - 0.7, 1.3, 1.4, 'shadow'),
      bx(20.6, cy - 0.7, 1.3, 1.4, 'shadow'),
      bx(22.7, cy - 0.7, 1.3, 1.4, 'shadow'),
      bx(24.5, cy - 1.2, 4.0, 2.4, 'barrel'),
      bx(27.4, cy - 2.2, 1.8, 4.4, 'accent'),     // muzzle brake
      bx(6.0, cy - 1.9, 8.5, 3.8, 'accent'),      // optic body
      pp(10.5, cy, 1.2, 'glass'),
      bx(10.5, cy + 2.3, 4.0, 1.8, 'frame'),      // magazine
      bx(3.4, cy - 2.3, 14, 0.8, 'edge'),
    ];
  }
  if (id === 'shotgun') {
    return [
      bx(0.8, cy - 3.6, 9.5, 7.2, 'furniture'),   // walnut stock
      bx(1.6, cy - 2.4, 2.6, 4.8, 'shadow'),
      bx(9, cy - 3.3, 7.5, 6.6, 'frame'),         // blued receiver
      bx(9, cy - 3.9, 7.5, 0.8, 'accent'),        // receiver rib
      bx(10, cy - 1.1, 4.8, 1.3, 'shadow'),       // ejection port
      pp(11.5, cy - 0.4, 0.7, 'accent'),          // brass shell in the port
      bx(15.5, cy - 4.3, 7.5, 8.6, 'furniture'),  // walnut pump, widest part
      bx(16.3, cy - 4.3, 0.9, 8.6, 'shadow'),
      bx(18.0, cy - 4.3, 0.9, 8.6, 'shadow'),
      bx(19.7, cy - 4.3, 0.9, 8.6, 'shadow'),
      bx(21.4, cy - 4.3, 0.9, 8.6, 'shadow'),
      bx(22.5, cy - 1.9, 6.7, 3.8, 'barrel'),     // thick barrel
      bx(22.5, cy + 1.9, 5.8, 1.7, 'frame'),      // mag tube
      pp(28.3, cy - 2.1, 1.0, 'accent'),          // brass bead
      bx(22.5, cy - 1.9, 6.2, 0.9, 'edge'),
    ];
  }
  return [
    bx(0.8, cy - 3.8, 13, 7.6, 'furniture'),      // olive stock
    bx(1.6, cy - 2.4, 2.6, 4.8, 'shadow'),        // cheek rest
    bx(9.5, cy - 2.9, 9, 5.8, 'frame'),           // receiver
    bx(21, cy - 1.3, 14.2, 2.6, 'barrel'),        // long thin barrel
    bx(6.5, cy - 2.5, 14, 5.0, 'accent'),         // scope tube
    bx(6.5, cy - 3.0, 1.6, 6.0, 'accent'),        // eyepiece ring
    bx(24, cy - 0.4, 8, 0.8, 'shadow'),           // barrel fluting
    bx(9.2, cy - 3.4, 1.8, 6.8, 'accent'),        // elevation turret
    bx(13, cy - 3.4, 1.5, 6.8, 'accent'),         // windage turret
    bx(19, cy - 3.0, 2.6, 6.0, 'accent'),         // objective bell
    pp(20.2, cy, 1.6, 'glass'),                   // big lens
    pp(20.2, cy - 0.6, 0.6, 'edge'),              // lens glint
    bx(25, cy - 3.9, 1.2, 2.6, 'frame'),          // bipod legs
    bx(25, cy + 1.3, 1.2, 2.6, 'frame'),
    bx(32.8, cy - 2.2, 2.4, 4.4, 'accent'),       // muzzle brake
    bx(33.4, cy - 2.2, 0.9, 4.4, 'shadow'),       // brake port
    bx(11.5, cy + 2.5, 3.2, 1.9, 'frame'),        // magazine
    bx(21, cy - 1.3, 11, 0.7, 'edge'),
  ];
}

// Two passes: a dark keyline (every solid part inflated by OL) then full colour.
// The keyline is what makes a gun read against both the dark floor and the
// player's body it overlaps.
export function drawGun(g: Ctx, id: WeaponId, forHud = false): void {
  const pal = gunPal(id, forHud);
  const parts = gunParts(id);
  g.fillStyle = pal.outline;
  for (const p of parts) {
    if (p.c === 'edge' || p.c === 'glass' || p.c === 'shadow') continue; // interior detail
    if (p.k === 'box') g.fillRect(p.x - OL, p.y - OL, p.w + 2 * OL, p.h + 2 * OL);
    else { g.beginPath(); g.arc(p.x, p.y, p.r + OL, 0, TAU); g.fill(); }
  }
  for (const p of parts) {
    g.fillStyle = pal[p.c];
    if (p.k === 'box') g.fillRect(p.x, p.y, p.w, p.h);
    else { g.beginPath(); g.arc(p.x, p.y, p.r, 0, TAU); g.fill(); }
  }
}

// Standalone raster for the DOM HUD / armory / loadout buttons. Same draw
// function as the atlas bake, HUD-lifted palette, supersampled for retina.
export function weaponIconDataUrl(id: WeaponId, ss = 4): string {
  const { len, h } = GUN_SPEC[id];
  const pad = 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil((len + pad * 2) * ss);
  c.height = Math.ceil((h + pad * 2) * ss);
  const g = c.getContext('2d')!;
  g.scale(ss, ss);
  g.translate(pad, pad);
  drawGun(g, id, true);
  return c.toDataURL('image/png');
}
