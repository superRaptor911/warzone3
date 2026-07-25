import { SHOP, TEAM, STAMINA_MIN_TO_SPRINT, type ShopItemId } from '../../shared/constants.ts';
import { WEAPONS, type WeaponId } from '../../shared/weapons.ts';
import { weaponIconDataUrl } from './gfx/art.ts';
import type { GameMode, PlayerSnap, SelfSnap, Snapshot } from '../../shared/types.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

// DOM weapon icons come from the same draw functions as the world sprites
// (gfx/art.ts), rasterised once per weapon to a data URL, so HUD and world can
// never show different guns.
const ICON_CACHE = new Map<WeaponId, string>();
export function weaponIconHtml(id: WeaponId): string {
  let url = ICON_CACHE.get(id);
  if (!url) { url = weaponIconDataUrl(id); ICON_CACHE.set(id, url); }
  return `<img class="wicon" src="${url}" alt="">`;
}

const BUY_ITEMS: { key: ShopItemId; label: string }[] = [
  { key: 'smg', label: 'Viper SMG' },
  { key: 'shotgun', label: 'M870 Shotgun' },
  { key: 'rifle', label: 'AR-7 Rifle' },
  { key: 'sniper', label: 'LR-50 Marksman' },
  { key: 'ammo', label: 'Ammo Refill' },
  { key: 'health', label: 'Med Kit' },
];

export interface HudHandlers {
  onAddBot: (team: 'mine' | 'enemy') => void;
  onRemoveBot: (team: 'mine' | 'enemy') => void;
  onBuy: (item: ShopItemId) => void;
}

export class Hud {
  mode: GameMode;
  onBuy: (item: ShopItemId) => void;
  buyOpen: boolean;
  bannerT: ReturnType<typeof setTimeout> | undefined;
  shopHintDone = false; // set on first purchase; retires the armory hints
  slotSig = '';         // last-rendered weapon-slot signature, see update()
  winded = false;       // sticky until stamina recovers past the sprint threshold
  perfFps = -1;         // last-rendered perf numbers, see perf()
  perfPing = -1;
  centerHtml: string | null = null; // last-rendered centre overlay, see centerMsg()

  constructor(mode: GameMode, { onAddBot, onRemoveBot, onBuy }: HudHandlers) {
    this.mode = mode;
    this.onBuy = onBuy;
    this.buyOpen = false;
    this.bannerT = undefined;
    $('hud').classList.remove('hidden');
    $('menu').classList.add('hidden');
    if (mode === 'zombie') $('points').classList.remove('hidden');

    // bot buttons. On touch the list collapses behind a single toggle: at
    // right/50% the expanded stack sits exactly under the aim thumb.
    const bar = $('botbar');
    bar.innerHTML = '';
    bar.classList.remove('open');
    const toggle = document.createElement('button');
    toggle.className = 'bb-toggle';
    toggle.textContent = 'BOTS';
    toggle.onclick = (e) => { e.preventDefault(); bar.classList.toggle('open'); toggle.blur(); };
    bar.appendChild(toggle);
    const botList = document.createElement('div');
    botList.className = 'bb-list';
    bar.appendChild(botList);
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = (e) => { e.preventDefault(); fn(); b.blur(); };
      botList.appendChild(b);
    };
    if (mode === 'tdm') {
      btn('+ BOT ALLY', () => onAddBot('mine'));
      btn('+ BOT ENEMY', () => onAddBot('enemy'));
      btn('− BOT ALLY', () => onRemoveBot('mine'));
      btn('− BOT ENEMY', () => onRemoveBot('enemy'));
    } else {
      btn('+ BOT SQUADMATE', () => onAddBot('mine'));
      btn('− BOT SQUADMATE', () => onRemoveBot('mine'));
    }

