// Drives the real client in headless Chrome over the DevTools protocol.
//
// The touch layer cannot be covered by the other tests: matchflow.ts exercises
// the pure maths in client/js/stick.ts, but nothing there proves that a finger
// on the glass moves the player or that a held stick keeps a semi-auto firing.
// This boots a real server, emulates a phone, dispatches real touch points and
// reads the resulting DOM.
//
// Optional: skips (exit 0) when no Chrome binary is present, so it is safe to
// chain after the other tests. Run with `npm run test:touch`.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME_CANDIDATES = [
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome(): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const d of dirs) {
      if (d && fs.existsSync(path.join(d, c))) return c;
    }
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}

interface CdpEvent { id?: number; method?: string; params?: Record<string, unknown> }

// Minimal CDP client: launches the browser, attaches to its page target and
// exposes send/evaluate plus a log of anything the page threw.
class Page {
  readonly errors: string[] = [];
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private proc!: ChildProcess;

  static async launch(chrome: string, port: number, profile: string): Promise<Page> {
    const p = new Page();
    p.proc = spawn(chrome, [
      '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    interface Target { type: string; webSocketDebuggerUrl: string }
    let target: Target | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Target[];
        target = list.find(t => t.type === 'page');
        if (target) break;
      } catch { /* not up yet */ }
    }
    if (!target) { p.close(); throw new Error('chrome never exposed a page target'); }

    p.ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { p.ws.once('open', () => res()); p.ws.once('error', rej); });
    p.ws.on('message', (raw: Buffer) => p.onMessage(JSON.parse(raw.toString()) as CdpEvent));
    await p.send('Runtime.enable');
    await p.send('Page.enable');
    return p;
  }

  private onMessage(m: CdpEvent): void {
    if (m.id && this.pending.has(m.id)) {
      this.pending.get(m.id)!(m as Record<string, unknown>);
      this.pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params as { exceptionDetails: { exception?: { description?: string }; text: string } }).exceptionDetails;
      this.errors.push(d.exception?.description || d.text);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Polls a truthy expression. Headless frame rates vary wildly with load, so
   *  nothing here waits a fixed number of seconds for a state change. */
  async waitFor(expression: string, timeoutMs = 20000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.evaluate<boolean>(expression)) return true;
      await sleep(200);
    }
    return false;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const result = (r.result as { result?: { value?: T } } | undefined)?.result;
    return result?.value as T;
  }

  /** A one-finger gesture: down, optional drags, up. */
  async touch(pts: { x: number; y: number }[]): Promise<void> {
    for (let i = 0; i < pts.length; i++) {
      await this.send('Input.dispatchTouchEvent', {
        type: i === 0 ? 'touchStart' : 'touchMove',
        touchPoints: [{ x: pts[i].x, y: pts[i].y, id: 1 }],
      });
      await sleep(90);
    }
  }

  async release(): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(90);
  }

  async viewport(width: number, height: number, mobile: boolean): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
    });
  }

  /** Mean luminance of the rendered frame, 0-255. Screenshot out, decode back
   *  in: the canvas is WebGL without preserveDrawingBuffer, so nothing outside
   *  the render loop can read its pixels, but a JPEG can be handed to the page
   *  and measured there. Used to compare what two matches actually look like. */
  async luma(): Promise<number> {
    const shot = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    const data = (shot.result as { data: string }).data;
    return this.evaluate<number>(`(async () => {
      const blob = await (await fetch('data:image/jpeg;base64,${data}')).blob();
      const img = await createImageBitmap(blob);
      const cv = new OffscreenCanvas(img.width, img.height);
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      return sum / (px.length / 4);
    })()`);
  }

  close(): void {
    try { this.ws?.close(); } catch { /* already gone */ }
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- run

const chrome = findChrome();
if (!chrome) {
  console.log('touchdrive: no Chrome binary found — skipping browser tests');
  process.exit(0);
}

const PORT = 3214;
const server = spawn('node', [path.join(import.meta.dirname, '..', 'server', 'index.ts')], {
  // In-memory profiles, and not merely to avoid littering: callsigns are claimed
  // permanently, so against a real database the second run of this suite would
  // find 'TOUCH' already owned, the menu would refuse to deploy, and every check
  // after the first navigation would hang waiting for a match that never starts.
  env: { ...process.env, PORT: String(PORT), WZ3_DB: ':memory:' },
  stdio: 'ignore',
});
await sleep(1500);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wz3-chrome-'));
const page = await Page.launch(chrome, 9333, profile);

function done(): never {
  page.close();
  server.kill();
  // best-effort: chrome is still flushing its profile as we exit
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* leave it to the OS */ }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- phone: 844x390 landscape ----
console.log('touch client (844x390)');
// Runs on EVERY navigation, so the profile token has to survive it: callsigns
// are claimed permanently, and a reload that arrives as a brand-new device
// holding a name it already owns is refused in the menu — which would hang every
// check after the rejoin pass renavigates.
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{
    const id = localStorage.getItem('wz3-id');
    localStorage.clear();
    if (id) localStorage.setItem('wz3-id', id);
    localStorage.setItem('wz3-name','TOUCH');
  }catch(e){}`,
});
// The pads come up because the emulated device asks for them, and there is no
// longer any way to ask on its behalf — the AUTO/ON/OFF menu row is gone, so
// nothing here can force the touch branch. Measured: mobile metrics plus touch
// emulation report `(pointer: coarse)` with maxTouchPoints 5, which is exactly
// what touchDefault() tests, and the desktop pass below reports neither.
await page.viewport(844, 390, true);
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
// The boot probe must be something main.ts *writes*, not markup index.html
// already ships, or it passes on a page whose module never ran. `.sel` on the
// bots row is applied at module scope from the stored preset.
check(await page.waitFor(`!!document.querySelector('#bots-opts button.sel')`), 'client module booted');

// ---- art invariants that only pixels can prove ----
//
// Both of these are properties of what gets DRAWN, so no amount of type checking
// or Node-side testing reaches them; a real Canvas2D is the only instrument. They
// live here rather than in matchflow.ts for the same reason the brightness
// measurements do — this is the file that has a browser.
console.log('art invariants (measured on a real canvas)');
{
  // 1. Every wall composite must cover its whole cell.
  //
  // Load-bearing, not cosmetic: scene.ts skips the floor sprite underneath a
  // wall tile precisely because the wall is opaque. A composite with a gap would
  // show the page background through the middle of a building, and would do it
  // only on whichever neighbour mask was broken.
  const walls = await page.evaluate<{ worst: number; where: string }>(`(async () => {
    const ts = await import('/client/js/gfx/tileset.ts');
    const img = new Image();
    img.src = ts.SHEET_URL;
    await img.decode();
    const cv = new OffscreenCanvas(ts.CELL, ts.CELL);
    const g = cv.getContext('2d');
    let worst = 0, where = '';
    for (const key of Object.keys(ts.WALL_ART)) {
      for (let mask = 0; mask < ts.MASKS; mask++) {
        g.clearRect(0, 0, ts.CELL, ts.CELL);
        ts.drawWall(g, img, Number(key), mask);
        const d = g.getImageData(0, 0, ts.CELL, ts.CELL).data;
        let holes = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 255) holes++;
        if (holes > worst) { worst = holes; where = 'mat ' + key + ' mask ' + mask; }
      }
    }
    return { worst, where };
  })()`);
  check(walls.worst === 0,
    `every wall composite fills its cell (worst: ${walls.worst}px${walls.where ? ' at ' + walls.where : ''})`);

  // 1b. Every solid prop must nearly fill its cell too — the same honesty rule,
  // relaxed by the amount a piece of furniture legitimately is.
  //
  // A prop makes its whole 48px tile impassable, so what matters is the extent of
  // its art, not how much of that extent is painted (a sofa is a U and a round
  // table is a circle; both are honest, a bare chair is not). So the bound is on
  // the alpha bounding box, and 0.79 is where the measurements put it: the green
  // sofa's middle piece spans 0.797 of its cell, the armchair 0.812, and the plain
  // crate — phase 1's art — only 0.844, so the bar cannot go higher than that
  // without rejecting the box this whole vocabulary grew out of. What the bound
  // stops is a future author reaching for one of the pack's bare chairs or stools
  // (all under half a cell) and shipping a hitbox with nothing visible in it.
  //
  // Worth knowing where the slack sits on the worst case: the sofa's missing band
  // is its north face, and every piece with a facing is authored against a north
  // wall, so the 7 world px it does not cover are between the sofa and a wall
  // tile that is solid anyway.
  const props = await page.evaluate<{ worst: number; where: string }>(`(async () => {
    const ts = await import('/client/js/gfx/tileset.ts');
    const img = new Image();
    img.src = ts.SHEET_URL;
    await img.decode();
    const cv = new OffscreenCanvas(ts.CELL, ts.CELL);
    const g = cv.getContext('2d');
    let worst = 1, where = '';
    for (const key of Object.keys(ts.PROP_ART)) {
      g.clearRect(0, 0, ts.CELL, ts.CELL);
      ts.drawProp(g, img, Number(key));
      const d = g.getImageData(0, 0, ts.CELL, ts.CELL).data;
      let x0 = ts.CELL, y0 = ts.CELL, x1 = -1, y1 = -1;
      for (let y = 0; y < ts.CELL; y++) {
        for (let x = 0; x < ts.CELL; x++) {
          if (d[(y * ts.CELL + x) * 4 + 3] <= 24) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      const frac = Math.min((x1 - x0 + 1) / ts.CELL, (y1 - y0 + 1) / ts.CELL);
      if (frac < worst) { worst = frac; where = 'mat ' + key; }
    }
    return { worst, where };
  })()`);
  check(props.worst >= 0.79,
    `every prop's art spans its solid tile (worst: ${props.worst.toFixed(3)} of the cell`
    + `${props.where ? ' at ' + props.where : ''})`);

  // 2. No body silhouette may reach past its collision radius.
  //
  // The sprite outline IS the hitbox and the rings mark it, so a body that
  // overhangs promises reach the server will not honour. CLAUDE.md notes nothing
  // type-checks this and asks for a re-measure after touching art.ts — which the
  // keyline pass did, since it inflates every primitive. Measured for the idle
  // frame and all four walk frames, because the binding cases are the soldier's
  // trailing boot at full stride and the walker's reaching claw.
  const bodies = await page.evaluate<Record<string, number>>(`(async () => {
    const art = await import('/client/js/gfx/art.ts');
    const C = await import('/shared/constants.ts');
    const radii = { player: C.PLAYER_RADIUS, walker: C.ZOMBIE_RADII.walker,
                    runner: C.ZOMBIE_RADII.runner, brute: C.ZOMBIE_RADII.brute };
    const out = {};
    for (const kind of art.BODY_KINDS) {
      const R = radii[kind] * art.BODY_SS;
      const size = Math.ceil(2 * R) + 2;
      const cv = new OffscreenCanvas(size, size);
      const g = cv.getContext('2d');
      let peak = 0;
      const frames = ['idle'];
      for (let f = 0; f < art.WALK_FRAMES; f++) frames.push(f);
      for (const f of frames) {
        g.clearRect(0, 0, size, size);
        g.save();
        g.translate(size / 2, size / 2);
        art.drawBody(g, kind, R, f === 'idle' ? null : f / art.WALK_FRAMES);
        g.restore();
        const d = g.getImageData(0, 0, size, size).data;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (d[(y * size + x) * 4 + 3] <= 8) continue;
            // pixel centre relative to the sprite centre
            const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2;
            const r = Math.hypot(dx, dy);
            if (r > peak) peak = r;
          }
        }
      }
      out[kind] = peak / R;
    }
    return out;
  })()`);
  for (const [kind, ratio] of Object.entries(bodies)) {
    check(ratio <= 1,
      `${kind} silhouette stays inside its collision radius (peak ${ratio.toFixed(3)} of R)`);
  }
}

