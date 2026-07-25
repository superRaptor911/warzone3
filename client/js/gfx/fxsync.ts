import { Container, Particle, ParticleContainer, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { Fx } from '../fx.ts';
import { GfxTextures, TRACER_H, TRACER_W } from './textures.ts';
import type { Layers } from './scene.ts';

// Mirrors the Fx data pools (which stay pure simulation) onto pooled display
// objects. Pools only grow; excess objects are hidden, never destroyed, so a
// steady state does zero allocation per frame.
export function syncPool<T, D extends { visible: boolean }>(
  items: T[], pool: D[], make: () => D, apply: (item: T, d: D) => void,
): void {
  while (pool.length < items.length) pool.push(make());
  for (let i = 0; i < pool.length; i++) {
    if (i < items.length) { pool[i].visible = true; apply(items[i], pool[i]); }
    else pool[i].visible = false;
  }
}

// Thousands-cheap pool over a ParticleContainer; hidden extras get alpha 0.
class ParticlePool<T> {
  private pc: ParticleContainer;
  private pool: Particle[] = [];
  private texture: Texture;
  private init: (p: Particle) => void;

  constructor(parent: Container, texture: Texture,
              dyn: { rotation?: boolean; scale?: boolean },
              init: (p: Particle) => void) {
    this.pc = new ParticleContainer({
      dynamicProperties: { position: true, color: true, rotation: !!dyn.rotation, scale: !!dyn.scale },
    });
    this.texture = texture;
    this.init = init;
    parent.addChild(this.pc);
  }

  sync(items: T[], apply: (item: T, p: Particle) => void): void {
    while (this.pool.length < items.length) {
      const p = new Particle({ texture: this.texture, anchorX: 0.5, anchorY: 0.5 });
      this.init(p);
      this.pool.push(p);
      this.pc.addParticle(p);
    }
    for (let i = 0; i < this.pool.length; i++) {
      if (i < items.length) apply(items[i], this.pool[i]);
      else this.pool[i].alpha = 0;
    }
  }
}

class CorpseVisual extends Container {
  pEll: Sprite;
  pX: Sprite;
  zEll1: Sprite;
  zEll2: Sprite;

  constructor(tx: GfxTextures) {
    super();
    this.pEll = tx.sprite('corpse-p-ell');
    this.pEll.tint = 0x78140c; this.pEll.alpha = 0.65;   // rgba(120,20,12,0.65)
    this.pX = tx.sprite('corpse-x');
    this.pX.tint = 0x20242b;
    this.zEll1 = tx.sprite('corpse-z-ell');
    this.zEll1.tint = 0x3d5c2b;
    this.zEll2 = tx.sprite('corpse-z-ell2');
    this.zEll2.tint = 0x5a140a; this.zEll2.alpha = 0.7;  // rgba(90,20,10,0.7)
    this.zEll2.position.set(6, 4);
    this.addChild(this.zEll1, this.zEll2, this.pEll, this.pX);
  }
}

export class FxSync {
  private tx: GfxTextures;
  private layers: Layers;
  private tracers: Sprite[] = [];
  private flashes: Sprite[] = [];
  private shells: ParticlePool<Fx['shells'][number]>;
  private sparks: ParticlePool<Fx['sparks'][number]>;
  private smoke: ParticlePool<Fx['smoke'][number]>;
  private corpses: CorpseVisual[] = [];
  private floats: Text[] = [];
  private textScale = 1;

  constructor(tx: GfxTextures, layers: Layers) {
    this.tx = tx;
    this.layers = layers;
    // shells live in `under` (floor litter beneath corpses/actors),
    // sparks/smoke in `fxTop` (above actors, below tracers)
    this.shells = new ParticlePool(layers.under, tx.entry('white').tex, { rotation: true }, (p) => {
      p.scaleX = 0.7; p.scaleY = 0.35;
      p.tint = 0xc9962e;
    });
    this.sparks = new ParticlePool(layers.fxTop, tx.entry('white').tex, { scale: true }, () => {});
    this.smoke = new ParticlePool(layers.fxTop, tx.entry('radial').tex, { scale: true }, (p) => {
      p.tint = 0x8a8f96;
    });
  }

  // Damage numbers live in the zoom-scaled worldFx layer; counter-scale them so
  // they stay 14px on screen however far the world is zoomed out.
  setTextScale(s: number): void {
    if (s === this.textScale) return;
    this.textScale = s;
    for (const t of this.floats) t.scale.set(s);
  }

  sync(fx: Fx): void {
    // skip the bloom filter pass entirely on idle frames
    this.layers.emissive.visible = fx.tracers.length + fx.flashes.length > 0;

    syncPool(fx.corpses, this.corpses,
      () => this.layers.under.addChild(new CorpseVisual(this.tx)),
      (c, d) => {
        d.position.set(c.x, c.y);
        d.alpha = Math.min(1, c.life / 2) * 0.8;
        const isZ = c.kind === 'zombie';
        d.zEll1.visible = d.zEll2.visible = isZ;
        d.pEll.visible = d.pX.visible = !isZ;
        if (isZ) { d.zEll1.rotation = c.rot; d.zEll2.rotation = c.rot + 1; }
        else d.pEll.rotation = c.rot;
      });

    syncPool(fx.tracers, this.tracers,
      () => {
        const s = this.layers.emissive.addChild(this.tx.sprite('tracer'));
        s.tint = 0xfff0b4; // rgba(255,240,180)
        return s;
      },
      (t, s) => {
        const dx = t.x1 - t.x0, dy = t.y1 - t.y0;
        s.position.set(t.x0, t.y0);
        s.rotation = Math.atan2(dy, dx);
        s.scale.set(Math.hypot(dx, dy) / TRACER_W, t.w / TRACER_H);
        s.alpha = 0.85 * (t.life / t.ttl);
      });

    syncPool(fx.flashes, this.flashes,
      () => this.layers.emissive.addChild(this.tx.sprite('flash')),
      (f, s) => {
        s.position.set(f.x, f.y);
        s.rotation = f.angle;
        s.alpha = f.life / f.ttl;
      });

    this.shells.sync(fx.shells, (sh, p) => {
      p.x = sh.x; p.y = sh.y;
      p.rotation = sh.rot;
      p.alpha = 0.9 * Math.min(1, sh.life / 2); // fade over the last 2s
    });

    this.sparks.sync(fx.sparks, (sp, p) => {
      p.x = sp.x; p.y = sp.y;
      p.scaleX = p.scaleY = sp.size / 8;
      p.tint = sp.color;
      p.alpha = Math.min(1, sp.life / 0.2);
    });

    this.smoke.sync(fx.smoke, (sm, p) => {
      p.x = sm.x; p.y = sm.y;
      p.scaleX = p.scaleY = sm.size / 64;
      p.alpha = 0.22 * (sm.life / sm.ttl);
    });

    syncPool(fx.floats, this.floats,
      () => {
        const t = new Text({
          text: '',
          style: { fontFamily: 'system-ui, sans-serif', fontSize: 14, fontWeight: 'bold', fill: '#ffffff' },
        });
        t.anchor.set(0.5, 1);
        t.scale.set(this.textScale);
        return this.layers.floats.addChild(t);
      },
      (f, t) => {
        if (t.text !== f.text) t.text = f.text;
        t.tint = f.color;
        t.position.set(f.x, f.y + 4);
        t.alpha = Math.min(1, f.life / 0.3);
      });
  }

  destroy(): void {
    for (const t of this.floats) t.destroy(true);
    this.floats.length = 0;
  }
}
