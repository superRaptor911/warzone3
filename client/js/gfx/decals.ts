import { Container, RenderTexture, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { Grid } from '../../../shared/maps.ts';
import type { GfxTextures } from './textures.ts';
import type { Layers } from './scene.ts';

// Persistent blood decals: stamps accumulate in a half-resolution map-sized
// RenderTexture (Outbreak: 1056x816) displayed by one sprite scaled 2x under
// the actors. Each stamp is a single tiny render pass; per-frame cost is zero.
// Reset on 'matchstart' (TDM restart / zombie squad-wipe), when the world resets.
export class Decals {
  private appRef: Application;
  private tx: GfxTextures;
  private rt: RenderTexture;
  private stampSprite: Sprite;
  private empty = new Container();

  constructor(appRef: Application, tx: GfxTextures, layers: Layers, grid: Grid) {
    this.appRef = appRef;
    this.tx = tx;
    this.rt = RenderTexture.create({
      width: Math.ceil(grid.pxW() / 2),
      height: Math.ceil(grid.pxH() / 2),
    });
    const out = new Sprite(this.rt);
    out.scale.set(2);
    layers.ground.addChild(out); // above the map sprite, below corpses/actors
    this.stampSprite = tx.sprite('splat-0');
  }

  stampBlood(x: number, y: number, big: boolean, zombie: boolean): void {
    const s = this.stampSprite;
    s.texture = this.tx.entry(`splat-${(Math.random() * 3) | 0}`).tex;
    s.tint = zombie ? 0x3d5c2b : 0x6e1410;
    s.position.set(x / 2, y / 2);
    s.rotation = Math.random() * Math.PI * 2;
    s.scale.set((big ? 1.1 : 0.6) * (0.75 + Math.random() * 0.5) * 0.5);
    s.alpha = 0.5;
    this.appRef.renderer.render({ container: s, target: this.rt, clear: false });
  }

  reset(): void {
    this.appRef.renderer.render({ container: this.empty, target: this.rt, clear: true });
  }

  destroy(): void {
    this.stampSprite.destroy();
    this.rt.destroy(true);
  }
}
