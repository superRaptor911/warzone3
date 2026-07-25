# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm start                 # serve game on http://localhost:3000 (env PORT overrides)
npm test                  # tsc type check, then both test files in order
npm run check             # type check only (tsc --noEmit)
node test/matchflow.ts    # fast: room-level unit tests (no network)
node test/smoke.ts        # slower (~30s): boots a real server on port 3199, drives ws clients through both modes
npm run test:touch        # optional (~2min): drives the real client in headless Chrome over CDP — real touch
                          # points on the pads, an auto-fire pass that waits out a wave for live contact,
                          # a rotate-then-quit-then-rejoin lifecycle pass (which measures screen brightness,
                          # the only way those renderer bugs are visible), and a desktop regression pass.
                          # Skips (exit 0) with no Chrome.
npm run vendor            # re-copy pixi.js / pixi-filters ESM builds into client/vendor/ (run after upgrading them)
# http://localhost:3000/atlas-preview.html   eyeball every baked sprite frame/tint/rotation + hitbox rings
# http://localhost:3000/touch-preview.html   live pads + input dump (real Touch/stick modules) for tuning feel
```

No build step, no lint. Everything is TypeScript executed directly: Node (≥22.18) runs
`.ts` files natively via type stripping, and the server strips types on the fly
(`stripTypeScriptTypes` from `node:module`) when serving `client/` and `shared/` files to
the browser — edit a client file, refresh the tab. Server changes require restarting
`npm start`. `tsc` never emits; it is purely a checker.

Tests print `ok:`/`FAIL:` lines and exit non-zero on failure. There is no test framework; add checks with the local `check(cond, msg)` helper.

## TypeScript rules

- **Erasable syntax only** (`erasableSyntaxOnly` in tsconfig): no enums, no namespaces,
  no parameter properties. Types must strip to whitespace — this is what lets Node and
  the dev server run the sources without a compile step.
- Relative import specifiers use explicit `.ts` extensions (`import { x } from './y.ts'`)
  — required by Node's loader; the browser receives them stripped and re-requests the
  `.ts` URLs, which the server serves as `text/javascript`.
- `shared/types.ts` holds the wire protocol (snapshots, events, input messages) and must
  stay type-only — it strips to nothing, and every import of it is `import type`.
- Client files import shared code via relative paths (`../../shared/…`), which resolve
  identically for tsc, Node, and the browser.

## Architecture

Multiplayer top-down shooter: authoritative Node server (`ws` is the only runtime dependency), canvas client, two modes (5v5 TDM, co-op zombie survival), server-side bots.

### The shared-simulation contract (most important invariant)

`shared/` is imported by **both** the Node server and the browser (served with types stripped at `/shared/`). The client predicts its own movement by replaying unacked inputs through the exact same code the server runs:

- `shared/physics.ts` — `stepMove` (movement + tile collision) and `tickSprint` (stamina). Any change to how players move **must** live here, not in server- or client-only code, or prediction desyncs and players rubber-band.
- `shared/maps.ts` — `Grid` (tile queries, DDA raycast, LOS) and programmatic map builders. Maps are built with code (border/hollowRect/door/crate helpers), never hand-drawn ASCII; `test/smoke.ts` flood-fills every map to assert full connectivity — run it after any map edit.
- `shared/weapons.ts`, `shared/constants.ts` — tuning values used by both sides.
- `shared/hitscan.ts` — `rayCircle` / `castPellet` (one pellet vs walls **and** body circles). The server resolves real hits with it and the client's local tracer mirror ends its tracers with it, so a predicted tracer stops on the same flesh the shot hits.
- `shared/types.ts` — protocol/snapshot/entity types (type-only, see above).

Client-side, `client/js/state.ts` (`simStep`) mirrors server `applyInput` movement. If you add input-affected state (like stamina), it must: (1) live in shared code, (2) be replicated in the snapshot `self` block, (3) be restored in `GameState.addSnapshot` before replay.

### Server (`server/`)

`room.ts` holds the base `Room`: 30Hz tick, per-player input queue with a dt budget (anti-speedhack), hitscan resolution, damage/kill bookkeeping, and 15Hz personalized snapshots (`base` object mutated per client with `ack` + `self`). Mode rooms subclass it and override hooks: `addPlayer`, `removeBot`, `fillBots`, `hitscanTargets`, `damageTarget`, `onPlayerDeath`, `modeUpdate`, `respawn`, `inputAllowed`, `modeSnapshot`, and the bot hooks (`botEnemies`, `botGoal`, `botGoalReached`, `botThreat`). The base class defines them as no-op stubs (or optional methods) so `botThink` and matchmaking can call them mode-agnostically.

- `tdm.ts` — teams, score/time limits, spawn selection, match restart, bot eviction when a human joins a full team.
- **The bot roster is a property of the room, chosen at creation and never edited in-game.** A `join` carries `bots`, but `index.ts` honors it only when that join *created* the room (the rule `applyCheckpoint` already used) — a later joiner inherits the match instead of reshaping someone else's. `Room.botTarget` holds it and `fillBots()` applies it: per team in TDM, total squad size in zombie, both capped by the mode's own maximum and both breaking on `addPlayer` returning null so an over-large target can't spin. `fillBots` runs again from `leaveRoom` whenever a human departs, because a human joining a full team *evicts* a bot to get in — without the refill the roster only ever decays. There is deliberately no `addBot`/`removeBot` message: hiding the buttons but leaving the path live would be the same feature with worse discoverability.
- **Supply crates are Outbreak-only floor loot** (`Pickup` in `entities.ts`, placed and collected in `zombie.ts`). They carry the shop's own two effects at full strength — `refillAmmo` and a full heal — so scarcity is the entire balance: `PICKUPS_PER_WAVE` (2) placed at each `startWave` on random floor tiles at least `PICKUP_SPAWN_CLEAR` (400px) from every survivor spawn, accumulating to `MAX_PICKUPS` (4) because uncollected ones persist, and cleared by `resetGame`. The spot pool is precomputed in the constructor, like TDM's `openLeft/openRight`. **Humans only**: bots walk over them, since a squadmate spending a rare full refill it did not need is the one way the feature makes the game worse, and bots already buy at every wave break. A player who cannot use one leaves it standing (full health, full ammo) — the same silence-means-refusal shape as `buy`, which is why the `pick` event *is* the confirmation. Collection runs in every room state, so looting during the break is the reward for leaving the compound. Code says `pickup`, never `crate`: `shared/maps.ts` already has `T_CRATE` tiles, which are cover.
- `zombie.ts` — wave composition/scaling, zombie AI (direct steer on LOS else A*), shop, revive-on-wave-clear, squad-wipe reset, and **frenzy**: remaining ≤3 zombies or waveAge >75s ramps `z.effSpeed` above player walk speed (anti-kiting, paired with sprint stamina).
- `bot.ts` — bots are not special-cased in the sim: `botThink` emits the same input objects a client would send (`BotInput`), processed through the same pipeline. Skill knobs are `errBase`/`reaction` in `createBotController`.
- `entities.ts` — `Player`/`Zombie` interfaces and factories; `index.ts` — static serving (with on-the-fly type stripping), ws join/matchmaking (first room of the mode with human capacity), message routing. Wire input is parsed as `any` and validated where consumed. Rooms are destroyed when the last human leaves; bots never keep a room alive.

### Client (`client/js/`)

`main.ts` is the orchestrator; per frame it sends one input message and runs a **local gun-feel mirror** (muzzle flash/tracer/sound/cooldown/spread fired immediately) while the server remains authoritative for hits and ammo — hitmarkers/damage numbers come only from server events. Remote entities render 130ms in the past via snapshot interpolation (`INTERP_DELAY_MS`). Own `shot` events from the server are skipped (already predicted). UI is DOM (`hud.ts`), not canvas; sounds are WebAudio-synthesized in `audio.ts` and sprites are procedurally baked in `gfx/art.ts` (no image/audio assets shipped).

`view.ts` holds the viewport math — `zoomFor`, `resolutionFor`, `bloomFor`, `uiScaleFor`. It is **pure and DOM-free on purpose** so `test/matchflow.ts` can import it under Node; it is the only place that decides how much world fits on a screen.

### Touch (`client/js/touch.ts`, `client/js/stick.ts`)

Twin-stick: a fixed 8-way dpad on the left half, a floating aim stick on the right that steers only — **there is no fire control**, the gun goes off when the crosshair is on a body (see auto-fire below). Entirely client-side — mobile support adds **zero lines to `server/` or `shared/`**, and mobile and desktop share rooms.

- `stick.ts` is pure (no DOM/Pixi), like `view.ts`, so the parts that actually break are unit-tested: `stickKeys` quantises to eight equal 45° sectors — **exact parity with WASD**, which is the point, since `shared/physics.ts` normalises diagonals and would ignore an analog magnitude anyway.
- `tickFireCadence` is the load-bearing piece. `pistol`/`shotgun`/`sniper` are semi-auto and the server edge-detects fire via `firePrev`, so a held stick would fire **exactly one round**. The client pulses the flag at the weapon's own `fireIntervalMs`, the same trick `server/bot.ts` uses via `fireTick`. Rate stays rpm-bound, so it is parity with clicking, not a buff. Auto weapons bypass it entirely.
- **Aim assist (`client/js/assist.ts`) is a bounded angular pull, and its strength is derived rather than tuned.** A target's angular size falls as 1/distance while the thumb's noise floor does not: after the ease a finger still leaves ~2°, and a player subtends 12.9° at 150px but 2.4° at rifle range and 1.1° at sniper range — *narrower than the wobble*, so no steadiness holds a crosshair there. The pull is `err × (1 − |err|/ASSIST_CONE) × need`, where `need = ASSIST_NEED / angular width` — so it is near-total for the small errors wobble produces, a nudge for the large ones that mean the player is pointing elsewhere, ~0 at knife range and ~1 at sniper range. **The bound is analytic, not a clamp:** the shape peaks at `ASSIST_CONE / 4` (4.5°), which is why it provably cannot become a lock — a deliberate thumb always outvotes it. Range comes from the equipped weapon so a shot it helps with is one that could land; **LOS is mandatory** (never assist through a wall — that would hand mobile information `gfx/lights.ts` deliberately withholds); target choice has stickiness (`ASSIST_STICK_TOL/BONUS`) because an Outbreak swarm otherwise flips the pull's sign every frame. Active only while the stick is engaged, and touch-only — like the rest of mobile it adds **zero lines to `server/` or `shared/`**, since it only adjusts the angle the client was already going to send.
- **The aim angle is eased per frame, with tau scaled by deflection** (`tickAimSmooth`, `AIM_TAU_NEAR` 0.10s at `DEAD_ZONE` → `AIM_TAU_FAR` 0.01s at the rim). A floating stick's angular sensitivity is **1/radius**: 1px of thumb is 4.41° at 13px but 1.10° at 52px, so the 1–3px wander of a finger's contact centroid was ~13° of instant rotation near the origin. Easing suppresses that (noise is a *small* error that keeps reversing sign) without dulling a flick (a *large* error still crosses 90° in 33ms at the rim) — the tau scaling is what keeps the cure local, and the rim must stay ≈1:1. Three things are load-bearing: it eases the **wrapped error**, not the angles (a lerp from 179° to −179° spins 358° the wrong way); it runs from **`Touch.tick(dt)` in the frame loop**, never from a pointer event (`pointermove` stops firing when the finger holds still, which would park the aim short of its target forever); and a fresh touch **snaps** on its first angle *past the deadzone* — not on the touchdown frame, where `aimTarget` still holds the previous touch's angle. `touch.aim` is the eased value everyone reads (wire message included, so what you see is what you shoot); `touch.aimTarget` is the raw one, exposed for the preview page. This hides noise but adds no resolution — at 13px there are still only ~20 distinguishable 1px steps around the circle.
- **There is no fire button and no fire ring: the trigger is the crosshair** (`onTarget` in `assist.ts`). The gun fires when `|err| <= atan2(radius, distance) + effSpread` against the target the pull just chose — the target's own angular half-width, so the threshold is *derived*: it tracks distance, the radii in `shared/constants.ts` and bloom with no per-weapon table, and a shotgun is allowed its pellet arc while a sniper is not. It costs no second search, because the pull already found the target and now records its `half`. **Stateless on purpose** — no acquisition delay, no drop-out grace, no latch. A frame that fails simply does not fire and the next one may; `fireCd` server-side (mirrored by `gun.cd`) still bounds the rate, so flicker cannot outrun a desktop player holding the button. The whole stick travel is now aim, and `DEAD_ZONE` is the fire gate: **thumb on the pad is weapons free, lifting it is the ceasefire**, which is also what stops the client firing at a target the assist wasn't allowed to help with. Note the spread term means bloom *widens* the gate as accuracy drops — sustained fire sprays, deliberately, on the reading that at full bloom the rounds really do go that wide. `#astick.hot` is the only tell that an invisible trigger is pulled, so it is set from the frame loop and means **rounds are leaving the barrel** — an empty mag or a reload goes dark, which is exactly when the player is asking.
- `touch.ts` is only pointer plumbing. The overlay is at **z-index 9, below `#hud`** — `#hud` is `pointer-events:none` apart from its interactive children, so pad drags fall through while the armory and the topbar still take their own taps. Never raise it above the HUD.
- **SPRINT gates the wire flag on movement rather than clearing the toggle.** `tickSprint` drains stamina whenever the flag is set, moving or not, so a toggle left on would leak it; but clearing the toggle when you stop makes a pre-emptive tap impossible, because the cancel fires on the same frame as the press. It still clears on exhaustion or death.
- Keyboard and touch are both read whenever the pads are up, so a phone with a bluetooth keyboard works.
- Landscape is required (`#rotate` gate in portrait, sim keeps running underneath); the menu stays usable in portrait. Fullscreen, orientation lock and wake lock are requested from the mode-card tap (a user gesture) and are **all best-effort** — iPhone Safari ignores element fullscreen and orientation lock, so the layout must be correct without them.

