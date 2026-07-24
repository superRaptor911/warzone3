import { Assets, Rectangle, Sprite, Texture } from 'pixi.js';
import type { Spritesheet } from 'pixi.js';
import { PLAYER_RADIUS, TEAM, TILE } from '../../../shared/constants.ts';
import { T_CRATE, T_FLOOR, T_WALL, type Grid } from '../../../shared/maps.ts';
import type { WeaponId } from '../../../shared/weapons.ts';
import type { ZombieTypeId } from '../../../shared/types.ts';

export interface TeamColor { body: string; dark: string; name: string }
export const TEAM_COLORS: Record<number, TeamColor> = {
  [TEAM.RED]: { body: '#c94439', dark: '#8a2d25', name: '#ff8b81' },
  [TEAM.BLUE]: { body: '#3d6fc2', dark: '#294b85', name: '#8ebbff' },
  [TEAM.SURVIVOR]: { body: '#4c9e5f', dark: '#336b41', name: '#9fe870' },
};
export const ZTYPE: Record<ZombieTypeId, { color: string; dark: string; r: number }> = {
  walker: { color: '#5d8a42', dark: '#3d5c2b', r: 15 },
  runner: { color: '#8fb457', dark: '#5c7a36', r: 13 },
  brute: { color: '#39602c', dark: '#24401b', r: 22 },
};

export const DISC_R = 32;        // 'disc' bake radius; scale = wantedRadius / DISC_R
export const TRACER_W = 64;      // 'tracer' strip length in texture px
export const TRACER_H = 4;
export const CHEVRON_S = 18;     // 'chevron' baked at this nominal size
export const GUN_LEN: Record<string, number> = { sniper: 30, pistol: 18, rifle: 25 };

export function gunKey(w: WeaponId): string {
  return w === 'sniper' ? 'gun-sniper' : w === 'pistol' ? 'gun-pistol' : 'gun-rifle';
}
export function ringKey(r: number, w: number): string { return `ring:${r}x${w}`; }

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

// The full tile map, baked once with Canvas2D (identical output to the old
// renderer) and uploaded as a single static texture.
function buildMapCanvas(g: Grid): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = g.pxW(); c.height = g.pxH();
  if (c.width > 4096 || c.height > 4096) throw new Error('map exceeds 4096px texture limit — split needed');
  const x = c.getContext('2d')!;
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const v = g.get(tx, ty), px = tx * TILE, py = ty * TILE;
      if (v === T_FLOOR) {
        const n = hash2(tx, ty);
        const b = 24 + n * 6;
        x.fillStyle = `rgb(${b},${b + 3},${b + 8})`;
        x.fillRect(px, py, TILE, TILE);
        x.strokeStyle = 'rgba(255,255,255,0.025)';
        x.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
        if (n > 0.93) { // floor detail: cracks/stains
          x.fillStyle = 'rgba(0,0,0,0.18)';
          x.beginPath();
          x.ellipse(px + TILE * n, py + TILE * (1 - n), 8, 5, n * 6, 0, 7);
          x.fill();
        }
      } else if (v === T_WALL) {
        x.fillStyle = '#3a4450';
        x.fillRect(px, py, TILE, TILE);
        x.fillStyle = '#465364';
        x.fillRect(px, py, TILE, 6);
        x.fillStyle = 'rgba(0,0,0,0.35)';
        if (!g.solid(tx, ty + 1)) x.fillRect(px, py + TILE - 5, TILE, 5);
        x.strokeStyle = '#242c36';
        x.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else if (v === T_CRATE) {
        const n = hash2(tx, ty);
        x.fillStyle = `rgb(${28},${31},${37})`;
        x.fillRect(px, py, TILE, TILE);
        x.fillStyle = n > 0.5 ? '#6e5232' : '#75593a';
        x.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
        x.strokeStyle = '#3f2e1b';
        x.lineWidth = 2;
        x.strokeRect(px + 5, py + 5, TILE - 10, TILE - 10);
        x.beginPath();
        x.moveTo(px + 5, py + 5); x.lineTo(px + TILE - 5, py + TILE - 5);
        x.moveTo(px + TILE - 5, py + 5); x.lineTo(px + 5, py + TILE - 5);
        x.stroke();
        x.lineWidth = 1;
      }
    }
  }
  return c;
}

