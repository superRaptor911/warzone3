import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { Grid } from '../../../shared/maps.ts';
import type { GfxTextures } from './textures.ts';
import type { Layers } from './scene.ts';
import type { DrawView } from './renderer.ts';
import { syncPool } from './fxsync.ts';

// 2D lightmap: an offstage scene (ambient fill + additive light sprites) is
// rendered into a screen-sized RenderTexture each frame, then composited over
// the world with multiply blending. Everything in `worldFx` and above (tracers,
// flashes, damage numbers, UI, minimap) sits above the composite and is never
// darkened.
//
// Gameplay-visibility rules:
// - TDM: NO line-of-sight masking, ambience only — anything else would change
//   the information available to players.
// - Zombie mode: darkness dims but never hides. Out-of-sight zombies stay
//   rendered at the ambient floor; chevrons and minimap are unaffected.
const AMBIENT_ZOMBIE = 0x2e3446;  // ~18% luminance floor — THE tuning knob
const AMBIENT_TDM = 0xd9dce3;     // barely below neutral, mood only
const N_RAYS = 128;
const VIS_REACH = 460;            // visibility polygon radius (px)
const WALL_SOAK = 30;             // extend rays so near wall faces catch light
const PLAYER_LIGHT_R = 420;       // own vision light radius
const TORCH_R = 140;              // squadmate glow radius

export class Lights {
  private appRef: Application;
  private grid: Grid;
  private tx: GfxTextures;
  private rt: RenderTexture;
  private root = new Container();        // offstage; rendered into rt
  private ambient: Sprite;
  private world = new Container();       // mirrors the main world transform
  private visPoly = new Graphics();
  private playerLight: Sprite;
  private torches: Sprite[] = [];
  private glows: Sprite[] = [];
  private out: Sprite;                   // on-stage multiply composite

  constructor(appRef: Application, tx: GfxTextures, layers: Layers, grid: Grid) {
    this.appRef = appRef;
    this.tx = tx;
    this.grid = grid;
    this.rt = RenderTexture.create({ width: 2, height: 2 });

    this.ambient = tx.sprite('white');
    this.ambient.anchor.set(0, 0);
    this.root.addChild(this.ambient, this.world);

    this.playerLight = this.lightSprite(PLAYER_LIGHT_R, 0xfff1dc, 0.95);
    this.playerLight.mask = this.visPoly;
    this.world.addChild(this.visPoly, this.playerLight);

    this.out = new Sprite(this.rt);
    this.out.blendMode = 'multiply';
    layers.lightSlot.addChild(this.out);
  }

  private lightSprite(radius: number, tint: number, alpha: number): Sprite {
    const s = this.tx.sprite('radial');
    s.scale.set((radius * 2) / 128);
    s.blendMode = 'add';
    s.tint = tint;
    s.alpha = alpha;
    return s;
  }

  // `worldX/worldY/zoom` mirror the main world transform exactly — the light
  // radii below stay in world px, so what a player can see is a function of the
  // world, never of their screen size or zoom.
  update(view: DrawView, vw: number, vh: number, worldX: number, worldY: number, zoom: number): void {
    if (this.rt.width !== vw || this.rt.height !== vh) this.rt.resize(vw, vh);
    const zombie = view.mode === 'zombie';
    this.ambient.tint = zombie ? AMBIENT_ZOMBIE : AMBIENT_TDM;
    this.ambient.scale.set(vw / 8, vh / 8);
    this.world.position.set(worldX, worldY);
    this.world.scale.set(zoom);

    // own vision: soft radial clipped by a wall-blocked visibility polygon
    this.playerLight.visible = zombie;
    this.visPoly.visible = zombie;
    if (zombie) {
      const { x, y } = view.me;
      const pts: number[] = [];
      for (let i = 0; i < N_RAYS; i++) {
        const a = (i / N_RAYS) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        const d = this.grid.raycast(x, y, dx, dy, VIS_REACH) + WALL_SOAK;
        pts.push(x + dx * d, y + dy * d);
      }
      this.visPoly.clear().poly(pts).fill(0xffffff);
      this.playerLight.position.set(x, y);
    }

    // squadmate torches (zombie mode only; smaller, unmasked)
    const mates = zombie
      ? view.players.filter(p => p.alive && p.id !== view.myId)
      : [];
    syncPool(mates, this.torches,
      () => this.world.addChild(this.lightSprite(TORCH_R, 0xffe9c4, 0.6)),
      (p, s) => s.position.set(p.x, p.y));

    // muzzle-flash light pulses (both modes — the "fire lights the room" beat)
    syncPool(view.fx.glows, this.glows,
      () => this.world.addChild(this.lightSprite(128, 0xffffff, 1)),
      (g, s) => {
        s.position.set(g.x, g.y);
        s.scale.set((g.radius * 2) / 128);
        s.tint = g.color;
        s.alpha = 0.75 * (g.life / g.ttl);
      });

    this.appRef.renderer.render({ container: this.root, target: this.rt, clear: true });
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.rt.destroy(true);
  }
}