### Rendering (`client/js/gfx/`, PixiJS v8 / WebGL)

`render.ts` is a facade re-exporting `Renderer`/`DrawView` from `gfx/renderer.ts`. Pixi is **vendored, not bundled**: `npm run vendor` copies the single-file ESM builds (`pixi.min.mjs`, `pixi-filters.mjs`) into `client/vendor/`, and an import map in `index.html` resolves the bare `pixi.js`/`pixi-filters` specifiers (tsc resolves types from the devDependencies). No build step; `client/vendor/` is outside tsconfig `include` on purpose.

- `gfx/renderer.ts` — the Pixi `Application` is a **page-lifetime singleton** (`main.ts` constructs a Renderer per `welcome`, reconnects included; re-initializing on the same canvas would leak WebGL contexts). `Renderer.create` is async (WebGL init) — `main.ts` guards event handlers against the ~1-frame gap. Pixi's ticker is stopped; `main.ts` owns the only rAF loop and `draw()` calls `app.render()` manually. `autoDensity: true` with a per-tier `resolution` means the backing store scales with DPR while `app.screen` stays in **CSS px** — every screen-space calculation (camera, crosshair, chevrons, stick→world) reads `renderer.screenW/screenH`, never `canvas.width`. **World zoom**: `draw()` sets `world`/`worldFx` scale to `renderer.zoom` (`zoomFor`, 1 on any viewport ≥1300×620, so desktop is unchanged) and every consumer of the world transform takes it — the camera clamp uses the *world* viewport size `screenW / zoom`, `lights.update` mirrors the scale, chevron range stays measured in world px, and `Text` (names, damage numbers) is counter-scaled by `1/zoom` to hold its pixel size. Zoom is cosmetic-plus-FOV only: light radii, `VIS_REACH` and chevron `REACH` are world constants, so two clients at different zooms have the same tactical information.
- `gfx/art.ts` — **all procedural sprite art** as pure Canvas2D draw functions with no Pixi import, so the same shape code feeds two consumers: the atlas bake and the DOM weapon icons (`weaponIconDataUrl` → `<img>`; see `weaponIconHtml` in `hud.ts`). Bodies (`player`/`walker`/`runner`/`brute`) are drawn as **greyscale luminance ramps** tinted at runtime — the ramp floor stays around 0.40, never near-black, because the Outbreak lightmap multiplies over them. Each kind has a 5-frame set (`idle` + a 4-frame walk cycle), all facing **+x** (aim = 0), baked at `BODY_SS`× and scaled down so arbitrary aim rotations resample cleanly. Guns are pre-coloured (never tinted), so each weapon gets its own palette for at-a-glance identity — declared as parts (`gunParts`) and rendered in two passes: a dark keyline (every solid part inflated by `OL`) then full colour, which is what makes a gun read against both the dark floor and the body it overlaps. `GUN_SPEC` sizes are **outer** dimensions including that keyline. Palettes are deliberately mid-tone, not near-black: the floor is only rgb(24..30) under a multiply lightmap, so dark guns vanish. `gunPal(id, forHud)` lifts them toward white for the near-black HUD.
- `gfx/textures.ts` — every shape is baked once into a single 1024² canvas atlas (`tex := entries` keyed by name); team/type-colored shapes are baked **white/greyscale and tinted at runtime**. Map + minimap keep the original Canvas2D bakes uploaded as static textures (asserts ≤4096px). Drop a Pixi spritesheet at `client/assets/atlas.json` with frame names matching registry keys to reskin with zero code changes (`tryLoadArtAtlas` — the doc comment there is the frame-name/anchor/tint contract). **The atlas is page-lifetime (`sharedAtlas`), only the two map bakes are per-match, and `destroy()` must keep it that way.** It depends solely on constants, so re-baking it would merely be waste — but *freeing* it breaks the renderer: Pixi builds the particle pipe's shader once per renderer and holds the source of whatever texture the particles draw from in a bind group, and our shells/sparks/smoke draw from the atlas. Destroying it destroyed that bind group, so from the next match on every `render()` threw before presenting — the canvas froze on the last good frame while the sim, the audio and the DOM HUD carried on.
- `gfx/scene.ts` — layer tree (order is load-bearing): `world(ground<under<actors<fxTop)` < lightmap < `worldFx(emissive<floats)` < screen UI < minimap. `worldFx` sits **above** the lightmap so tracers/flashes/damage numbers are never darkened. Entity visuals are per-id pooled containers (mark-and-sweep against each snapshot). Bodies rotate to `aim` and pick their walk frame from `WalkCycle`, which accumulates **distance actually travelled on screen** (`WALK_STEP_PX`) — never wall time, so feet don't skate and sprint/frenzy speed the cycle for free. The gun is a **separate sprite above the body** (bodies bake empty hands), so one frame set serves all five weapons; zombie claws are baked into the frames, but red eyes stay separate tinted overlays positioned from `HEAD` (one tint can't do two hues).
- `gfx/fxsync.ts` — mirrors the `Fx` pools (which stay pure simulation data) onto pooled sprites/`ParticleContainer`s; pools only grow, extras are hidden — zero allocation per steady-state frame.
- `gfx/lights.ts` — screen-sized lightmap RenderTexture composited with multiply blend. Zombie mode: 128-ray visibility polygon (via `grid.raycast`) masks the player light; **dims, never hides** (ambient floor is one constant). TDM: ambience only, **no LOS masking** — that would change gameplay information. Muzzle-flash light pulses come from `fx.glows`. Core blend modes only (`add`/`multiply`) — the vendored bundle can't resolve `pixi.js/advanced-blend-modes`. **The lightmap texture is replaced on a size change, never resized** (`fit`): Pixi caches a GPU render target per texture source and resizing one it has already drawn into reallocates the texture but not that framebuffer, so every later pass keeps writing the old viewport and the rest of the screen composites against texels nothing wrote — full brightness, no shadow, no vision cone. A phone locking landscape mid-boot did exactly that, which is why the dark only arrived on the *second* match.
- **Pickups get their own `worldFx` layer, not the `emissive` one** (`scene.ts`). Being above the lightmap is what makes them read at the ambient floor, and that is all they needed; putting them *inside* `emissive` would have blinked them on and off, because `fxsync` toggles `emissive.visible` by tracer/flash count, and it would keep the bloom filter running every frame of every Outbreak match for four sprites. Their minimap blips are **squares** while every entity blip is a disc — in Outbreak each survivor is already a green dot and `TEAM_COLORS[SURVIVOR].name` is the same green a medkit wants, so colour alone could not say "object, not person".
- `gfx/decals.ts` — persistent blood stamped into a half-res map-sized RenderTexture (one tiny render pass per stamp, zero per-frame cost); wiped on `matchstart` (TDM restart / zombie squad-wipe — both modes emit it).
- Bloom (`AdvancedBloomFilter`) applies to the `emissive` container only, toggled invisible on idle frames.