    // buy items
    const list = $('buy-items');
    list.innerHTML = '';
    BUY_ITEMS.forEach((item, i) => {
      const row = document.createElement('div');
      row.dataset.key = item.key;
      const isWeapon = item.key !== 'ammo' && item.key !== 'health';
      const ico = isWeapon ? weaponIconHtml(item.key as WeaponId) : '';
      row.innerHTML = `<span><span class="num">${i + 1}</span>${ico}${item.label}</span>` +
        `<span class="cost">$${SHOP[item.key].cost}</span>`;
      row.onclick = () => onBuy(item.key);
      list.appendChild(row);
    });
  }

  toggleBuy(force?: boolean): void {
    if (this.mode !== 'zombie') return;
    this.buyOpen = force !== undefined ? force : !this.buyOpen;
    $('buymenu').classList.toggle('hidden', !this.buyOpen);
  }

  update(snap: Snapshot, self: SelfSnap | null, myId: number, stamina = 100): void {
    const me = snap.players.find(p => p.id === myId);
    // topbar
    const top = $('topbar');
    if (snap.mode === 'tdm') {
      const mins = Math.floor(snap.timeLeft / 60), secs = snap.timeLeft % 60;
      top.innerHTML = `<span class="red">${snap.scores[0]}</span>` +
        `<span class="timer">${mins}:${String(secs).padStart(2, '0')}</span>` +
        `<span class="blue">${snap.scores[1]}</span>`;
    } else {
      const status = snap.breakT > 0
        ? `<span class="zleft">next wave in ${snap.breakT}s</span>`
        : `<span class="zleft">${snap.left} remaining</span>`;
      top.innerHTML = `<span class="wave">WAVE ${snap.wave}</span>${status}`;
    }
    if (!me || !self) return;

    // health
    $('healthbar').style.width = Math.max(0, me.hp) + '%';
    $('healthbar').style.background = me.hp > 40
      ? 'linear-gradient(90deg,#3fae5a,#59d97c)' : 'linear-gradient(90deg,#c0392b,#e8483f)';
    $('healthnum').textContent = String(Math.max(0, me.hp));
    const sb = $('stambar');
    sb.style.width = Math.max(0, Math.min(100, stamina)) + '%';
    sb.classList.toggle('low', stamina < 20);
    if (stamina <= 1) this.winded = true;
    else if (stamina >= STAMINA_MIN_TO_SPRINT) this.winded = false;
    $('winded').classList.toggle('hidden', !this.winded || !me.alive);
    $('vignette').style.opacity = String(me.alive ? Math.max(0, (1 - me.hp / 100) - 0.15) : 0.5);
    if (this.mode === 'zombie') {
      $('points').textContent = '$' + self.points;
      $('shophint').classList.toggle('hidden', this.shopHintDone || !me.alive);
    }

    // ammo + slots
    const cur = self.ammo[self.slot];
    $('mag').textContent = cur ? String(cur.mag) : '-';
    $('reserve').textContent = cur ? '/ ' + cur.reserve : '';
    const needReload = !!cur && cur.mag === 0 && cur.reserve > 0 && self.reloadT <= 0;
    $('reloadhint').classList.toggle('hidden', !needReload || !me.alive);
    // Rebuild only on change: the rows now contain <img> icons, and recreating
    // them every frame would thrash layout/decode 60x a second.
    const sig = `${self.slots.join(',')}|${self.slot}`;
    if (sig !== this.slotSig) {
      this.slotSig = sig;
      $('weapon-slots').innerHTML = self.slots.map((w, i) =>
        `<span class="${i === self.slot ? 'active' : ''}">${i + 1} ${weaponIconHtml(w)}${WEAPONS[w].name}</span>`).join('');
    }
    const rw = $('reloadwrap');
    if (self.reloadT > 0) {
      rw.classList.remove('hidden');
      $('reloadbar').style.width = (100 * (1 - self.reloadT / self.reloadTotal)) + '%';
    } else rw.classList.add('hidden');

    // buy menu affordability
    if (this.buyOpen) {
      document.querySelector('#buymenu .bm-pts')!.textContent = '$' + self.points;
      for (const row of $('buy-items').children) {
        const key = (row as HTMLElement).dataset.key as ShopItemId;
        const owned = (key !== 'ammo' && key !== 'health') && self.slots.includes(key);
        row.classList.toggle('owned', owned);
        row.classList.toggle('cant', !owned && self.points < SHOP[key].cost);
      }
    }
  }

  // FPS/ping readout. Text is only touched when a value actually changes —
  // this runs every frame and both numbers are updated on ~0.5s/1s timers.
  perf(fps: number, ping: number): void {
    if (fps !== this.perfFps) {
      this.perfFps = fps;
      const el = $('perf-fps');
      el.textContent = `${fps} FPS`;
      el.className = fps < 30 ? 'bad' : (fps < 50 ? 'warn' : '');
    }
    if (ping !== this.perfPing) {
      this.perfPing = ping;
      const el = $('perf-ping');
      el.textContent = ping > 0 ? `${ping} ms` : '— ms';
      el.className = ping >= 150 ? 'bad' : (ping >= 80 ? 'warn' : '');
    }
  }

  killfeed(html: string): void {
    const feed = $('killfeed');
    const div = document.createElement('div');
    div.innerHTML = html;
    feed.prepend(div);
    while (feed.children.length > 6) feed.lastChild!.remove();
    setTimeout(() => div.remove(), 5000);
  }

  banner(text: string, ms = 2200): void {
    const b = $('banner');
    b.textContent = text;
    b.style.opacity = '1';
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => { b.style.opacity = '0'; }, ms);
  }

  // Called every frame. Only rewrites on change — the death screen embeds
  // tappable loadout buttons, and re-parsing the HTML 60x a second would
  // recreate them mid-press.
  centerMsg(html: string | null): void {
    const c = $('center-msg');
    if (html === this.centerHtml) return;
    this.centerHtml = html;
    if (html) { c.innerHTML = html; c.classList.remove('hidden'); }
    else c.classList.add('hidden');
  }

  hitflash(): void {
    const h = $('hitflash');
    h.style.transition = 'none';
    h.style.opacity = '1';
    requestAnimationFrame(() => {
      h.style.transition = 'opacity .35s';
      h.style.opacity = '0';
    });
  }

  scoreboard(snap: Snapshot, myId: number, show: boolean): void {
    const sb = $('scoreboard');
    sb.classList.toggle('hidden', !show);
    if (!show) return;
    const row = (p: PlayerSnap) => `<tr class="t${p.team} ${p.id === myId ? 'me' : ''}"><td>${p.name}${p.bot ? ' 🤖' : ''}</td>` +
      `<td>${p.k}</td><td>${p.d}</td></tr>`;
    const head = '<tr><th>PLAYER</th><th>K</th><th>D</th></tr>';
    if (snap.mode === 'tdm') {
      const red = snap.players.filter(p => p.team === TEAM.RED).sort((a, b) => b.k - a.k);
      const blue = snap.players.filter(p => p.team === TEAM.BLUE).sort((a, b) => b.k - a.k);
      sb.innerHTML = `<table><tr><td class="hdr" style="color:#ff8b81">RED — ${snap.scores[0]}</td></tr></table>` +
        `<table>${head}${red.map(row).join('')}</table>` +
        `<table><tr><td class="hdr" style="color:#8ebbff">BLUE — ${snap.scores[1]}</td></tr></table>` +
        `<table>${head}${blue.map(row).join('')}</table>`;
    } else {
      const all = [...snap.players].sort((a, b) => b.k - a.k);
      sb.innerHTML = `<table><tr><td class="hdr" style="color:#9fe870">SURVIVORS — WAVE ${snap.wave}</td></tr></table>` +
        `<table>${head}${all.map(row).join('')}</table>`;
    }
  }
}
