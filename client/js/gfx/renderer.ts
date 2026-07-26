import { Application, Rectangle } from 'pixi.js';
import type { Grid } from '../../../shared/maps.ts';
import type { WeaponId } from '../../../shared/weapons.ts';
import type { PlayerSnap, Vec2, ZombieSnap, PickupSnap } from '../../../shared/types.ts';
import { gunMuzzle } from './art.ts';
import type { Fx } from '../fx.ts';
import { zoomFor } from '../view.ts';
import { GfxTextures } from './textures.ts';
import { Scene } from './scene.ts';
import { FxSync } from './fxsync.ts';
import { Lights } from './lights.ts';
import { Decals } from './decals.ts';
import { UiLayer } from './ui.ts';

export interface DrawView {
  cam: Vec2;
  crosshair: Vec2;   // screen-space point the reticle sits on (cursor, or aim ray on touch)
  myId: number;
  mode: string;
  now: number;
  me: { x: number; y: number; aim: number };
  players: PlayerSnap[];
  zombies: ZombieSnap[];
  pickups: PickupSnap[]; // Outbreak supply crates (empty in TDM)
  fx: Fx;
  spread: number;
}

// Per-match render settings. Resolution and bloom are the quality tier;
// uiScale shrinks the canvas-drawn UI (minimap) in step with the DOM HUD.
export interface RenderOpts {
  resolution: number;
  bloom: boolean;
  uiScale: number;
}

// One WebGL context for the life of the page (browsers cap ~16 contexts, and
// main.ts constructs a new Renderer on every `welcome` — reconnects included).
let app: Application | null = null;
let live: Renderer | null = null;

async function ensureApp(canvas: HTMLCanvasElement, resolution: number): Promise<Application> {
  if (app) {
    // Quality tier changed between matches. The Renderer is rebuilt around this
    // call, so every RenderTexture (lightmap, decals) is recreated at the new
    // resolution anyway — only the canvas itself needs re-sizing here.
    if (app.renderer.resolution !== resolution) {
      app.renderer.resolution = resolution;
      app.resize();
    }
    return app;
  }
  const a = new Application();
  // autoDensity keeps canvas.style.* in CSS px while the backing store scales
  // with `resolution`, so all screen-space math below (and the stick/mouse ->
  // world math in main.ts) stays in CSS px regardless of tier.
  await a.init({
    canvas, resizeTo: window, resolution, autoDensity: true,
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
  static async create(canvas: HTMLCanvasElement, grid: Grid, opts: RenderOpts): Promise<Renderer> {
    const a = await ensureApp(canvas, opts.resolution);
    if (live) live.dispose();
    const tx = new GfxTextures();
    // Throws MissingArtError if the world tilesheet is unreachable — the world
    // art is required, not an optional override. main.ts surfaces it.
    await tx.bake(grid);
    await tx.tryLoadArtAtlas(); // optional real-art spritesheet overrides bakes
    live = new Renderer(a, canvas, grid, tx, opts);
    return live;
  }

  private constructor(
    a: Application, canvas: HTMLCanvasElement, grid: Grid, tx: GfxTextures, opts: RenderOpts,
  ) {
    this.appRef = a;
    this.canvas = canvas;
    this.grid = grid;
    this.tx = tx;
    this.scene = new Scene(a.stage, this.tx, opts.bloom, grid);
    // screen-sized filterArea: avoids per-frame bounds recompute on a sparse layer
    this.scene.layers.emissive.filterArea = this.emissiveArea;
    this.decals = new Decals(a, this.tx, this.scene.layers, grid);
    this.fxs = new FxSync(this.tx, this.scene.layers);
    this.lights = new Lights(a, this.tx, this.scene.layers, grid);
    this.ui = new UiLayer(this.tx, this.scene.layers, grid, opts.uiScale);
  }

  // Viewport in CSS px (not backing-store px — see autoDensity above).
  get screenW(): number { return this.appRef.screen.width; }
  get screenH(): number { return this.appRef.screen.height; }

  // World px per screen px. 1 on any viewport >= the VIEW_TARGET_* box, so
  // desktop keeps the original 1:1 mapping.
  get zoom(): number { return zoomFor(this.appRef.screen.width, this.appRef.screen.height); }

  // `lead` is a world-space offset (mouse pull on desktop, aim-stick pull on
  // touch). Clamping uses the *world* size of the viewport, which shrinks as
  // the zoom does — otherwise a zoomed-out client would see past the map edge.
  camera(me: Vec2, lead: Vec2, shake: Vec2): Vec2 {
    const z = this.zoom;
    const vw = this.screenW / z, vh = this.screenH / z;
    const g = this.grid;
    let cx = me.x + lead.x;
    let cy = me.y + lead.y;
    if (g.pxW() > vw) cx = Math.max(vw / 2, Math.min(g.pxW() - vw / 2, cx));
    else cx = g.pxW() / 2;
    if (g.pxH() > vh) cy = Math.max(vh / 2, Math.min(g.pxH() - vh / 2, cy));
    else cy = g.pxH() / 2;
    return { x: cx + shake.x, y: cy + shake.y };
  }

  // Muzzle position for flashes/tracers/flash light — per weapon, from the same
  // GUN_SPEC table the sprites bake from, so it always lands on the barrel end.
  // Cosmetic only: the server's hitscan origin is the player centre.
  gunTip(x: number, y: number, aim: number, w: WeaponId): Vec2 {
    const d = gunMuzzle(w);
    return { x: x + Math.cos(aim) * d, y: y + Math.sin(aim) * d };
  }

  stampBlood(x: number, y: number, big: boolean, zombie: boolean): void {
    this.decals.stampBlood(x, y, big, zombie);
  }

  resetDecals(): void {
    this.decals.reset();
  }

  draw(view: DrawView): void {
    const vw = this.screenW, vh = this.screenH;
    const z = this.zoom;
    // screen = world * z + (ox, oy)
    const ox = vw / 2 - view.cam.x * z, oy = vh / 2 - view.cam.y * z;
    const L = this.scene.layers;
    L.world.position.set(ox, oy);
    L.world.scale.set(z);
    L.worldFx.position.set(ox, oy);
    L.worldFx.scale.set(z);
    // world-space rect of the visible screen (emissive is inside the scaled worldFx)
    this.emissiveArea.x = -ox / z; this.emissiveArea.y = -oy / z;
    this.emissiveArea.width = vw / z; this.emissiveArea.height = vh / z;
    // text rides the world transform but must stay legible: counter-scale it so
    // names and damage numbers keep their designed pixel size at any zoom
    const textScale = 1 / z;
    this.scene.setTextScale(textScale);
    this.fxs.setTextScale(textScale);
    this.scene.syncZombies(view.zombies, view.now);
    this.scene.syncPickups(view.pickups, view.now);
    this.scene.syncPlayers(view.players, view.myId, view.me, view.now);
    this.fxs.sync(view.fx);
    this.lights.update(view, vw, vh, ox, oy, z);
    this.ui.update(view, vw, vh, z);
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
