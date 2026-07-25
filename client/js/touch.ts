// On-screen touch controls: fixed 8-way dpad (left half), floating aim stick
// (right half), four action buttons.
//
// DOM + Pointer Events rather than canvas hit-testing: the HUD is DOM by
// convention and gfx/renderer.ts deliberately disables Pixi's whole event
// system. The maths lives in stick.ts so it can be tested under Node; this
// module is only plumbing between pointers and that maths.
//
// The overlay sits BELOW #hud in z-order. #hud is pointer-events:none apart
// from its interactive children, so taps fall through to the pads while the
// armory, the bot bar and the topbar still take their own taps.

import {
  DEAD_ZONE, STICK_R, deflection, newAimSmooth, newFireGate, releaseAim, stickKeys,
  tickAimSmooth, tickFireGate,
} from './stick.ts';
import type { MoveKeys } from '../../shared/types.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

type Zone = 'move' | 'aim';
interface Track { zone: Zone; ox: number; oy: number; x: number; y: number }

/** Menu setting: follow the device, or force the controls on/off. */
export type TouchMode = 'auto' | 'on' | 'off';

export function touchDefault(): boolean {
  return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

export class Touch {
  active = false;
  keys: MoveKeys = {};
  /**
   * Absolute aim angle. Screen and world axes align, so this is the world aim.
   * Eased toward `aimTarget` by tick() — the value the game should read.
   */
  aim = 0;
  /** The raw angle the thumb is pointing at, before easing. Exposed for tuning. */
  aimTarget = 0;
  /** 0..1 aim-stick deflection. Past DEAD_ZONE it steers the aim. */
  deflect = 0;
  /**
   * Whether the stick is pushed into the outer fire ring. Latched (see
   * tickFireGate), so it is not a plain comparison against `deflect` — read
   * this, never re-derive it, or the hysteresis is lost.
   */
  fire = false;
  sprint = false;
  /** A tap landed in the play area this frame (used to cycle spectate targets). */
  tapped = false;

  private pressed = new Set<string>();
  private tracks = new Map<number, Track>();
  private gate = newFireGate();
  private smooth = newAimSmooth();
  private root = $('touch');
  private dpad = $('dpad');
  private stick = $('astick');
  private knob = $('aknob');
  private sprintBtn = $('tb-sprint');
  private armoryBtn = $('tb-armory');
  private dirs: Record<string, HTMLElement>;

  constructor() {
    this.dirs = {
      w: this.dpad.querySelector('.dp-w') as HTMLElement,
      a: this.dpad.querySelector('.dp-a') as HTMLElement,
      s: this.dpad.querySelector('.dp-s') as HTMLElement,
      d: this.dpad.querySelector('.dp-d') as HTMLElement,
    };

    this.root.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.root.setPointerCapture(e.pointerId);
      const zone: Zone = e.clientX < innerWidth / 2 ? 'move' : 'aim';
      // The dpad is fixed: its centre is always the origin, so a thumb that
      // lands anywhere in the left half still produces a sensible direction.
      // The aim stick floats: it spawns under the thumb, every touch.
      let ox = e.clientX, oy = e.clientY;
      if (zone === 'move') {
        const r = this.dpad.getBoundingClientRect();
        ox = r.left + r.width / 2; oy = r.top + r.height / 2;
      } else {
        this.stick.style.left = `${ox}px`;
        this.stick.style.top = `${oy}px`;
        this.stick.classList.remove('hidden');
        // a fresh plant is intent, not jitter: the first angle it produces is
        // taken whole rather than eased into
        releaseAim(this.smooth);
      }
      this.tracks.set(e.pointerId, { zone, ox, oy, x: e.clientX, y: e.clientY });
      this.tapped = true;
      this.recompute();
    });

    const move = (e: PointerEvent): void => {
      const t = this.tracks.get(e.pointerId);
      if (!t) return;
      e.preventDefault();
      t.x = e.clientX; t.y = e.clientY;
      this.recompute();
    };
    this.root.addEventListener('pointermove', move);

    const end = (e: PointerEvent): void => {
      if (!this.tracks.delete(e.pointerId)) return;
      this.recompute();
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button[data-t]')) {
      const name = b.dataset.t!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // do not also start a pad drag
        b.classList.add('down');
        if (name === 'sprint') this.setSprint(!this.sprint);
        else this.pressed.add(name);
      });
      const up = (): void => b.classList.remove('down');
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    }
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('touch', on);
    if (!on) {
      this.tracks.clear();
      this.setSprint(false);
      this.recompute();
    }
  }

  /** ARMORY is zombie-mode only, matching the desktop B key. */
  showArmory(on: boolean): void {
    this.armoryBtn.classList.toggle('hidden', !on);
  }

  setSprint(on: boolean): void {
    this.sprint = on;
    this.sprintBtn.classList.toggle('on', on);
  }

  consume(name: string): boolean {
    if (!this.pressed.has(name)) return false;
    this.pressed.delete(name);
    return true;
  }

  /**
   * Per-frame aim easing. Must be called from the render loop before `aim` is
   * read — pointer events alone cannot drive it (a finger held still fires no
   * `pointermove`, which would freeze the aim short of where it was pointed).
   */
  tick(dt: number): void {
    this.aim = tickAimSmooth(this.smooth, this.aimTarget, this.deflect, dt);
  }

  endFrame(): void {
    this.pressed.clear();
    this.tapped = false;
  }

  private recompute(): void {
    let move: Track | null = null, aim: Track | null = null;
    for (const t of this.tracks.values()) {
      if (t.zone === 'move') move = t;
      else aim = t;
    }

    this.keys = move ? stickKeys(move.x - move.ox, move.y - move.oy) : {};
    for (const k of ['w', 'a', 's', 'd']) {
      this.dirs[k].classList.toggle('on', !!(this.keys as Record<string, unknown>)[k]);
    }

    if (aim) {
      const dx = aim.x - aim.ox, dy = aim.y - aim.oy;
      this.deflect = deflection(dx, dy);
      // hold the last angle when the thumb is inside the deadzone, exactly as a
      // mouse holds its angle when it stops moving
      if (this.deflect >= DEAD_ZONE) this.aimTarget = Math.atan2(dy, dx);
      const k = Math.min(1, this.deflect) * STICK_R;
      const len = Math.hypot(dx, dy) || 1;
      this.knob.style.transform = `translate(${(dx / len) * k}px, ${(dy / len) * k}px)`;
    } else {
      this.deflect = 0;
      this.stick.classList.add('hidden');
    }
    // The fire ring is invisible under the thumb, so the stick has to say which
    // of its two states it is in — otherwise "why am I not shooting" is a
    // mystery, and that is the whole risk of splitting the threshold.
    this.fire = tickFireGate(this.gate, this.deflect);
    this.stick.classList.toggle('hot', this.fire);
  }
}
