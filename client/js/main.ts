import { Grid } from '../../shared/maps.ts';
import { castPellet, type HitCircle } from '../../shared/hitscan.ts';
import { PLAYER_RADIUS, ZOMBIE_RADII } from '../../shared/constants.ts';
import { WEAPONS, PRIMARIES, fireIntervalMs, type WeaponId } from '../../shared/weapons.ts';
import { Net } from './net.ts';
import { Input } from './input.ts';
import { GameState } from './state.ts';
import { Renderer } from './render.ts';
import { Fx } from './fx.ts';
import { Audio } from './audio.ts';
import { Hud, weaponIconHtml } from './hud.ts';
import { bloomFor, resolutionFor, uiScaleFor, type QualityTier } from './view.ts';
import { DEAD_ZONE, newFireCadence, newLead, tickFireCadence, tickLead } from './stick.ts';
import { cancelReload, newReloadMirror, startReload, tickReload } from './reload.ts';
import { Touch, touchDefault, type TouchMode } from './touch.ts';
import type { GameEvent, GameMode, InputMsg, PlayerSnap, SelfSnap, Snapshot, Vec2, ZombieSnap } from '../../shared/types.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const net = new Net();
const input = new Input(canvas);
const touch = new Touch();
const audio = new Audio();
const fx = new Fx();

// assigned once on welcome; the game loop only runs after that
let grid!: Grid, state!: GameState, renderer!: Renderer, hud!: Hud;
let myId = 0, mode: GameMode = 'tdm', myName = 'Player';
let seq = 0, lastFrame = 0, running = false, bootSeq = 0;
let chosenPrimary = localStorage.getItem('wz3-primary') || 'rifle';
let zombieCp = parseInt(localStorage.getItem('wz3-zombie-cp') || '0', 10) || 0;

// Small/touch screens shrink the HUD and the minimap. Mirrors the media query
// in style.css; read once at load, so the DOM HUD tracks a live resize but the
// canvas-side minimap scale is fixed for the session.
const COMPACT_UI = matchMedia('(pointer: coarse), (max-height: 500px)').matches;
// Graphics tier: `sharp` = DPR-aware backing store + bloom, `fast` = neither.
// Both tiers render identical gameplay information (see view.ts / lights.ts).
const storedQ = localStorage.getItem('wz3-quality');
let quality: QualityTier = storedQ === 'fast' || storedQ === 'sharp'
  ? storedQ
  : (matchMedia('(pointer: coarse)').matches ? 'fast' : 'sharp');

// local gun-feel mirror (server stays authoritative for damage/ammo)
const gun = { cd: 0, spread: 0, sinceShot: 0, wasDown: false };
const reloadPred = newReloadMirror();
let lastSlot = -1;
let growlTimer = 2;
let perfFrames = 0, perfSince = 0, perfFps = 0; // FPS counter (500ms window)
let deadFollow: Vec2 | null = null; // spectate target pos in zombie mode
let specIdx = 0;                    // spectate selection, advanced by click while down
let specName: string | null = null; // name of the squadmate being spectated

// touch: synthesised fire edges for semi-autos, auto-reload throttle, and the
// tap-toggled scoreboard (there is no Tab key to hold)
const cadence = newFireCadence();
let autoReloadT = 0;
let scoresOpen = false;
// camera pull toward the aim stick, in world px at full deflection — the
// touch equivalent of the desktop mouse lead
const TOUCH_LEAD = 140;
// Ease time for that pull. Lifting the thumb zeroes deflection in one frame, so
// an unsmoothed lead snaps the camera TOUCH_LEAD px; at 0.08s the offset is ~85%
// gone in 150ms — a glide, not a pan. Touch only: on desktop the camera feeds
// back into the aim angle (see below), so easing it there would make mouse aim
// chase the cursor instead of tracking it.
const LEAD_TAU = 0.08;
const camLead = newLead();
// where the reticle sits along the aim ray, in world px
const CROSS_DIST = 200;