### Panels, pause and leaving a match

The menu and the in-game panels share one token set at the top of `style.css`
(surfaces, edges, the `.cut` chamfer, type stacks). **Semantic colours stay out
of it** — team red/blue, health green, points gold, damage red mean something,
and must not drift when the art direction does. In-game panels take the palette
and the cut edges only: no grain, no decorative vignette, because `#vignette`
is already the damage indicator.

- `.cut` draws its edge as the element's own background and its fill as an
  inset `::before` wearing the same `clip-path` — `clip-path` does not clip a
  `border` onto the diagonal. That is why `.cut > *` lifts content above the
  pseudo-element; **a bare text node inside a `.cut` would be painted over**.
- **Pause gates firing only** (`hud.pauseOpen` joins `hud.buyOpen` in `held`,
  `main.ts`). It is a centred panel, never a full-screen backdrop: `#touch` is
  at z-index 9 *below* `#hud`, so anything covering the screen swallows the
  pads — and this is authoritative multiplayer, so a player frozen mid-wave is
  a player being eaten. Esc falls through the armory first and only then
  reaches pause.
- **Quitting sets `net.quitting` before closing the socket.** Closing clears
  `connected` before `onclose` runs, which is indistinguishable from a failed
  dial — without the flag a deliberate exit reports "Could not connect". A
  reason of `''` means "left on purpose"; `undefined` means a caller forgot.
