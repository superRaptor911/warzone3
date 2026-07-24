import { Application, Rectangle } from 'pixi.js';
import { PLAYER_RADIUS } from '../../../shared/constants.ts';
import type { Grid } from '../../../shared/maps.ts';
import type { PlayerSnap, Vec2, ZombieSnap } from '../../../shared/types.ts';
import type { Fx } from '../fx.ts';
import { GfxTextures } from './textures.ts';
import { Scene } from './scene.ts';
import { FxSync } from './fxsync.ts';
import { Lights } from './lights.ts';
import { Decals } from './decals.ts';
import { UiLayer } from './ui.ts';

export interface DrawView {
  cam: Vec2;
  mouse: Vec2;
  myId: number;
  mode: string;
  now: number;
  me: { x: number; y: number; aim: number };
  players: PlayerSnap[];
  zombies: ZombieSnap[];
  fx: Fx;
  spread: number;
}

// One WebGL context for the life of the page (browsers cap ~16 contexts, and
// main.ts constructs a new Renderer on every `welcome` — reconnects included).
let app: Application | null = null;
let live: Renderer | null = null;

async function ensureApp(canvas: HTMLCanvasElement): Promise<Application> {
  if (app) return app;
  const a = new Application();
  await a.init({
    canvas, resizeTo: window, resolution: 1, autoDensity: false,
    antialias: true, background: '#07090d', autoStart: false,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  });
  a.ticker.stop(); // main.ts owns the single rAF loop; draw() renders manually
  a.stage.eventMode = 'none';
  addEventListener('resize', () => a.resize());
  app = a;
  return a;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  grid: Grid;
  private appRef: Application;
  private tx: GfxTextures;
  private scene: Scene;
  private fxs: FxSync;
  private lights: Lights;
  private decals: Decals;
  private ui: UiLayer;
  // filterArea is in the container's LOCAL space (world coords for emissive) —
  // draw() re-aims this rect at the visible world region each frame
  private emissiveArea = new Rectangle();

  // Async because Application.init is async; per-match scene on a page-lifetime app.
  static async create(canvas: HTMLCanvasElement, grid: Grid): Promise<Renderer> {
    const a = await ensureApp(canvas);
    if (live) live.dispose();
    const tx = new GfxTextures();
    tx.bake(grid);
    await tx.tryLoadArtAtlas(); // optional real-art spritesheet overrides bakes
    live = new Renderer(a, canvas, grid, tx);
    return live;
  }

  private constructor(a: Application, canvas: HTMLCanvasElement, grid: Grid, tx: GfxTextures) {
    this.appRef = a;
    this.canvas = canvas;
    this.grid = grid;
    this.tx = tx;
    this.scene = new Scene(a.stage, this.tx);
    // screen-sized filterArea: avoids per-frame bounds recompute on a sparse layer
    this.scene.layers.emissive.filterArea = this.emissiveArea;
    this.decals = new Decals(a, this.tx, this.scene.layers, grid);
    this.fxs = new FxSync(this.tx, this.scene.layers);
    this.lights = new Lights(a, this.tx, this.scene.layers, grid);
    this.ui = new UiLayer(this.tx, this.scene.layers, grid);
  }

  camera(me: Vec2, mouse: Vec2, shake: Vec2): Vec2 {
    const vw = this.canvas.width, vh = this.canvas.height;
    const g = this.grid;
    let cx = me.x + (mouse.x - vw / 2) * 0.1;
    let cy = me.y + (mouse.y - vh / 2) * 0.1;
    if (g.pxW() > vw) cx = Math.max(vw / 2, Math.min(g.pxW() - vw / 2, cx));
    else cx = g.pxW() / 2;
    if (g.pxH() > vh) cy = Math.max(vh / 2, Math.min(g.pxH() - vh / 2, cy));
    else cy = g.pxH() / 2;
    return { x: cx + shake.x, y: cy + shake.y };
  }

  gunTip(x: number, y: number, aim: number, r = PLAYER_RADIUS): Vec2 {
    return { x: x + Math.cos(aim) * (r + 10), y: y + Math.sin(aim) * (r + 10) };
  }

  stampBlood(x: number, y: number, big: boolean, zombie: boolean): void {
    this.decals.stampBlood(x, y, big, zombie);
  }

  resetDecals(): void {
    this.decals.reset();
  }

  draw(view: DrawView): void {
    const vw = this.canvas.width, vh = this.canvas.height;
    const ox = vw / 2 - view.cam.x, oy = vh / 2 - view.cam.y;
    const L = this.scene.layers;
    L.world.position.set(ox, oy);
    L.worldFx.position.set(ox, oy);
    // world-space rect of the visible screen (worldFx is offset by ox/oy)
    this.emissiveArea.x = -ox; this.emissiveArea.y = -oy;
    this.emissiveArea.width = vw; this.emissiveArea.height = vh;
    this.scene.syncZombies(view.zombies, view.now);
    this.scene.syncPlayers(view.players, view.myId, view.me, view.now);
    this.fxs.sync(view.fx);
    this.lights.update(view, vw, vh, ox, oy);
    this.ui.update(view, vw, vh);
    this.appRef.render();
  }

  private dispose(): void {
    this.scene.destroy();
    this.fxs.destroy();
    this.lights.destroy();
    this.decals.destroy();
    for (const c of this.appRef.stage.removeChildren()) c.destroy({ children: true });
    this.tx.destroy();
  }
}