// ---------- menu ----------
const nameInput = $('name-input') as HTMLInputElement;
nameInput.value = localStorage.getItem('wz3-name') || '';
for (const b of document.querySelectorAll<HTMLButtonElement>('#loadout-opts button')) {
  b.innerHTML = weaponIconHtml(b.dataset.w as WeaponId) + b.innerHTML;
  if (b.dataset.w === chosenPrimary) b.classList.add('sel');
  else if (chosenPrimary === 'rifle' && b.dataset.w === 'rifle') b.classList.add('sel');
  b.onclick = () => {
    document.querySelectorAll('#loadout-opts button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    chosenPrimary = b.dataset.w!;
    localStorage.setItem('wz3-primary', chosenPrimary);
  };
}
// touch controls: follow the device by default, overridable from the menu
const storedT = localStorage.getItem('wz3-touch');
let touchMode: TouchMode = storedT === 'on' || storedT === 'off' ? storedT : 'auto';
function applyTouchMode(): void {
  touch.setActive(touchMode === 'on' || (touchMode === 'auto' && touchDefault()));
  // The ease only runs on the touch branch, so the lead goes stale whenever the
  // pads are inactive and would apply as a step on the first frame back.
  camLead.x = 0; camLead.y = 0;
  $('help-kb').classList.toggle('hidden', touch.active);
  $('help-touch').classList.toggle('hidden', !touch.active);
  // these hints name a key that touch players do not have
  $('reloadhint').textContent = touch.active ? 'RELOAD' : 'R — RELOAD';
  $('shophint').textContent = touch.active ? 'ARMORY' : 'B — ARMORY';
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#touch-opts button')) {
  b.classList.toggle('sel', b.dataset.t === touchMode);
  b.onclick = () => {
    touchMode = b.dataset.t as TouchMode;
    localStorage.setItem('wz3-touch', touchMode);
    document.querySelectorAll('#touch-opts button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    applyTouchMode();
  };
}
applyTouchMode();

// tapping the score bar stands in for holding Tab
$('topbar').addEventListener('pointerdown', (e) => {
  if (!touch.active) return;
  e.preventDefault();
  scoresOpen = !scoresOpen;
});

// TDM death screen: the desktop 1-4 loadout keys as tap targets (delegated,
// because centerMsg rewrites the overlay whenever its text changes)
$('center-msg').addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest('[data-loadout]') as HTMLElement | null;
  if (!b) return;
  e.preventDefault();
  const wname = b.dataset.loadout as WeaponId;
  net.send({ t: 'primary', w: wname });
  hud.banner(WEAPONS[wname].name.toUpperCase() + ' EQUIPPED', 1200);
});

// graphics tier picker — applied when the next match boots its Renderer
for (const b of document.querySelectorAll<HTMLButtonElement>('#gfx-opts button')) {
  b.classList.toggle('sel', b.dataset.q === quality);
  b.onclick = () => {
    quality = b.dataset.q as QualityTier;
    localStorage.setItem('wz3-quality', quality);
    document.querySelectorAll('#gfx-opts button').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
  };
}

// Fullscreen, orientation lock and wake lock, all requested from the mode-card
// tap because that is a user gesture (it is already where audio.ensure runs).
// Every one of them is unsupported somewhere — iPhone Safari ignores element
// fullscreen and orientation lock outright — so all three are best-effort and
// the layout has to be correct without any of them.
interface WakeLockish { release(): Promise<void> }
let wakeLock: WakeLockish | null = null;

async function acquireWakeLock(): Promise<void> {
  const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<WakeLockish> } };
  if (!nav.wakeLock) return;
  try { wakeLock = await nav.wakeLock.request('screen'); } catch { /* denied or unsupported */ }
}

async function goImmersive(): Promise<void> {
  if (!touch.active) return;
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* unsupported */ }
  const orient = screen.orientation as unknown as { lock?(o: string): Promise<void> } | undefined;
  try { await orient?.lock?.('landscape'); } catch { /* iOS, or not fullscreen */ }
  await acquireWakeLock();
}

// the browser drops the lock whenever the tab is backgrounded
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) void acquireWakeLock();
});

for (const card of document.querySelectorAll<HTMLButtonElement>('.mode-card')) {
  card.onclick = () => {
    myName = nameInput.value.trim() || 'Player';
    localStorage.setItem('wz3-name', myName);
    $('conn-status').textContent = 'connecting…';
    audio.ensure();
    void goImmersive();
    const cp = card.dataset.mode === 'zombie' ? zombieCp : 0;
    net.connect({ t: 'join', name: myName, mode: card.dataset.mode, primary: chosenPrimary, cp });
  };
}