function buildMiniCanvas(g: Grid): HTMLCanvasElement {
  const scale = 4;
  const c = document.createElement('canvas');
  c.width = g.w * scale; c.height = g.h * scale;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgba(10,13,18,0.78)';
  x.fillRect(0, 0, c.width, c.height);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const v = g.get(tx, ty);
      if (v !== T_FLOOR) {
        x.fillStyle = v === T_WALL ? '#57647a' : '#6e5232';
        x.fillRect(tx * scale, ty * scale, scale, scale);
      }
    }
  }
  return c;
}

interface AtlasEntry { tex: Texture; ax: number; ay: number }

// probe once per page load (one 404 in devtools at most, none on reconnect)
let artProbe: Promise<Spritesheet | null> | null = null;
function loadArtSheet(): Promise<Spritesheet | null> {
  artProbe ??= (async () => {
    const head = await fetch('/assets/atlas.json', { method: 'HEAD' });
    if (!head.ok) return null;
    return Assets.load<Spritesheet>('/assets/atlas.json');
  })().catch(() => null);
  return artProbe;
}

// All small shapes are baked into one 512x512 canvas atlas so every sprite
// shares a single texture source (full batching). Shapes that vary by team or
// zombie type are baked white and tinted at runtime — this is also the
// spritesheet contract for future real art (phase 5).
export class GfxTextures {
  map!: Texture;
  mini!: Texture;
  private atlasBase!: Texture;
  private entries = new Map<string, AtlasEntry>();

  entry(key: string): AtlasEntry {
    const e = this.entries.get(key);
    if (!e) throw new Error(`unknown texture key: ${key}`);
    return e;
  }

  sprite(key: string): Sprite {
    const e = this.entry(key);
    const s = new Sprite(e.tex);
    s.anchor.set(e.ax, e.ay);
    return s;
  }