- **The armory closes on the server's `buy` event, never on the click.**
  `ZombieRoom.buy` refuses for four reasons (broke, weapon owned, already at
  full health, downed) and emits nothing in any of them, so a panel that shuts
  can only mean the purchase landed. The flip side: silence now *means*
  refusal, so `hud.update` marks all four states `.cant`/`.owned`, and those
  classes carry `pointer-events: none` — an unbuyable row must not be
  clickable.
- **Buy rows listen on `pointerdown`, not `click`.** The tap that opens the
  armory emits a compatibility `click` milliseconds later at the same point, by
  which time the panel is under the finger: on a phone that bought whatever row
  landed there.
- **On touch the armory and scoreboard are top-anchored, not centred.** A
  landscape phone is ~390px tall; centred, each panel covers the very control
  that toggles it (the ARMORY button, the score bar). Sizes in the
  `body.touch` panel rules are deliberately *not* multiplied by `--s`: 44px is
  a tap-target floor, not decoration to scale down.

### Gotchas

- Weapon spread bloom only decays after `SPREAD_DECAY_DELAY` (0.25s) since the last shot (`server/room.ts`); a plain per-tick decay lets high-RPM weapons out-recover their own bloom. The client mirrors this in `main.ts` for the crosshair.
- The local tracer mirror must stop on bodies, not just walls: `tracerTargets` in `main.ts` rebuilds the same set each mode's `hitscanTargets` returns (TDM: living unprotected enemies; OUTBREAK: every zombie) from interpolated positions. Only own shots need it — remote `shot` events already carry the server's per-pellet distance.
- `server/room.ts` rebuilds `hitscanTargets()` per pellet on purpose: an earlier shotgun pellet can kill a target, and a stale entry would be damaged (and kill-credited) twice — `damageZombie` has no dead guard.
- FPS/ping (`#perf`, top-right) is driven from the render loop: FPS counts frames over a 500ms window, ping is an app-level `{t:'ping', ts}` → `{t:'pong', ts}` echo sent once a second by `net.pingTick()` (separate from the ws-protocol keepalive in `server/index.ts`). Two things there are load-bearing: the probe is stamped with `performance.now()` at send, **not** with the rAF timestamp the loop hands in (that is the frame's start, 1–19ms behind the real clock — measured — which on a LAN is larger than the RTT being measured), and `net.ping` is negative, never 0, until the first pong: a sub-millisecond LAN round trip is a valid reading, so 0 can't double as "no data" or a working link reads `— ms`. The number includes main-thread queueing, not just the wire — a client at 18fps measures ~260ms over loopback, because the pong handler waits for a free main thread.
- The HUD shrink factor is a CSS custom property (`--s` in `style.css`) selected by `@media (pointer: coarse), (max-height: 500px)`. The **same condition is duplicated in JS** (`COMPACT_UI` in `main.ts`) because the minimap is a canvas sprite, not DOM — change one and you must change the other.
- The graphics tier (`wz3-quality`, menu picker) only moves `resolution` and bloom, both provably cosmetic. It must never gate the lightmap, its ray count or `VIS_REACH`: two players on different tiers have to see the same things. Tier changes apply at the next `Renderer.create`, which rebuilds every RenderTexture at the new resolution. **`sharp` is the default on every device, phones included** — `resolutionFor` already caps the backing store at 2 whatever the DPR, so the worst case is bounded, and a phone that can't hold the frame rate has the FPS readout as the symptom and the picker as the cure. Only an explicit pick is persisted, so changing this default moves every client that never touched it.
- Semi-auto fire is edge-detected server-side via `firePrev`; bots alternate their `fire` flag (`fireTick`) to produce edges.
- Zombie-mode rooms are never in state `'live'` (`break`/`wave`/`over`) — that's why `inputAllowed()` exists; don't test `state === 'live'` in shared paths.
- Snapshot fields use short names (`k`, `d`, `w`, `rld`, `prot`, `fr`, `stam`, `spg`) to keep JSON small; they are typed in `shared/types.ts` — extend the types there when adding fields, and keep both ends consistent.
- `Snapshot` is a discriminated union on `mode` — narrow with `snap.mode === 'tdm'` (not the client's local `mode` variable) before touching mode-specific fields.
- **Entity radii live in `shared/constants.ts`** (`PLAYER_RADIUS`, `ZOMBIE_RADII`) and nowhere else: the server builds zombie stats from them (`ZOMBIE_TYPES` in `server/entities.ts`) and the client bakes body frames and rings at the same values (`ZTYPE`/`BODY_RADIUS` in `gfx/textures.ts`). Don't re-hardcode a radius — visuals would silently drift from the hitbox.
- **A silhouette may never extend past its collision radius** — the sprite outline *is* the hitbox, and the rings mark it. What binds this is the trailing foot at full stride and the walker's reaching claw. Nothing type-checks it, so re-measure after touching `art.ts` (all four kinds currently peak at 0.90–0.96 of radius).
- Radii are gameplay constants, not render tweaks: they feed tile collision (`physics.ts`), TDM hitscan target radius (`tdm.ts`), zombie melee reach (`zombie.ts`) and A* clearance. **Brute stays at 22** — Outbreak's outer buildings have 1-tile (48px) doors, so a diameter of 48 would jam it in every doorway. Check door clearance before raising any radius; `test/smoke.ts`'s flood fill is tile-based and won't catch it.
- `Renderer.gunTip()` takes a `WeaponId` and derives the muzzle from `GUN_SPEC[id].len` — the same table the sprites bake from, so flashes/tracers/flash-light stay on the barrel end for all five guns. Cosmetic only: the server's hitscan origin is the player centre.
- `client/atlas-preview.html` (served at `/atlas-preview.html`) renders every body frame, tint, rotation and gun at adjustable zoom with a dashed hitbox ring — the fastest way to judge sprite changes without playing. It imports `art.ts` directly and needs no Pixi.