// OUTBREAK checkpoint (saved locally; the server arms it when you start a fresh room)
function refreshCpRow(): void {
  const has = zombieCp >= 5;
  $('cp-row').classList.toggle('hidden', !has);
  if (has) $('cp-label').textContent = `OUTBREAK checkpoint — resume at wave ${zombieCp}`;
}
function saveCp(cp: number): void {
  zombieCp = cp;
  if (cp > 0) localStorage.setItem('wz3-zombie-cp', String(cp));
  else localStorage.removeItem('wz3-zombie-cp');
  refreshCpRow();
}
$('cp-clear').onclick = () => saveCp(0);
refreshCpRow();

net.onClose = (reason) => {
  running = false;
  if (wakeLock) { void wakeLock.release().catch(() => {}); wakeLock = null; }
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  $('conn-status').textContent = reason || 'disconnected';
  refreshCpRow();
};

net.onWelcome = (m) => {
  running = false;
  myId = m.id;
  mode = m.mode;
  grid = Grid.deserialize(m.map);
  state = new GameState(grid, myId);
  hud = new Hud(mode, {
    onAddBot: (team) => net.send({ t: 'addBot', team }),
    onRemoveBot: (team) => net.send({ t: 'removeBot', team }),
    onBuy: (item) => net.send({ t: 'buy', item }),
  });
  touch.showArmory(mode === 'zombie'); // mirrors the desktop B key
  scoresOpen = false;
  // Renderer boot is async (WebGL init); snapshots arriving in the gap just
  // buffer in state. The token guards against a stale .then from a re-welcome.
  const boot = ++bootSeq;
  void Renderer.create(canvas, grid, {
    resolution: resolutionFor(quality, devicePixelRatio || 1),
    bloom: bloomFor(quality),
    uiScale: uiScaleFor(COMPACT_UI),
  }).then((r) => {
    if (boot !== bootSeq) return;
    renderer = r;
    running = true;
    lastFrame = performance.now();
    perfSince = lastFrame; perfFrames = 0;
    requestAnimationFrame(loop);
  });
};

net.onSnap = (s, when) => {
  state.addSnapshot(s, when);
  if (s.mode === 'zombie' && s.cp > zombieCp) saveCp(s.cp);
  for (const e of s.events) handleEvent(e, s);
};

// ---------- server events -> fx/audio/hud ----------
function nameSpan(name: string, team: number): string { return `<span class="k${team}">${esc(name)}</span>`; }
function esc(s: unknown): string {
  return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as Record<string, string>)[c]);
}

function handleEvent(e: GameEvent, snap: Snapshot): void {
  const cam = camCenter();
  switch (e.e) {
    case 'shot': {
      if (e.id === myId || !renderer) break; // own shots predicted locally; renderer async at boot
      const sp = audio.spatial(e.x - cam.x, e.y - cam.y);
      audio.shot(e.w, sp.gain, sp.pan);
      const tip = renderer.gunTip(e.x, e.y, e.p[0] ? e.p[0].a : 0, e.w);
      fx.muzzle(tip.x, tip.y, e.p[0] ? e.p[0].a : 0);
      for (const pel of e.p) {
        fx.tracer(e.x, e.y, e.x + Math.cos(pel.a) * pel.d, e.y + Math.sin(pel.a) * pel.d, e.w);
      }
      break;
    }
    case 'hit': {
      fx.blood(e.x, e.y, e.z ? 6 : 5);
      if (renderer) renderer.stampBlood(e.x, e.y, false, !!e.z);
      if (e.sid === myId) {
        audio.hitmarker();
        fx.damageNum(e.x, e.y, e.amt);
      }
      if (e.vid === myId) {
        audio.hurt();
        hud.hitflash();
        fx.addShake(5);
      }
      break;
    }
    case 'die':
      fx.corpse(e.x, e.y, 'player');
      fx.blood(e.x, e.y, 14);
      if (renderer) renderer.stampBlood(e.x, e.y, true, false);
      if (e.id === myId) fx.addShake(12);
      break;
    case 'zdie': {
      fx.corpse(e.x, e.y, 'zombie');
      fx.blood(e.x, e.y, 10);
      if (renderer) renderer.stampBlood(e.x, e.y, true, true);
      const sp = audio.spatial(e.x - cam.x, e.y - cam.y);
      audio.zdie(sp.gain, sp.pan);
      break;
    }
    case 'kill':
      hud.killfeed(`${nameSpan(e.k, e.kt)}<span class="wname">[${e.w}]</span>${nameSpan(e.v, e.vt)}`);
      break;
    case 'wave':
      hud.banner(`WAVE ${e.n}`, 2500);
      audio.waveHorn();
      hud.centerMsg(null);
      break;
    case 'break': {
      const hint = hud.shopHintDone ? '' : (touch.active ? '  ·  ARMORY' : '  ·  PRESS B — ARMORY');
      hud.banner(`WAVE CLEARED  ·  +$${e.bonus}` + hint, 3000);
      audio.cash();
      break;
    }
    case 'frenzy':
      hud.banner('FRENZY — THEY SMELL BLOOD', 2800);
      audio.waveHorn();
      break;
    case 'over':
      audio.hurt();
      break;
    case 'matchend':
      break;
    case 'matchstart':
      if (snap.mode === 'zombie' && snap.cp > 0) hud.banner(`CHECKPOINT — WAVE ${snap.cp}`, 2500);
      else hud.banner('FIGHT', 1500);
      hud.centerMsg(null);
      if (renderer) renderer.resetDecals(); // world reset — wipe accumulated gore
      break;
    case 'buy':
      if (e.id === myId) { audio.cash(); hud.shopHintDone = true; }
      break;
    case 'revive':
      if (e.id === myId) hud.banner('BACK IN THE FIGHT', 2000);
      break;
    case 'join':
      hud.killfeed(`${nameSpan(e.name, e.team)}<span class="wname">joined</span>`);
      break;
    case 'leave':
      hud.killfeed(`<span class="wname">${esc(e.name)} left</span>`);
      break;
  }
}

