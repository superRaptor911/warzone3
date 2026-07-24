import { Graphics, Sprite } from 'pixi.js';
import type { Grid } from '../../../shared/maps.ts';
import { TEAM } from '../../../shared/constants.ts';
import { CHEVRON_S, DISC_R, GfxTextures, TEAM_COLORS } from './textures.ts';
import type { Layers } from './scene.ts';
import type { DrawView } from './renderer.ts';

// Screen-space UI drawn on the canvas: crosshair, off-screen threat chevrons
// (zombie mode), minimap. All pooled sprites; logic ported from the old
// Canvas2D renderer unchanged.
export class UiLayer {
  private grid: Grid;
  private arms: Sprite[] = [];
  private dot: Sprite;
  private chevrons: Sprite[] = [];
  private mini: Sprite;
  private blips: Sprite[] = [];
  private layers: Layers;
  private tx: GfxTextures;

  constructor(tx: GfxTextures, layers: Layers, grid: Grid) {
    this.tx = tx;
    this.layers = layers;
    this.grid = grid;
    for (let i = 0; i < 4; i++) {
      const s = tx.sprite('white');
      s.anchor.set(0, 0.5);
      s.scale.set(7 / 8, 2 / 8);
      s.tint = 0xf0f5fa; s.alpha = 0.9;
      this.arms.push(layers.screenUi.addChild(s));
    }
    this.dot = tx.sprite('white');
    this.dot.scale.set(2 / 8);
    this.dot.tint = 0xf0f5fa; this.dot.alpha = 0.9;
    layers.screenUi.addChild(this.dot);

    this.mini = new Sprite(tx.mini);
    this.mini.alpha = 0.92;
    const border = new Graphics()
      .rect(-0.5, -0.5, tx.mini.width + 1, tx.mini.height + 1)
      .stroke({ width: 1, color: 0x2b3648 });
    layers.minimap.position.set(16, 16);
    layers.minimap.addChild(this.mini, border);
  }

  update(view: DrawView, vw: number, vh: number): void {
    this.crosshair(view);
    this.threatChevrons(view, vw, vh);
    this.minimap(view);
  }

  private crosshair(view: DrawView): void {
    const { mouse, spread } = view;
    const gap = 6 + Math.tan(Math.min(0.5, spread)) * 320;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = dirs[i];
      const s = this.arms[i];
      s.position.set(mouse.x + dx * gap, mouse.y + dy * gap);
      s.rotation = Math.atan2(dy, dx);
    }
    this.dot.position.set(mouse.x, mouse.y);
  }

  // Edge chevrons for zombies just outside the viewport (zombie mode only —
  // in TDM this would leak enemy positions). Intensity scales with how close
  // the zombie is to entering the screen, capped to the nearest few so a
  // frenzy horde doesn't ring the whole border.
  private threatChevrons(view: DrawView, vw: number, vh: number): void {
    let used = 0;
    const meSnap = view.players.find(p => p.id === view.myId);
    if (view.mode === 'zombie' && meSnap && meSnap.alive) {
      const camL = view.cam.x - vw / 2, camT = view.cam.y - vh / 2;
      const REACH = 500, MAX_SHOWN = 4, MARGIN = 26;
      const threats: { sx: number; sy: number; beyond: number }[] = [];
      for (const z of view.zombies) {
        const sx = z.x - camL, sy = z.y - camT;
        const bx = sx < 0 ? -sx : sx > vw ? sx - vw : 0;
        const by = sy < 0 ? -sy : sy > vh ? sy - vh : 0;
        const beyond = Math.hypot(bx, by);
        if (beyond <= 0 || beyond > REACH) continue;
        threats.push({ sx, sy, beyond });
      }
      threats.sort((a, b) => a.beyond - b.beyond);
      const px = view.me.x - camL, py = view.me.y - camT;
      for (const t of threats.slice(0, MAX_SHOWN)) {
        const a = Math.atan2(t.sy - py, t.sx - px);
        const dx = Math.cos(a), dy = Math.sin(a);
        let dist = Infinity;
        if (dx > 0) dist = Math.min(dist, (vw - MARGIN - px) / dx);
        if (dx < 0) dist = Math.min(dist, (MARGIN - px) / dx);
        if (dy > 0) dist = Math.min(dist, (vh - MARGIN - py) / dy);
        if (dy < 0) dist = Math.min(dist, (MARGIN - py) / dy);
        if (!isFinite(dist) || dist < 0) continue;
        const k = 1 - t.beyond / REACH; // 1 = about to enter the screen
        let s = this.chevrons[used];
        if (!s) {
          s = this.tx.sprite('chevron');
          s.tint = 0xff4030;
          this.chevrons.push(this.layers.screenUi.addChild(s));
        }
        s.visible = true;
        s.position.set(px + dx * dist, py + dy * dist);
        s.rotation = a;
        s.alpha = 0.3 + 0.65 * k;
        s.scale.set((9 + 9 * k) / CHEVRON_S);
        used++;
      }
    }
    for (let i = used; i < this.chevrons.length; i++) this.chevrons[i].visible = false;
  }

  private minimap(view: DrawView): void {
    const scale = this.mini.width / this.grid.pxW();
    let used = 0;
    const blip = (wx: number, wy: number, color: string, r: number): void => {
      let s = this.blips[used];
      if (!s) {
        s = this.tx.sprite('disc');
        this.blips.push(this.layers.minimap.addChild(s));
      }
      s.visible = true;
      s.position.set(wx * scale, wy * scale);
      s.scale.set(r / DISC_R);
      s.tint = color;
      used++;
    };
    for (const z of view.zombies) blip(z.x, z.y, '#e8483f', 2);
    for (const p of view.players) {
      if (!p.alive) continue;
      if (p.id === view.myId) blip(view.me.x, view.me.y, '#ffffff', 3.5);
      else {
        const col = TEAM_COLORS[p.team] || TEAM_COLORS[TEAM.SURVIVOR];
        blip(p.x, p.y, col.name, 2.5);
      }
    }
    for (let i = used; i < this.blips.length; i++) this.blips[i].visible = false;
  }
}
