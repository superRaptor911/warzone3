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
  private lootBlips: Sprite[] = [];
  private layers: Layers;
  private tx: GfxTextures;

  constructor(tx: GfxTextures, layers: Layers, grid: Grid, uiScale: number) {
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
    // the whole minimap group scales with the HUD so it stays ~the same
    // fraction of a small screen as it is of a desktop one
    layers.minimap.position.set(16, 16);
    layers.minimap.scale.set(uiScale);
    layers.minimap.addChild(this.mini, border);
  }

  update(view: DrawView, vw: number, vh: number, zoom: number): void {
    this.crosshair(view, zoom);
    this.threatChevrons(view, vw, vh, zoom);
    this.minimap(view);
  }

  private crosshair(view: DrawView, zoom: number): void {
    const { crosshair, spread } = view;
    // 320 is a nominal world distance; project it so the gap keeps showing the
    // true size of the cone on screen at any zoom
    const gap = 6 + Math.tan(Math.min(0.5, spread)) * 320 * zoom;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = dirs[i];
      const s = this.arms[i];
      s.position.set(crosshair.x + dx * gap, crosshair.y + dy * gap);
      s.rotation = Math.atan2(dy, dx);
    }
    this.dot.position.set(crosshair.x, crosshair.y);
  }

  // Edge chevrons for zombies just outside the viewport (zombie mode only —
  // in TDM this would leak enemy positions). Intensity scales with how close
  // the zombie is to entering the screen, capped to the nearest few so a
  // frenzy horde doesn't ring the whole border.
  private threatChevrons(view: DrawView, vw: number, vh: number, zoom: number): void {
    let used = 0;
    const meSnap = view.players.find(p => p.id === view.myId);
    if (view.mode === 'zombie' && meSnap && meSnap.alive) {
      // world -> screen projection for this frame
      const ox = vw / 2 - view.cam.x * zoom, oy = vh / 2 - view.cam.y * zoom;
      const REACH = 500, MAX_SHOWN = 4, MARGIN = 26;
      // How far off-screen a zombie is, measured in WORLD px: a zoomed-out
      // client is warned about exactly the zombies a desktop client is, no more.
      const halfW = vw / (2 * zoom), halfH = vh / (2 * zoom);
      const threats: { sx: number; sy: number; beyond: number }[] = [];
      for (const zb of view.zombies) {
        const dx = Math.abs(zb.x - view.cam.x), dy = Math.abs(zb.y - view.cam.y);
        const bx = dx > halfW ? dx - halfW : 0;
        const by = dy > halfH ? dy - halfH : 0;
        const beyond = Math.hypot(bx, by);
        if (beyond <= 0 || beyond > REACH) continue;
        threats.push({ sx: zb.x * zoom + ox, sy: zb.y * zoom + oy, beyond });
      }
      threats.sort((a, b) => a.beyond - b.beyond);
      const px = view.me.x * zoom + ox, py = view.me.y * zoom + oy;
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

    // Supply crates are marked because they are rare, persistent and easy to
    // walk past in the dark; the minimap already shows every live zombie with
    // no LOS gating, so this gives away strictly less than it already does.
    // Drawn as SQUARES, not discs: in Outbreak every survivor is a green dot
    // and TEAM_COLORS[SURVIVOR].name is the same green a medkit wants, so
    // colour alone could not say "object, not person".
    let loot = 0;
    for (const c of view.pickups) {
      let s = this.lootBlips[loot];
      if (!s) {
        s = this.tx.sprite('white');
        s.anchor.set(0.5, 0.5);
        s.scale.set(5 / 8);
        this.lootBlips.push(this.layers.minimap.addChild(s));
      }
      s.visible = true;
      s.position.set(c.x * scale, c.y * scale);
      s.tint = c.kind === 'ammo' ? '#8fd6ff' : '#9fe870';
      loot++;
    }
    for (let i = loot; i < this.lootBlips.length; i++) this.lootBlips[i].visible = false;
  }
}