// Bodies the locally-predicted tracer stops on — mirrors the server's
// hitscanTargets (TDM: living, unprotected enemies; OUTBREAK: every zombie) so
// own-shot tracers end on flesh instead of punching through to the wall behind.
// Positions are the interpolated (render-time) ones, i.e. exactly the bodies the
// player was looking at when they pulled the trigger.
function tracerTargets(
  interp: { players: PlayerSnap[]; zombies: ZombieSnap[] },
  meSnap: PlayerSnap,
): HitCircle[] {
  const out: HitCircle[] = [];
  if (mode === 'zombie') {
    for (const z of interp.zombies) out.push({ x: z.x, y: z.y, radius: ZOMBIE_RADII[z.type] });
  } else {
    for (const p of interp.players) {
      if (p.id === myId || p.team === meSnap.team || !p.alive || p.prot) continue;
      out.push({ x: p.x, y: p.y, radius: PLAYER_RADIUS });
    }
  }
  return out;
}

function camCenter(): Vec2 {
  if (!state || !state.pred) return { x: 0, y: 0 };
  return { x: state.pred.x, y: state.pred.y };
}

// ---------- main loop ----------
function loop(t: number): void {
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0.001, (t - lastFrame) / 1000));
  lastFrame = t;

  // --- perf readout (before the early-out, so it keeps ticking while waiting
  // for the first snapshot). FPS is a frame count over a 500ms window, not
  // 1/dt, so a single hitched frame doesn't make the number jump.
  net.pingTick(t);
  perfFrames++;
  if (t - perfSince >= 500) {
    perfFps = Math.round((perfFrames * 1000) / (t - perfSince));
    perfFrames = 0;
    perfSince = t;
  }
  hud.perf(perfFps, Math.round(net.ping));

  const snap = state.latest;
  const self = snap ? snap.self : null;
  const meSnap = snap ? snap.players.find(p => p.id === myId) : null;
  if (!snap || !self || !meSnap) return;

  const alive = !!meSnap.alive;
  const inputAllowed = snap.state === 'live' || mode === 'zombie';
  const interp = state.interpolated();

  // --- spectate / own position ---
  let mePos = state.myPos(dt) || { x: meSnap.x, y: meSnap.y };
  if (!alive) {
    if (mode === 'zombie') {
      const living = interp.players.filter(p => p.alive && p.id !== myId);
      if (living.length) {
        const cycled = touch.active ? touch.tapped : input.clicked;
        if (cycled && !hud.buyOpen) specIdx++;
        const target = living[specIdx % living.length];
        specName = target.name;
        deadFollow = { x: target.x, y: target.y };
      } else specName = null;
      if (deadFollow) mePos = deadFollow;
    } else {
      mePos = { x: meSnap.x, y: meSnap.y };
    }
  }

  // --- aim ---
  // Screen sizes are CSS px (autoDensity); `zoom` is world px per screen px and
  // is 1 on any desktop-sized viewport, so this is the original math there.
  const zoom = renderer.zoom;
  const vw = renderer.screenW, vh = renderer.screenH;
  let aim: number;
  let lead: Vec2;
  if (touch.active) {
    // the stick gives an absolute angle (screen and world axes align); the
    // camera pulls the way you are aiming, scaled by how hard you push
    aim = touch.aim;
    // eased, not applied raw: `aim` survives a release but `deflect` does not,
    // so the raw target steps to zero the instant the thumb lifts
    lead = tickLead(
      camLead,
      Math.cos(aim) * touch.deflect * TOUCH_LEAD,
      Math.sin(aim) * touch.deflect * TOUCH_LEAD,
      LEAD_TAU, dt,
    );
  } else {
    lead = {
      x: ((input.mouse.x - vw / 2) * 0.1) / zoom,
      y: ((input.mouse.y - vh / 2) * 0.1) / zoom,
    };
    aim = 0; // needs the camera first, resolved below
  }
  const baseCam = renderer.camera(mePos, lead, { x: 0, y: 0 });
  if (!touch.active) {
    const mouseWorld = {
      x: baseCam.x + (input.mouse.x - vw / 2) / zoom,
      y: baseCam.y + (input.mouse.y - vh / 2) / zoom,
    };
    aim = Math.atan2(mouseWorld.y - mePos.y, mouseWorld.x - mePos.x);
  }

  const wid = self.slots[self.slot];
  const w = WEAPONS[wid];

  // --- build + send input ---
  // Both sources are read whenever the pads are up, so a phone with a
  // bluetooth keyboard still works.
  const kb = input.moveKeys();
  const keys = touch.active
    ? {
      w: kb.w || touch.keys.w ? 1 : 0, a: kb.a || touch.keys.a ? 1 : 0,
      s: kb.s || touch.keys.s ? 1 : 0, d: kb.d || touch.keys.d ? 1 : 0,
    }
    : kb;
  const moving = !!(keys.w || keys.a || keys.s || keys.d);
  // The touch SPRINT button is a toggle, so it must not leak stamina: tickSprint
  // drains whenever the flag is set, moving or not. Gate the wire flag on
  // movement instead of clearing the toggle — clearing it made a pre-emptive tap
  // (arm sprint, then run) impossible, since the cancel fired the same frame.
  const sprint = touch.active ? (touch.sprint && moving) : !!input.keys['shift'];
  const held = (touch.active ? touch.deflect >= DEAD_ZONE : input.mouse.down)
    && !hud.buyOpen && alive && inputAllowed;
  // A held flag fires a semi-auto exactly once (server-side firePrev), so on
  // touch the flag is pulsed at the weapon's fire interval instead.
  const firing = touch.active
    ? tickFireCadence(cadence, held, w.auto, fireIntervalMs(w) / 1000, dt)
    : held;
  seq++;
  const msg: InputMsg = { t: 'input', seq, dt, keys, aim, fire: firing, sprint };
  // The render time this input was aimed at, so the server can resolve our
  // shots against the world we were actually looking at. Omitted until the
  // server clock is synced, where renderTime() has nothing to report.
  const rt = state.renderTime();
  if (rt) msg.rt = rt;
  net.send(msg);
  if (alive) state.predict({ seq, dt, keys, sprint });

  // ...and it clears itself once it can no longer do anything, so the lit
  // button never lies about what the next step will do
  if (touch.active && touch.sprint) {
    const stam = state.pred ? state.pred.stamina : 100;
    if (!alive || stam <= 0) touch.setSprint(false);
  }

  // --- reload mirror: run locally, then let the server end it ---
  if (self.slot !== lastSlot) { cancelReload(reloadPred); lastSlot = self.slot; }
  if (!alive) cancelReload(reloadPred);
  const reloadShown = tickReload(reloadPred, self.reloadT, dt);
  // The bar shows the optimistic local clock so it moves the instant R is
  // pressed; firing gates on whichever of the two is still running, so a
  // prediction that finishes ~RTT/2 early can never license a phantom tracer.
  // `self.sw` is the weapon-switch lockout, which the mirror ignored entirely
  // before — at high ping that produced tracers the server refused outright.
  const fireBlocked = Math.max(reloadShown, self.reloadT, self.sw) > 0;

  // --- local gun feel (muzzle/tracer/sound/kick predicted immediately) ---
  gun.cd -= dt;
  gun.sinceShot += dt;
  if (gun.sinceShot > 0.25 && gun.spread > 0) gun.spread = Math.max(0, gun.spread - w.recover * dt);
  const magNow = self.ammo[self.slot] ? self.ammo[self.slot].mag : 0;
  const freshClick = firing && !gun.wasDown;
  if (firing && gun.cd <= 0 && !fireBlocked && magNow > 0 && (w.auto || freshClick)) {
    gun.cd = fireIntervalMs(w) / 1000;
    gun.sinceShot = 0;
    let spr = (w.baseSpread + gun.spread);
    if (keys.w || keys.a || keys.s || keys.d) spr *= w.moveSpreadMult;
    spr = Math.min(spr, w.maxSpread);
    const tip = renderer.gunTip(mePos.x, mePos.y, aim, wid);
    fx.muzzle(tip.x, tip.y, aim);
    const targets = tracerTargets(interp, meSnap);
    for (let i = 0; i < w.pellets; i++) {
      const a = aim + (Math.random() * 2 - 1) * spr;
      const dx = Math.cos(a), dy = Math.sin(a);
      const { dist: d } = castPellet(grid, mePos.x, mePos.y, dx, dy, w.range, targets);
      fx.tracer(mePos.x, mePos.y, mePos.x + dx * d, mePos.y + dy * d, wid);
    }
    audio.shot(wid, 0.9, 0);
    fx.addShake(w.kick * 0.35);
    gun.spread = Math.min(gun.spread + w.bloom, w.maxSpread);
  }
  gun.wasDown = firing;

  // --- edge-triggered controls ---
  const tapReload = touch.active && touch.consume('reload');
  const tapSwap = touch.active && touch.consume('swap');
  const tapArmory = touch.active && touch.consume('armory');
  if (input.consume('r') || tapReload) {
    net.send({ t: 'reload' });
    audio.click(0.2);
    startReload(reloadPred, wid, self.ammo[self.slot]);
  }
  if (input.consume('b') || tapArmory) hud.toggleBuy();
  if (input.consume('escape')) hud.toggleBuy(false);
  if (tapSwap && alive && self.slots.length > 1) {
    net.send({ t: 'slot', i: (self.slot + 1) % self.slots.length });
  }

  // Touch has no spare thumb for a reload key, so an empty mag reloads itself.
  // Throttled, not edge-triggered: the server clears the condition by starting
  // the reload, and a dropped packet just retries.
  const curAmmo = self.ammo[self.slot];
  autoReloadT -= dt;
  if (touch.active && alive && curAmmo && curAmmo.mag === 0 && curAmmo.reserve > 0
      && reloadShown <= 0 && !reloadPred.active) {
    if (autoReloadT <= 0) { net.send({ t: 'reload' }); autoReloadT = 0.5; startReload(reloadPred, wid, curAmmo); }
  } else if (autoReloadT < 0) autoReloadT = 0;
  if (hud.buyOpen) {
    // number keys buy while the armory is open
    ['smg', 'shotgun', 'rifle', 'sniper', 'ammo', 'health'].forEach((item, i) => {
      if (input.consume(String(i + 1))) net.send({ t: 'buy', item });
    });
  } else if (alive) {
    if (input.consume('1')) net.send({ t: 'slot', i: 0 });
    if (input.consume('2')) net.send({ t: 'slot', i: 1 });
    if (input.wheel !== 0 && self.slots.length > 1) {
      net.send({ t: 'slot', i: (self.slot + 1) % self.slots.length });
    }
  } else if (mode === 'tdm') {
    PRIMARIES.forEach((wname, i) => {
      if (input.consume(String(i + 1))) {
        net.send({ t: 'primary', w: wname });
        hud.banner(WEAPONS[wname].name.toUpperCase() + ' EQUIPPED', 1200);
      }
    });
  }

  // --- ambient zombie growls ---
  if (mode === 'zombie' && interp.zombies.length) {
    growlTimer -= dt;
    if (growlTimer <= 0) {
      growlTimer = 1.5 + Math.random() * 2.5;
      const z = interp.zombies[Math.floor(Math.random() * interp.zombies.length)];
      const sp = audio.spatial(z.x - mePos.x, z.y - mePos.y);
      audio.growl(sp.gain, sp.pan);
    }
  }

  // --- center overlays ---
  updateCenterMsg(snap, self, meSnap);

  // --- draw ---
  fx.update(dt);
  const sh = fx.shakeOffset();
  const cam = { x: baseCam.x + sh.x, y: baseCam.y + sh.y };
  let spreadShown = w.baseSpread + gun.spread;
  if (keys.w || keys.a || keys.s || keys.d) spreadShown *= w.moveSpreadMult;
  // no cursor on touch: park the reticle a fixed world distance along the aim ray
  const crosshair = touch.active
    ? {
      x: (mePos.x + Math.cos(aim) * CROSS_DIST - cam.x) * zoom + vw / 2,
      y: (mePos.y + Math.sin(aim) * CROSS_DIST - cam.y) * zoom + vh / 2,
    }
    : input.mouse;
  renderer.draw({
    cam, crosshair, myId, mode, now: t,
    me: { x: mePos.x, y: mePos.y, aim },
    players: interp.players,
    zombies: interp.zombies,
    fx, spread: Math.min(spreadShown, w.maxSpread),
  });

  // Only clone while predicting — this runs every frame, and the merge exists
  // solely to feed the HUD the local reload clock instead of the server's.
  const selfView = reloadPred.active
    ? { ...self, reloadT: reloadShown, reloadTotal: reloadPred.total }
    : self;
  hud.update(snap, selfView, myId, state.pred ? state.pred.stamina : 100);
  hud.scoreboard(snap, myId, !!input.keys['tab'] || scoresOpen);
  input.endFrame();
  touch.endFrame();
}