check(await page.evaluate(`document.body.classList.contains('touch')`),
  'the emulated phone gets the pads with nobody having to ask for them');
check(await page.evaluate(`getComputedStyle(document.getElementById('touch')).display === 'none'`),
  'pads stay hidden behind the menu');

await page.evaluate(`document.querySelector('.mode-card[data-mode="zombie"]').click()`);
check(await page.waitFor(`document.getElementById('menu').classList.contains('hidden')
  && document.getElementById('mag').textContent !== ''`), 'joined an OUTBREAK room and the HUD is live');
check(await page.evaluate(`getComputedStyle(document.getElementById('touch')).display !== 'none'`), 'pads shown in match');
check(await page.evaluate(`getComputedStyle(document.getElementById('tb-armory')).display !== 'none'`),
  'ARMORY button present in zombie mode');

// dpad: the fixed pad reads direction from its own centre, so a thumb anywhere
// in the left half still steers
const dp = await page.evaluate<[number, number]>(
  `(()=>{const r=document.getElementById('dpad').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
await page.touch([{ x: dp[0], y: dp[1] - 60 }]);
check(await page.evaluate(`document.querySelector('.dp-w').classList.contains('on')`), 'touch above centre reads as up');
await page.touch([{ x: dp[0], y: dp[1] - 60 }, { x: dp[0] + 60, y: dp[1] + 60 }]);
check(await page.evaluate(`document.querySelector('.dp-s').classList.contains('on')
  && document.querySelector('.dp-d').classList.contains('on')
  && !document.querySelector('.dp-w').classList.contains('on')`), 'dragging gives the S+D diagonal');

await page.release();

// aim stick: floats to the thumb, and holding it keeps a SEMI-AUTO firing.
// The zombie starting pistol is semi-auto (server-side firePrev edge
// detection), so a naively held flag would fire exactly one round.
await page.touch([{ x: 640, y: 250 }]);
check(await page.evaluate(`!document.getElementById('astick').classList.contains('hidden')`), 'aim stick spawns under the thumb');
const at = await page.evaluate<string[]>(`[document.getElementById('astick').style.left, document.getElementById('astick').style.top]`);
check(at[0] === '640px' && at[1] === '250px', `aim stick centres on the touch point (${at.join(', ')})`);

// Auto-fire. There is no fire button on a phone: the gun goes off exactly when
// the crosshair is on a body, so what a real client has to prove is both halves
// of that — pointing at nothing cannot pull the trigger, and pointing at
// something does. The first half is what makes an invisible trigger safe.
const ring = (n: number, r: number) => Array.from({ length: n }, (_, i) => ({
  x: 640 + Math.cos((i / n) * Math.PI * 2) * r,
  y: 250 + Math.sin((i / n) * Math.PI * 2) * r,
}));
const magOf = async (): Promise<number> =>
  Number(await page.evaluate<string>(`document.getElementById('mag').textContent`));

// A fresh room opens on a 10s wave break with no zombies alive — the one moment
// the map is provably empty.
check(await page.evaluate(`/next wave/.test(document.getElementById('topbar').textContent || '')`),
  'still in the pre-wave break, so there is nothing alive to shoot at');
const magA = await magOf();
await page.touch([{ x: 640, y: 250 }, ...ring(8, 70)]); // full deflection, all the way round
const hotEmpty = await page.evaluate<boolean>(`document.getElementById('astick').classList.contains('hot')`);
const magB = await magOf();
check(magB === magA, `a full-deflection sweep with nothing alive spends no ammo (mag ${magA} -> ${magB})`);
check(!hotEmpty, 'and the stick never reads as firing');
await page.release();

// sprint toggle: arms on tap, survives standing still, leaks no stamina
const sp = await page.evaluate<[number, number]>(
  `(()=>{const r=document.getElementById('tb-sprint').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
await page.touch([{ x: sp[0], y: sp[1] }]);
check(await page.evaluate(`document.getElementById('tb-sprint').classList.contains('on')`), 'SPRINT arms on tap');
await page.release();
await sleep(1500);
check(await page.evaluate(`document.getElementById('tb-sprint').classList.contains('on')`),
  'SPRINT survives standing still, so a pre-emptive tap works');
const stam = await page.evaluate<string>(`document.getElementById('stambar').style.width`);
check(stam === '100%', `armed-but-stationary leaks no stamina (bar ${stam})`);

// tap the score bar in place of holding Tab
const tb = await page.evaluate<[number, number]>(
  `(()=>{const r=document.getElementById('topbar').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
await page.touch([{ x: tb[0], y: tb[1] }]);
await page.release();
await sleep(300);
check(await page.evaluate(`!document.getElementById('scoreboard').classList.contains('hidden')`),
  'tapping the score bar opens the scoreboard');

// orientation gate
check(await page.evaluate(`getComputedStyle(document.getElementById('rotate')).display === 'none'`),
  'landscape has no rotate gate');
await page.viewport(390, 844, true);
await sleep(500);
check(await page.evaluate(`getComputedStyle(document.getElementById('rotate')).display === 'flex'`),
  'portrait shows the rotate gate');
await page.viewport(844, 390, true);
await sleep(400);
check(await page.evaluate(`getComputedStyle(document.getElementById('rotate')).display === 'none'`),
  'rotating back clears it');

// ---- auto-fire, live: sweep until rounds actually leave the barrel ----
// Runs last in this section on purpose: it stands still in the middle of a
// wave for as long as it takes to make contact, which can leave the player
// downed. Anything asserted after it would be reading a corpse's HUD.
//
// Rounds are counted cumulatively rather than as a single drop, because that
// doubles as the semi-auto cadence assertion — the pistol is semi-auto and the
// server edge-detects fire, so a naively held flag would spend exactly one.
check(await page.waitFor(`/remaining/.test(document.getElementById('topbar').textContent || '')`, 20000),
  'wave started, so there are zombies to auto-fire at');
// Latch the ring in the page rather than sampling it per revolution: firing
// is intermittent (the crosshair crosses a body and leaves it), so a single
// evaluate per sweep almost always lands in a gap.
await page.evaluate(`window.__hot = false; (function poll(){
  if (document.getElementById('astick').classList.contains('hot')) window.__hot = true;
  requestAnimationFrame(poll);
})()`);
// Two rounds, not one: a raw held flag would spend exactly one, so the second
// is the cadence working. Not more than two, because the budget is spent
// waiting for zombies to walk to us and a downed player waits for the wave to
// clear before being revived — this must not become a coin flip.
let spent = 0;
let prev = await magOf();
const budget = Date.now() + 150000;
while (spent < 2 && Date.now() < budget) {
  await page.touch([{ x: 640, y: 250 }, ...ring(12, 70)]);
  const m = await magOf();
  if (m < prev) spent += prev - m; // a rise is the auto-reload, not a shot
  prev = m;
}
const alive = !(await page.evaluate<boolean>(
  `/DOWN|OVERRUN/.test(document.getElementById('center-msg').textContent || '')`));
check(spent >= 2,
  `sweeping onto a zombie fires, and keeps firing (${spent} rounds${alive ? '' : ', player was DOWN'})`);
check(await page.evaluate<boolean>(`window.__hot === true`),
  'the stick ring lights while the gun is going off');
await page.release();
// Settle first. At the moment of release there is reliably one more pulsed
// fire input already in flight, so the mag drops once more after the thumb is
// up. A 700ms window still catches fire that genuinely continues — that would
// spend several rounds, not one.
await sleep(250);
const mag2 = await magOf();
await sleep(700);
const mag3 = await magOf();
check(mag3 === mag2, `lifting the thumb is the ceasefire (${mag2} -> ${mag3})`);
check(await page.evaluate(`document.getElementById('astick').classList.contains('hidden')`), 'aim stick hides on release');

// ---- match lifecycle: a rotate mid-boot, then quit and rejoin ----
// Two renderer-teardown bugs lived here, and neither one touched the DOM:
//  - the lightmap RenderTexture was resized rather than replaced, so the
//    orientation lock a phone applies while the first match is still booting
//    left most of the screen composited against texels nothing had written —
//    full brightness, no shadow, no vision cone — until the match was left and
//    rejoined. Measured here as brightness: both matches must LOOK the same.
//  - the shape atlas was destroyed with the Renderer, taking the particle
//    pipe's bind group with it, so from the second match on every render()
//    threw before presenting a frame: the canvas froze on the last good frame
//    while the sim, the audio and the DOM HUD carried on. Measured here as the
//    topbar countdown still ticking, because hud.update runs *after*
//    renderer.draw in the frame loop and a throw takes it down too.
console.log('\nrejoin lifecycle');
const quitToMenu = async (): Promise<void> => {
  await page.evaluate(`document.getElementById('pausebtn').click()`);
  await sleep(150);
  await page.evaluate(`document.getElementById('pz-quit').click()`);
  await sleep(150);
  await page.evaluate(`document.getElementById('pz-yes').click()`);
};
const joinOutbreak = async (): Promise<boolean> => {
  await page.evaluate(`document.querySelector('.mode-card[data-mode="zombie"]').click()`);
  return page.waitFor(`document.getElementById('menu').classList.contains('hidden')
    && document.getElementById('mag').textContent !== ''`);
};

await page.viewport(390, 844, true); // a phone opens the page in portrait...
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
check(await page.waitFor(`!!document.querySelector('#bots-opts button.sel')`), 'reloaded portrait for a cold first join');
const errorsBefore = page.errors.length;
await page.evaluate(`document.querySelector('.mode-card[data-mode="zombie"]').click()`);
await sleep(150);
await page.viewport(844, 390, true); // ...and the mode card locks it landscape
check(await page.waitFor(`document.getElementById('mag').textContent !== ''`),
  'first match boots through the orientation flip');
// Both matches fire a few rounds, and that is load-bearing for the second bug
// as well as for symmetry: the shell/spark/smoke ParticleContainers are what
// bind the shape atlas into the particle pipe's shader, and a match where
// nobody pulls the trigger never binds it, so it cannot lose it either.
const burst = async (): Promise<void> => {
  await page.touch([{ x: 640, y: 250 }, { x: 730, y: 250 }]);
  await sleep(600);
  await page.release();
  await sleep(1600); // muzzle flash, tracers and smoke all expire well inside this
};
await sleep(600);
await burst();
const lumaFirst = await page.luma();

await quitToMenu();
check(await page.waitFor(`!document.getElementById('menu').classList.contains('hidden')`), 'pause -> quit lands back on the menu');
check(await page.evaluate(`document.getElementById('conn-status').textContent === ''`),
  'a deliberate exit reports nothing, not "Could not connect"');
await sleep(400);
check(await joinOutbreak(), 'rejoined a second OUTBREAK match');
await sleep(600);
await burst();

// the frame loop is still presenting frames, not throwing inside render()
const tick0 = await page.evaluate<string>(`document.getElementById('topbar').textContent`);
await sleep(1400);
const tick1 = await page.evaluate<string>(`document.getElementById('topbar').textContent`);
check(tick0 !== tick1, `the second match keeps drawing (topbar "${tick0}" -> "${tick1}")`);
check(page.errors.length === errorsBefore,
  `nothing thrown across the quit/rejoin cycle (${page.errors.length - errorsBefore} exceptions)`);

// Same map, same spawn, same wave-0 break, no input in either: what the two
// matches look like is the whole assertion. A lightmap that missed the rotate
// showed up as the first match being several times brighter than the second.
const lumaSecond = await page.luma();
const spread = Math.abs(lumaFirst - lumaSecond) / Math.max(lumaFirst, lumaSecond);
check(spread < 0.25,
  `both matches light the world the same (mean luma ${lumaFirst.toFixed(1)} vs ${lumaSecond.toFixed(1)}, ${(spread * 100).toFixed(0)}% apart)`);

// ---- /touch-preview.html: drives the same Touch/stick modules ----
console.log('\ntouch preview page');
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/touch-preview.html` });
check(await page.waitFor(`document.getElementById('dump').textContent.includes('viewport')`),
  'preview page boots and reports live state');
await page.touch([{ x: 200, y: 300 }, { x: 200, y: 200 }]);
check(await page.evaluate(`document.getElementById('dump').textContent.includes('W')`), 'preview reflects pad input');
await page.release();

// The deadzone is the whole gate now: inside it the stick steers nothing and
// holds fire, outside it every deflection both aims and is weapons-free. Angle
// here, ammo in the match above.
const engaged = async (): Promise<boolean> => /\bENGAGED\b/.test(await page.evaluate<string>(
  `[...document.getElementById('dump').querySelectorAll('b')].map(b=>b.textContent).join(' ')`));
await page.touch([{ x: 640, y: 200 }, { x: 650, y: 200 }]); // 10px: inside the 13px deadzone
await sleep(200);
check(!(await engaged()), 'inside the deadzone the stick is disengaged — the ceasefire');
await page.touch([{ x: 640, y: 200 }, { x: 660, y: 200 }]); // 20px: past it
await sleep(200);
const band = await page.evaluate<string>(`document.getElementById('dump').textContent`);
// the dump always contains the word ENGAGED (greyed out when off, see flag()),
// so the assertion above reads the <b> elements, not this text
const aimLine = (band.match(/^aim .*$/m) || [''])[0].replace(/ENGAGED/, '').trim();
check(/\b0\.0°/.test(aimLine) && /deflect 0\.38/.test(aimLine),
  `a nudge steers the aim (${aimLine})`);
check(await engaged(), 'and the same nudge is already weapons-free — there is no aim-only band left');

// The aim ease, end state only: asserting the transient would race the render
// loop and go flaky, so this checks the two things that actually break —
// (a) tick(dt) is wired up at all, and (b) the ease converges rather than
// parking short of the target forever.
const lagOf = async (): Promise<number> => {
  const m = (await page.evaluate<string>(`document.getElementById('dump').textContent`))
    .match(/lag\s+(-?[\d.]+)/);
  return m ? Math.abs(Number(m[1])) : NaN;
};
await page.touch([{ x: 640, y: 200 }, { x: 700, y: 260 }]); // ~45deg, at the rim
await sleep(500);
const settled = await lagOf();
check(settled < 1, `the eased aim converges on the raw angle (lag ${settled.toFixed(2)}deg)`);
// A frozen aim is the failure mode of the per-frame design (a caller that never
// ticks): it would show up here as lag that never closes.
await page.touch([{ x: 640, y: 200 }, { x: 580, y: 140 }]); // swing ~180deg away
await sleep(500);
const settled2 = await lagOf();
check(settled2 < 1, `and keeps converging after a large swing (lag ${settled2.toFixed(2)}deg)`);
await page.release();

// ---- desktop regression: the zoom/autoDensity work must not touch it ----
console.log('\ndesktop client (1920x1080)');
// Registered after the touch one and therefore runs after it: dropping the token
// here is what makes this pass its own player, claiming its own callsign.
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{
    localStorage.removeItem('wz3-id');
    localStorage.setItem('wz3-name','DESKTOP');
  }catch(e){}`,
});
// Turning touch emulation back off is now the whole of what makes this the
// fine-pointer pass — there is no stored override left to clear.
await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
await page.viewport(1920, 1080, false);
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
check(await page.waitFor(`!!document.querySelector('#bots-opts button.sel')`), 'client module booted');

check(!(await page.evaluate(`document.body.classList.contains('touch')`)), 'touch mode off on a fine pointer');
check(await page.evaluate(`getComputedStyle(document.getElementById('touch')).display === 'none'`), 'no pads rendered');
await page.evaluate(`document.querySelector('.mode-card[data-mode="tdm"]').click()`);
check(await page.waitFor(`document.getElementById('menu').classList.contains('hidden')
  && document.getElementById('mag').textContent !== ''`), 'joined a TDM room and the HUD is live');
const cv = await page.evaluate<[number, number, string, string]>(
  `(()=>{const c=document.getElementById('game');return [c.width,c.height,c.style.width,c.style.height]})()`);
check(cv[0] === 1920 && cv[1] === 1080, `backing store 1:1 at DPR 1 (${cv[0]}x${cv[1]})`);
check(cv[2] === '1920px' && cv[3] === '1080px', `autoDensity sets the CSS size (${cv[2]} x ${cv[3]})`);
check(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--s').trim() === '1'`),
  'HUD scale is 1 on a desktop viewport');

const dm0 = Number(await page.evaluate<string>(`document.getElementById('mag').textContent`));
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1200, y: 400, button: 'left', clickCount: 1, buttons: 1 });
const mouseFired = await page.waitFor(`Number(document.getElementById('mag').textContent) < ${dm0}`, 8000);
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1200, y: 400, button: 'left', clickCount: 1, buttons: 0 });
check(mouseFired, 'holding the mouse still fires');

await page.viewport(900, 420, false);
await sleep(700);
check(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--s').trim() === '.62'`),
  'a short viewport compacts the HUD');

// atlas.json is an optional reskin hook (gfx/textures.ts tryLoadArtAtlas) and
// is expected to 404; anything thrown is not.
check(page.errors.length === 0, `no uncaught page exceptions (${page.errors.length})`);
for (const e of page.errors) console.error('   ', e);

done();
