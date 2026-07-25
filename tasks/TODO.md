# TODO — remaining latency work (200–300ms RTT)

Two steps left from the "playable at 200–300ms" plan. Steps 1–4 are done and on disk;
this file is the handover for 5 and 6.

## Done already (context)

| Step | What | Where |
|---|---|---|
| 1 | Latency/loss harness — delay+loss shim over a real ws client | `test/latency.ts`, `npm run test:latency` |
| 2 | Input carry-over — banked, not discarded; fixes the sprint rubber-band | `server/room.ts` `update()` / `trimBacklog` |
| 3 | Server hit rewind, `MAX_REWIND_MS = 400` | `server/room.ts` `recordHistory`/`rewindFrame`/`rewindFrameFor`/`rewindTargets` |
| 4 | Predicted reload + switch-lockout fire gate | `client/js/reload.ts`, `SelfSnap.sw` |

Verify with `npm test`, `npm run test:latency`, `npm run test:touch` — all three green as of
this writing.

---

## 1. Adaptive interpolation delay

**File:** `client/js/state.ts` (plus a pure helper for tests)

`INTERP_DELAY_MS` is a fixed 130ms (`shared/constants.ts:8`), used only by
`GameState.renderTime()`. It has to absorb jitter, and 130ms against a 66.7ms snapshot
interval leaves only ~63ms of headroom before the client runs out of future snapshots and
starts extrapolating (the `Math.min(1.3, …)` clamp in `state.ts:97` buys ~20ms more, then
remote entities visibly stall).

**Why now and not before:** with step 3 landed, buffer depth no longer costs aim accuracy —
the server rewinds to whatever the client actually rendered. Before rewind, raising the
delay would have directly worsened the lead requirement. It is now free.

**Do:**

- Track snapshot inter-arrival gaps in `addSnapshot`. Derive the delay from a decaying max
  over ~3s rather than a mean — the tail is what causes visible stalls, not the average.
- Clamp to roughly `[100, 300]`ms. Keep `INTERP_DELAY_MS` as the floor/default.
- Put the estimator in a **pure exported function** so `test/matchflow.ts` can drive it
  under Node with synthetic gap sequences. Same convention as `view.ts` and `stick.ts`;
  `client/js/reload.ts` (step 4) is the most recent example of the shape.
- `renderTime()` then uses the adaptive value. Nothing else changes: the client already
  reports its real render time as `rt`, so the rewind tracks it with no extra coupling.

**⚠ Cross-cutting:** `MAX_REWIND_MS = 400` was sized as `RTT + INTERP_DELAY_MS + ~16ms`
tick quantization. If the adaptive delay reaches 300ms, a 250ms-RTT client needs ~570ms of
rewind and the cap under-compensates again. Either raise the cap alongside it, or accept
partial compensation on jittery links. `HISTORY_FRAMES = 12` (≈800ms at 15Hz) has headroom
for the former; raise it too if the cap goes past ~600ms.

**Verify:** pure unit tests on the estimator (steady link → floor; a burst of late
snapshots → delay rises; recovery → decays back). The `test/latency.ts` 2%-loss scenario is
the integration check.

---

## 2. Binary snapshot encoding

**File:** `shared/wire.ts` (new), consumed by `server/room.ts` `broadcast()` and
`client/js/net.ts`

Measured today (via a throwaway script constructing real rooms):

| | JSON now | binary est. |
|---|---|---|
| TDM, 10 players | 1558 B → 23 KB/s | ~225 B → ~3.4 KB/s |
| Outbreak, 5 players + 26 zombies | 2972 B → 44 KB/s | ~550 B → ~8 KB/s |

**41% of every Outbreak snapshot is lifetime-static** (`name`/`team`/`bot` on players,
`type`/`maxHp` on zombies) re-sent 15× a second. This targets packet loss and bufferbloat
on constrained uplinks rather than latency directly — self-inflicted queuing delay is
probably a bigger contributor to a bad mobile link than retransmits are.

