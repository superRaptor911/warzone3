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
import type { GameEvent, GameMode, PlayerSnap, SelfSnap, Snapshot, Vec2, ZombieSnap } from '../../shared/types.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const net = new Net();
const input = new Input(canvas);
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
let growlTimer = 2;
let perfFrames = 0, perfSince = 0, perfFps = 0; // FPS counter (500ms window)
let deadFollow: Vec2 | null = null; // spectate target pos in zombie mode
let specIdx = 0;                    // spectate selection, advanced by click while down
let specName: string | null = null; // name of the squadmate being spectated

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

for (const card of document.querySelectorAll<HTMLButtonElement>('.mode-card')) {
  card.onclick = () => {
    myName = nameInput.value.trim() || 'Player';
    localStorage.setItem('wz3-name', myName);
    $('conn-status').textContent = 'connecting…';
    audio.ensure();
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
    case 'break':
      hud.banner(`WAVE CLEARED  ·  +$${e.bonus}` + (hud.shopHintDone ? '' : '  ·  PRESS B — ARMORY'), 3000);
      audio.cash();
      break;
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
        if (input.clicked && !hud.buyOpen) specIdx++;
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
  const lead = {
    x: ((input.mouse.x - vw / 2) * 0.1) / zoom,
    y: ((input.mouse.y - vh / 2) * 0.1) / zoom,
  };
  const baseCam = renderer.camera(mePos, lead, { x: 0, y: 0 });
  const mouseWorld = {
    x: baseCam.x + (input.mouse.x - vw / 2) / zoom,
    y: baseCam.y + (input.mouse.y - vh / 2) / zoom,
  };
  const aim = Math.atan2(mouseWorld.y - mePos.y, mouseWorld.x - mePos.x);

  // --- build + send input ---
  const keys = input.moveKeys();
  const sprint = !!input.keys['shift'];
  const firing = input.mouse.down && !hud.buyOpen && alive && inputAllowed;
  seq++;
  const msg = { t: 'input', seq, dt, keys, aim, fire: firing, sprint };
  net.send(msg);
  if (alive) state.predict({ seq, dt, keys, sprint });

  // --- local gun feel (muzzle/tracer/sound/kick predicted immediately) ---
  const wid = self.slots[self.slot];
  const w = WEAPONS[wid];
  gun.cd -= dt;
  gun.sinceShot += dt;
  if (gun.sinceShot > 0.25 && gun.spread > 0) gun.spread = Math.max(0, gun.spread - w.recover * dt);
  const magNow = self.ammo[self.slot] ? self.ammo[self.slot].mag : 0;
  const freshClick = firing && !gun.wasDown;
  if (firing && gun.cd <= 0 && self.reloadT <= 0 && magNow > 0 && (w.auto || freshClick)) {
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
  if (input.consume('r')) { net.send({ t: 'reload' }); audio.click(0.2); }
  if (input.consume('b')) hud.toggleBuy();
  if (input.consume('escape')) hud.toggleBuy(false);
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
  renderer.draw({
    cam, crosshair: input.mouse, myId, mode, now: t,
    me: { x: mePos.x, y: mePos.y, aim },
    players: interp.players,
    zombies: interp.zombies,
    fx, spread: Math.min(spreadShown, w.maxSpread),
  });

  hud.update(snap, self, myId, state.pred ? state.pred.stamina : 100);
  hud.scoreboard(snap, myId, !!input.keys['tab']);
  input.endFrame();
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
      hud.centerMsg(`<div class="big" style="color:#e8a53f">RESPAWN IN ${Math.ceil(self.respawnT)}</div>` +
        `<div class="sub">switch loadout: 1 SMG · 2 AR-7 · 3 M870 · 4 LR-50</div>`);
    } else {
      const fighting = snap.players.filter(p => p.alive && p.id !== myId).length;
      const spec = specName
        ? `spectating: ${esc(specName)} — click to switch`
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
