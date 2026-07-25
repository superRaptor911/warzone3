// Headless high-latency harness: boots a real server and drives ws clients
// through a delay/loss shim, so the failure modes that only appear at 200-300ms
// RTT are testable without a phone on a train.
//
// The shim delays the *game* messages rather than emulating TCP. That is the
// right level: we are testing prediction, interpolation and lag compensation,
// not congestion control. Precise assertions about the sim (carry-over amounts,
// rewind geometry) live in test/matchflow.ts where the world is deterministic;
// this file covers the end-to-end properties that only a real socket shows.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { INTERP_DELAY_MS, STAMINA_DRAIN } from '../shared/constants.ts';
import type { GameEvent, Snapshot, TdmSnapshot, WelcomeMsg, ZombieSnapshot } from '../shared/types.ts';

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---- server ----
const PORT = 3198;
const srv = spawn(process.execPath, ['server/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr!.on('data', d => { srvErr += d; });
await new Promise<void>((res, rej) => {
  srv.stdout!.on('data', d => { if (String(d).includes('listening')) res(); });
  srv.on('exit', () => rej(new Error('server exited early: ' + srvErr)));
  setTimeout(() => rej(new Error('server start timeout: ' + srvErr)), 5000);
});
console.log(`server up on :${PORT}`);

// ---- delay/loss shim ----
interface LinkOpts {
  oneWayMs: number;  // applied in each direction, so RTT is 2x this
  loss: number;      // 0..1, applied per message in each direction
}

class Link<S extends Snapshot> {
  ws: WebSocket;
  opts: LinkOpts;
  welcome: WelcomeMsg | null = null;
  clockOffset: number | null = null;
  snaps: S[] = [];
  events: GameEvent[] = [];
  arrivals: number[] = [];   // perf-clock receipt time of each snapshot
  stalled = false;
  held: { s: string; lossy: boolean }[] = [];
  dropped = { up: 0, down: 0 };

  constructor(joinMsg: object, opts: LinkOpts) {
    this.opts = opts;
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.ws.on('open', () => this.send(joinMsg));
    this.ws.on('message', (buf) => {
      let m: any;
      try { m = JSON.parse(String(buf)); } catch { return; }
      // Loss applies to the state stream only. Handshake and control messages
      // are delivered reliably by TCP in the real system, and dropping the
      // welcome would just make the harness flaky rather than realistic.
      if (m.t === 'snap' && Math.random() < this.opts.loss) { this.dropped.down++; return; }
      setTimeout(() => this.recv(m), this.opts.oneWayMs);
    });
    this.ws.on('error', () => { /* close is enough */ });
  }

  private recv(m: any): void {
    if (m.t === 'welcome') this.welcome = m;
    else if (m.t === 'snap') {
      this.snaps.push(m);
      this.arrivals.push(performance.now());
      // Same EMA as GameState.addSnapshot. Measured here, after the shim's
      // delay, so the offset absorbs the link latency exactly as it would live.
      const off = m.now - performance.now();
      this.clockOffset = this.clockOffset === null ? off : this.clockOffset * 0.9 + off * 0.1;
      for (const e of m.events) this.events.push(e);
    }
  }

  // Mirrors GameState.renderTime(): the server-clock instant this client is
  // rendering, which is what gets reported as `rt` for lag compensation.
  renderTime(): number {
    return this.clockOffset === null ? 0 : performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  send(obj: object): void {
    const s = JSON.stringify(obj);
    const lossy = (obj as { t?: string }).t === 'input';
    if (this.stalled) { this.held.push({ s, lossy }); return; }   // upstream blocked
    this.up(s, lossy);
  }

  private up(s: string, lossy = true): void {
    if (lossy && Math.random() < this.opts.loss) { this.dropped.up++; return; }
    setTimeout(() => { if (this.ws.readyState === 1) this.ws.send(s); }, this.opts.oneWayMs);
  }

  // Simulate the client's socket buffering during a stall and flushing at once.
  stall(): void { this.stalled = true; }
  resume(): void {
    this.stalled = false;
    for (const h of this.held) this.up(h.s, h.lossy);
    this.held = [];
  }

  latest(): S { return this.snaps[this.snaps.length - 1]; }
  me(): TdmSnapshot['players'][number] | undefined {
    return this.latest()?.players.find(p => p.id === this.welcome!.id);
  }
  close(): void { this.ws.close(); }
}

// ---- 1. a 250ms link is usable at all ----
console.log('link: 250ms RTT, no loss');
let seq = 0;
{
  const a = new Link<TdmSnapshot>(
    { t: 'join', name: 'Laggy', mode: 'tdm', primary: 'rifle' }, { oneWayMs: 125, loss: 0 });
  await sleep(900);
  check(a.welcome !== null, 'welcome survives the delay');
  check(a.snaps.length > 5, `snapshots flowing (${a.snaps.length} in ~750ms of link time)`);

  const before = a.me()!;
  const mover = setInterval(() => {
    a.send({ t: 'input', seq: ++seq, dt: 0.033, keys: { d: 1 }, aim: 0, fire: false, sprint: false });
  }, 33);
  await sleep(1500);
  clearInterval(mover);
  await sleep(500); // let the tail arrive and come back
  const after = a.me()!;
  check(Math.hypot(after.x - before.x, after.y - before.y) > 40,
    `player moves normally at 250ms (${Math.hypot(after.x - before.x, after.y - before.y).toFixed(0)}px)`);
  check(a.latest().ack! > 0 && a.latest().ack! <= seq, `inputs acked (ack=${a.latest().ack}/${seq})`);

  // snapshot cadence should stay ~66.7ms; steady latency must not disturb it
  const gaps: number[] = [];
  for (let i = 1; i < a.arrivals.length; i++) gaps.push(a.arrivals[i] - a.arrivals[i - 1]);
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  check(median > 50 && median < 90, `snapshot cadence holds under delay (median gap ${median.toFixed(0)}ms)`);
  a.close();
  await sleep(200);
}

// ---- 2. an upstream stall must not lose the burst ----
// The precise accounting is unit-tested in matchflow.ts; here we only assert
// the end-to-end consequence: a stalled client ends up close to where an
// unstalled one does, rather than hundreds of ms behind.
console.log('link: 400ms upstream stall');
{
  const opts: LinkOpts = { oneWayMs: 125, loss: 0 };
  const ctl = new Link<TdmSnapshot>({ t: 'join', name: 'Ctl', mode: 'tdm', primary: 'rifle' }, opts);
  const stl = new Link<TdmSnapshot>({ t: 'join', name: 'Stl', mode: 'tdm', primary: 'rifle' }, opts);
  await sleep(900);
  check(ctl.welcome !== null && stl.welcome !== null, 'both clients joined');

  // Stamina, not position, is the yardstick here: tickSprint drains per unit of
  // *simulated* dt whether or not the player actually moves, so a spawn point
  // that happens to face a wall cannot skew the comparison. Stamina also only
  // changes inside applyInput, so it is a direct readout of how much of each
  // client's input stream the server actually simulated.
  const c0 = ctl.latest().self!.stam, s0 = stl.latest().self!.stam;
  let n = 0;
  const drive = setInterval(() => {
    n++;
    const msg = { dt: 0.033, keys: { d: 1 }, aim: 0, fire: false, sprint: true };
    ctl.send({ t: 'input', seq: ++seq, ...msg });
    stl.send({ t: 'input', seq: ++seq, ...msg });
    if (n === 15) stl.stall();        // ~500ms in
    if (n === 27) stl.resume();       // ~400ms of held input flushes at once
  }, 33);
  await sleep(1800);
  clearInterval(drive);
  await sleep(700); // let the banked backlog drain and the snapshot come back

  const cd = c0 - ctl.latest().self!.stam;
  const sd = s0 - stl.latest().self!.stam;
  check(cd > 20, `control client simulated ~${(cd / STAMINA_DRAIN).toFixed(2)}s of input`);
  // Measured: 0.97 with carry-over, 0.81 without (the tail used to be acked and
  // dropped). 0.92 separates them with margin at both ends.
  check(sd > cd * 0.92,
    `stalled client kept up after the flush (${sd.toFixed(1)} vs ${cd.toFixed(1)} stamina drained)`);
  ctl.close(); stl.close();
  await sleep(200);
}

// ---- 3. 250ms + 2% loss stays connected and coherent ----
console.log('link: 250ms RTT, 2% loss');
{
  const a = new Link<TdmSnapshot>(
    { t: 'join', name: 'Lossy', mode: 'tdm', primary: 'rifle' }, { oneWayMs: 125, loss: 0.02 });
  await sleep(900);
  check(a.welcome !== null, 'joined over a lossy link');
  for (let i = 0; i < 4; i++) a.send({ t: 'addBot', team: 'enemy' });

  const mover = setInterval(() => {
    a.send({ t: 'input', seq: ++seq, dt: 0.033, keys: { d: 1 }, aim: seq * 0.05, fire: seq % 12 < 5, sprint: false });
  }, 33);
  await sleep(2500);
  clearInterval(mover);
  await sleep(500);

  check(a.snaps.length > 20, `snapshots kept arriving (${a.snaps.length}, ${a.dropped.down} dropped)`);
  check(a.events.some(e => e.e === 'shot'), 'shots resolved despite loss');
  // monotonic tick order: a dropped snapshot must not reorder the rest
  let ordered = true;
  for (let i = 1; i < a.snaps.length; i++) if (a.snaps[i].tick <= a.snaps[i - 1].tick) ordered = false;
  check(ordered, 'snapshots stay in tick order through loss');
  const last = a.latest();
  check(last.players.every(p => p.hp >= 0 && p.hp <= 100), 'world state stays coherent');
  a.close();
  await sleep(200);
}

// ---- 4. lag compensation over the wire ----
// The geometry of the rewind is unit-tested deterministically in matchflow.ts.
// What only a real socket can show is that `rt` survives the trip and that the
// server stays sane when a client lies about it. Bot movement is random, so the
// with/without hit counts are reported rather than asserted — a hard threshold
// there would be flaky, not rigorous.
// Outbreak, not TDM: zombies walk to the player, so contact and line of sight
// are guaranteed. In TDM both sides sit at opposite spawns behind walls and
// never meet — which is why smoke.ts's combat check carries an
// "or nobody met yet" escape hatch.
console.log('lag compensation: 250ms RTT (Outbreak)');
{
  const opts: LinkOpts = { oneWayMs: 125, loss: 0 };
  const mk = (name: string) => new Link<ZombieSnapshot>({ t: 'join', name, mode: 'zombie' }, opts);
  const all = [
    { link: mk('Comp'), rt: 'real' as const },
    { link: mk('Raw'), rt: 'none' as const },
    { link: mk('Bad'), rt: 'hostile' as const },
  ];
  await sleep(900);
  check(all.every(c => c.link.welcome !== null), 'three clients joined Outbreak');

  let n = 0, hostileToggle = 0;
  const fire = setInterval(() => {
    n++;
    for (const c of all) {
      const snap = c.link.latest();
      if (!snap) continue;
      const me = snap.players.find(p => p.id === c.link.welcome!.id);
      if (!me || !me.alive || !snap.zombies.length) continue;
      let best = snap.zombies[0], bd = Infinity;
      for (const z of snap.zombies) {
        const d = Math.hypot(z.x - me.x, z.y - me.y);
        if (d < bd) { bd = d; best = z; }
      }
      // Stand still and let the zombies come. This client has no prediction of
      // its own position, so while moving it would compute `aim` from a 250ms
      // stale origin and miss by ~10 degrees — an artefact of the harness, not
      // of the server. Stationary, the snapshot position is exact.
      const msg: Record<string, unknown> = {
        t: 'input', seq: ++seq, dt: 0.033, keys: {},
        // Aim at the nearest zombie's last known position — exactly the stale
        // view the compensation exists to correct for.
        aim: Math.atan2(best.y - me.y, best.x - me.x),
        // The starting pistol is semi-auto and the server edge-detects fire via
        // firePrev, so a held flag would fire exactly one round all test.
        fire: n % 2 === 0,
        sprint: false,
      };
      // `rt` must describe the same instant the aim was computed from, or
      // compensation actively hurts. The real client aims at interpolated
      // render-time positions and reports renderTime() to match; this client
      // aims straight at the newest snapshot, so its render time is that
      // snapshot's own timestamp.
      if (c.rt === 'real') msg.rt = snap.now;
      else if (c.rt === 'hostile') {
        // untrusted field: a future claim, an ancient one, and non-numbers
        msg.rt = [c.link.renderTime() + 60_000, 1, null, 'nope', NaN][hostileToggle++ % 5];
      }
      c.link.send(msg);
    }
  }, 33);

  // 10s wave break, then the zombies have to walk all the way in to us
  await sleep(32000);
  clearInterval(fire);
  await sleep(600);

  const hits = (l: Link<ZombieSnapshot>) =>
    l.events.filter(e => e.e === 'hit' && e.sid === l.welcome!.id).length;
  const shots = (l: Link<ZombieSnapshot>) =>
    l.events.filter(e => e.e === 'shot' && e.id === l.welcome!.id).length;
  for (const c of all) {
    console.log(`  info: rt=${c.rt.padEnd(7)} fired ${shots(c.link)}, hit ${hits(c.link)}`);
  }
  // Deliberately NOT compared against each other. Measured with all three
  // clients on an identical policy, per-client hits came out 4 / 11 / 5 — the
  // spread is the spawn and zombie-routing lottery, not the rt policy, so any
  // A/B read off these numbers would be noise. Whether the rewind geometry is
  // correct is settled deterministically in matchflow.ts; what this scenario
  // can honestly show is that all three rt policies keep the pipeline working.
  const totalShots = all.reduce((n, c) => n + shots(c.link), 0);
  const totalHits = all.reduce((n, c) => n + hits(c.link), 0);
  check(all.every(c => shots(c.link) > 0), 'every rt policy still lets the client fire');
  check(totalHits > 0, `shots land at 250ms (${totalHits} hits from ${totalShots} shots)`);
  check(srvErr.trim() === '', 'server logged no errors on hostile or garbage rt');
  for (const c of all) c.link.close();
  await sleep(300);
}

srv.kill();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
if (srvErr.trim()) console.error('server stderr:\n' + srvErr);
process.exit(failures === 0 ? 0 : 1);