**Two decisions that defuse the "every protocol change touches the codec" risk:**

- **Only the `snap` message.** `welcome`, `join`, `input`, `ping`/`pong` and all control
  messages stay JSON. Keeping `input` as JSON also leaves the untrusted-validation story
  in `server/index.ts` untouched.
- **Events stay JSON**, appended as a length-prefixed UTF-8 tail inside the same binary
  frame. `GameEvent` has 14 variants and is the highest-churn part of the protocol; it is
  also usually empty. One frame, and adding an event needs no codec work.

**Also add a JSON fallback:** `{t:'join', …, json:1}` makes the server send JSON snapshots
to that client. This is worth more than it looks — `test/smoke.ts` and `test/latency.ts`
then need one flag added rather than a rewrite, devtools stay readable, and it enables a
**differential test**: run the same scenario both ways and assert the decoded snapshots
match. That differential is the real correctness net for the codec.

**Layout.** `WIRE_VERSION` byte first; the client shows "reload the page" on mismatch.
That matters more here than in most codebases — there is no build step, so a stale tab
would otherwise silently decode garbage.

| Field | Type | Note |
|---|---|---|
| `id` | u32 | `newId()` is a global counter and zombies churn constantly; u16 **would wrap** |
| `x`, `y` | u16 | 0.1px units. Largest map is outbreak at 2112×1632px; 2112×10 = 21120 < 65535, so this is **lossless vs today's `Math.round(x*10)/10`** |
| `aim` | u16 | u16 for players and zombies alike — consistency beats saving 26 bytes |
| player `hp` | u8 | zombie `hp`/`maxHp` need u16 (brute at wave scaling reaches ~768) |
| `w` | u8 | index into an explicit ordered tuple in `wire.ts`; **that order must never change** |
| flags | u8 | `alive`/`rld`/`prot`/`bot`; `fr` for zombies |
| `now` | u32 | ms relative to a room epoch sent in `welcome` |

Add a startup assert that `grid.pxW() * 10 < 65536`, so a future larger map fails loudly
instead of wrapping.

**Statics off the snapshot:** a JSON `roster` message (id → `name`/`team`/`bot`) sent right
after `welcome` and on any roster change. Zombie `type`/`maxHp` stay inline — zombies churn
far too fast for a roster to help.

**Delete the dead `spr` field** while here. Written at `server/room.ts` `playerSnapshot()`,
read nowhere on the client (the `spr` in `client/js/main.ts` is an unrelated local in the
gun mirror). ~1.2 KB/s of pure waste.

**Perf:** encode the shared prefix once per `broadcast()` and append each client's
`ack`/`self`/events, rather than encoding ten times.

**Verify:** round-trip property tests in `matchflow.ts` (encode/decode random snapshots of
both modes, assert deep equality; assert a `WIRE_VERSION` bump is rejected), plus the
binary-vs-JSON differential in `test/latency.ts`.

---

## Notes / gotchas carried forward

- **`rt` must describe the same instant the aim was computed from.** If a client aims at
  the newest snapshot but reports an interpolated render time (or vice versa), lag
  compensation actively *hurts*. The real client is consistent — it aims at
  `state.interpolated()` positions and reports `renderTime()`. Cost me a debugging detour
  in the harness; do not break that pairing.
- **Do not A/B hit counts in Outbreak.** Ran three clients with identical `rt` policies and
  got 4 / 11 / 5 hits — the spread is the spawn and zombie-routing lottery, not the policy.
  Rewind correctness belongs in `matchflow.ts`, where the world is deterministic.
- **Position is not a valid yardstick in `test/latency.ts`.** Spawns face different walls.
  Use stamina: `tickSprint` drains per unit of *simulated* dt whether or not the player
  actually moves, and only inside `applyInput`.
- **In TDM the two sides never meet** at their spawns, which is why `smoke.ts`'s combat
  check carries an "or nobody met yet" escape hatch. Use Outbreak for anything needing
  reliable contact.