  bake(grid: Grid): void {
    this.map = Texture.from(buildMapCanvas(grid));
    this.mini = Texture.from(buildMiniCanvas(grid));

    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const x = c.getContext('2d')!;
    const PAD = 3;
    let cx = PAD, cy = PAD, rowH = 0;
    const pending: { key: string; rect: Rectangle; ax: number; ay: number }[] = [];
    const cell = (key: string, w: number, h: number, ax: number, ay: number,
                  draw: (g: CanvasRenderingContext2D) => void): void => {
      w = Math.ceil(w); h = Math.ceil(h);
      if (cx + w + PAD > c.width) { cx = PAD; cy += rowH + PAD; rowH = 0; }
      if (cy + h + PAD > c.height) throw new Error('atlas overflow');
      x.save();
      x.translate(cx, cy);
      draw(x);
      x.restore();
      pending.push({ key, rect: new Rectangle(cx, cy, w, h), ax, ay });
      cx += w + PAD;
      rowH = Math.max(rowH, h);
    };

    // solid white square — tinted/scaled for sparks, bars, crosshair
    cell('white', 8, 8, 0.5, 0.5, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); });

    // white disc, radius 32 — scaled down for bodies, claws, eyes, dots, blips
    cell('disc', DISC_R * 2 + 2, DISC_R * 2 + 2, 0.5, 0.5, g => {
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(DISC_R + 1, DISC_R + 1, DISC_R, 0, 7); g.fill();
    });

    // white rings at the exact radii/stroke-widths the old renderer used
    const rings: [number, number][] = [
      [PLAYER_RADIUS, 3], [PLAYER_RADIUS, 2.5], [PLAYER_RADIUS + 5, 1], // edge / my edge / prot
      [ZTYPE.runner.r, 3], [ZTYPE.walker.r, 3], [ZTYPE.brute.r, 3],    // zombie edges
      [ZTYPE.runner.r + 5, 2.5], [ZTYPE.walker.r + 5, 2.5], [ZTYPE.brute.r + 5, 2.5], // frenzy
    ];
    for (const [r, w] of rings) {
      const size = Math.ceil(2 * r + w + 4);
      cell(ringKey(r, w), size, size, 0.5, 0.5, g => {
        g.strokeStyle = '#fff'; g.lineWidth = w;
        g.beginPath(); g.arc(size / 2, size / 2, r, 0, 7); g.stroke();
      });
    }

    // guns: dark barrel with lighter grip section; anchor puts the muzzle-side
    // start 6px from the player center when rotated (matches old fillRect(6,…))
    for (const [name, len] of [['gun-rifle', GUN_LEN.rifle], ['gun-pistol', GUN_LEN.pistol], ['gun-sniper', GUN_LEN.sniper]] as [string, number][]) {
      cell(name, len, 5, -6 / len, 0.5, g => {
        g.fillStyle = '#1a1e24'; g.fillRect(0, 0, len, 5);
        g.fillStyle = '#2b323c'; g.fillRect(0, 0, 10, 5);
      });
    }

    // tracer strip: transparent at the shooter end, opaque at the impact end
    cell('tracer', TRACER_W, TRACER_H, 0, 0.5, g => {
      const grad = g.createLinearGradient(0, 0, TRACER_W, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = grad;
      g.fillRect(0, 0, TRACER_W, TRACER_H);
    });

    // muzzle flash: diamond + hot core (full color; alpha animated per sprite)
    cell('flash', 22, 14, 0, 0.5, g => {
      g.fillStyle = 'rgb(255,214,110)';
      g.beginPath();
      g.moveTo(0, 7); g.lineTo(14, 2); g.lineTo(20, 7); g.lineTo(14, 12);
      g.closePath(); g.fill();
      g.fillStyle = 'rgb(255,255,220)';
      g.beginPath(); g.arc(4, 7, 4, 0, 7); g.fill();
    });

    // threat chevron pointing +x, origin at (10,15) inside a 30x30 cell
    cell('chevron', 30, 30, 10 / 30, 0.5, g => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(10 + CHEVRON_S, 15);
      g.lineTo(10 - CHEVRON_S * 0.55, 15 - CHEVRON_S * 0.75);
      g.lineTo(10 - CHEVRON_S * 0.25, 15);
      g.lineTo(10 - CHEVRON_S * 0.55, 15 + CHEVRON_S * 0.75);
      g.closePath(); g.fill();
    });

    // corpse parts (white, tinted at runtime)
    cell('corpse-p-ell', 36, 26, 0.5, 0.5, g => {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(18, 13, 16, 11, 0, 0, 7); g.fill();
    });
    cell('corpse-x', 24, 24, 0.5, 0.5, g => {
      g.strokeStyle = '#fff'; g.lineWidth = 5;
      g.beginPath();
      g.moveTo(3, 3); g.lineTo(21, 21);
      g.moveTo(21, 3); g.lineTo(3, 21);
      g.stroke();
    });
    cell('corpse-z-ell', 32, 22, 0.5, 0.5, g => {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(16, 11, 14, 9, 0, 0, 7); g.fill();
    });
    cell('corpse-z-ell2', 24, 16, 0.5, 0.5, g => {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(12, 8, 10, 6, 0, 0, 7); g.fill();
    });

    // soft radial falloff for lights (phase 2)
    cell('radial', 128, 128, 0.5, 0.5, g => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    });

    // blood splat variants for decal stamping (phase 4) — deterministic blobs
    const SPLATS: number[][][] = [
      [[24, 24, 11], [34, 18, 5], [13, 30, 4], [30, 33, 3], [10, 16, 2.5]],
      [[24, 24, 9], [15, 15, 5.5], [35, 28, 4.5], [22, 37, 3], [37, 14, 2]],
      [[24, 24, 10], [12, 26, 4], [33, 12, 3.5], [36, 34, 4.5], [20, 10, 2.5]],
    ];
    SPLATS.forEach((blobs, i) => {
      cell(`splat-${i}`, 48, 48, 0.5, 0.5, g => {
        g.fillStyle = '#fff';
        for (const [bx, by, br] of blobs) {
          g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
        }
      });
    });

    this.atlasBase = Texture.from(c);
    for (const p of pending) {
      this.entries.set(p.key, {
        tex: new Texture({ source: this.atlasBase.source, frame: p.rect }),
        ax: p.ax, ay: p.ay,
      });
    }
  }

  // Real-art hook: if /assets/atlas.json (a Pixi spritesheet whose frame names
  // match the registry keys) exists, its textures replace the procedural bakes.
  // Contract: bodies/rings/corpse parts/splats are tinted at runtime, so paint
  // them white; anchors follow the registry (bodies centered, guns/tracer/flash
  // left-middle). No atlas shipped -> the procedural look stands.
  async tryLoadArtAtlas(): Promise<void> {
    try {
      const sheet = await loadArtSheet();
      if (!sheet) return;
      for (const [key, e] of this.entries) {
        const t = sheet.textures[key];
        if (t) e.tex = t;
      }
    } catch { /* no art shipped — procedural bake stands */ }
  }

  destroy(): void {
    // only destroy textures we baked; swapped-in spritesheet textures belong
    // to the Assets cache and survive for the next Renderer.create
    for (const e of this.entries.values()) {
      if (e.tex.source === this.atlasBase.source) e.tex.destroy();
    }
    this.entries.clear();
    this.atlasBase.destroy(true);
    this.map.destroy(true);
    this.mini.destroy(true);
  }
}