function updateCenterMsg(snap: Snapshot, self: SelfSnap, meSnap: PlayerSnap): void {
  if (snap.mode === 'tdm' && snap.state === 'over') {
    const win = snap.scores[0] === snap.scores[1] ? -1 : (snap.scores[0] > snap.scores[1] ? 0 : 1);
    const label = win === -1 ? 'DRAW' : (win === meSnap.team ? 'VICTORY' : 'DEFEAT');
    const color = win === -1 ? '#cfd6df' : (win === meSnap.team ? '#9fe870' : '#ff6a5e');
    hud.centerMsg(`<div class="big" style="color:${color}">${label}</div>` +
      `<div class="sub">${snap.scores[0]} — ${snap.scores[1]} · next match in ${snap.restartT}s</div>`);
  } else if (snap.mode === 'zombie' && snap.state === 'over') {
    const restart = snap.cp > 0 ? `back to wave ${snap.cp} in ${snap.restartT}s` : `restarting in ${snap.restartT}s`;
    hud.centerMsg(`<div class="big" style="color:#e8483f">OVERRUN</div>` +
      `<div class="sub">the squad fell on wave ${snap.wave} · ${restart}</div>`);
  } else if (!meSnap.alive) {
    if (mode === 'tdm') {
      // the keyboard hint and the tap targets are the same four choices; CSS
      // shows exactly one of them (.kbd-only / .cm-btns)
      const btns = PRIMARIES.map(wn =>
        `<button data-loadout="${wn}">${esc(WEAPONS[wn].name)}</button>`).join('');
      hud.centerMsg(`<div class="big" style="color:#e8a53f">RESPAWN IN ${Math.ceil(self.respawnT)}</div>` +
        `<div class="sub kbd-only">switch loadout: 1 SMG · 2 AR-7 · 3 M870 · 4 LR-50</div>` +
        `<div class="cm-btns">${btns}</div>`);
    } else {
      const fighting = snap.players.filter(p => p.alive && p.id !== myId).length;
      const spec = specName
        ? `spectating: ${esc(specName)} — ${touch.active ? 'tap' : 'click'} to switch`
        : 'no squadmates left standing';
      let status = 'revived when the wave clears';
      if (snap.mode === 'zombie') {
        status = (snap.breakT > 0
          ? `next wave in ${snap.breakT}s`
          : `${snap.left} zombie${snap.left === 1 ? '' : 's'} left · ${fighting} fighting`)
          + ' · revived when the wave clears';
      }
      hud.centerMsg(`<div class="big" style="color:#e8a53f">DOWN</div>` +
        `<div class="sub">${spec}</div>` +
        `<div class="sub dim">${status}</div>`);
    }
  } else {
    hud.centerMsg(null);
  }
}
