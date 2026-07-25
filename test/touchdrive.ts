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
  env: { ...process.env, PORT: String(PORT) },
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

// ---- phone: 844x390 landscape, touch controls forced on ----
console.log('touch client (844x390)');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.clear();localStorage.setItem('wz3-touch','on');localStorage.setItem('wz3-name','TOUCH');}catch(e){}`,
});
await page.viewport(844, 390, true);
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
check(await page.waitFor(`!!document.querySelector('#loadout-opts .wicon')`), 'client module booted');

check(await page.evaluate(`document.body.classList.contains('touch')`), 'touch mode applies from the menu setting');
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

// Rounds spent, not elapsed time: a loaded SwiftShader frame rate decides how
// fast the client can pulse the flag, and this asserts the mechanism works, not
// that a headless browser hits 60fps.
const mag0 = Number(await page.evaluate<string>(`document.getElementById('mag').textContent`));
await page.touch([{ x: 640, y: 250 }, { x: 720, y: 250 }]);
const fired = await page.waitFor(`${mag0} - Number(document.getElementById('mag').textContent) >= 3`, 8000);
const mag1 = Number(await page.evaluate<string>(`document.getElementById('mag').textContent`));
check(fired, `held stick keeps a semi-auto firing (mag ${mag0} -> ${mag1}; a raw held flag would stop at 1)`);
await page.release();
const mag2 = Number(await page.evaluate<string>(`document.getElementById('mag').textContent`));
await sleep(700);
check(Number(await page.evaluate<string>(`document.getElementById('mag').textContent`)) === mag2,
  'releasing the stick stops the fire');
check(await page.evaluate(`document.getElementById('astick').classList.contains('hidden')`), 'aim stick hides on release');

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

// ---- /touch-preview.html: drives the same Touch/stick modules ----
console.log('\ntouch preview page');
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/touch-preview.html` });
check(await page.waitFor(`document.getElementById('dump').textContent.includes('viewport')`),
  'preview page boots and reports live state');
await page.touch([{ x: 200, y: 300 }, { x: 200, y: 200 }]);
check(await page.evaluate(`document.getElementById('dump').textContent.includes('W')`), 'preview reflects pad input');
await page.release();

// ---- desktop regression: the zoom/autoDensity work must not touch it ----
console.log('\ndesktop client (1920x1080)');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.clear();localStorage.setItem('wz3-name','DESKTOP');}catch(e){}`,
});
await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
await page.viewport(1920, 1080, false);
await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
check(await page.waitFor(`!!document.querySelector('#loadout-opts .wicon')`), 'client module booted');

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
check(await page.evaluate(`getComputedStyle(document.querySelector('.bb-toggle')).display === 'none'`),
  'bot bar is not collapsed on desktop');

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
