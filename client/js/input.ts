// Keyboard + mouse state. Aim angle is computed in main from camera.
export class Input {
  keys: Record<string, boolean> = {};
  mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
  pressed = new Set<string>();   // edge-triggered keys, consumed per frame
  wheel = 0;
  clicked = false;               // edge-triggered left click, cleared per frame

  constructor(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      this.pressed.add(k);
      if (k === 'tab') e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    addEventListener('blur', () => { this.keys = {}; this.mouse.down = false; });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { this.mouse.down = true; this.clicked = true; } });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.down = false; });
    addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  moveKeys() {
    return {
      w: this.keys['w'] || this.keys['arrowup'] ? 1 : 0,
      a: this.keys['a'] || this.keys['arrowleft'] ? 1 : 0,
      s: this.keys['s'] || this.keys['arrowdown'] ? 1 : 0,
      d: this.keys['d'] || this.keys['arrowright'] ? 1 : 0,
    };
  }

  consume(key: string): boolean {
    if (this.pressed.has(key)) { this.pressed.delete(key); return true; }
    return false;
  }

  endFrame(): void { this.pressed.clear(); this.wheel = 0; this.clicked = false; }
}
