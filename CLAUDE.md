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
- `shared/maps.ts` — `Grid` (tile queries, DDA raycast, LOS), the render-only `mat`/`decor` layer (see _World art_), and programmatic map builders. Maps are built with code (border/hollowRect/door/crate + paint/scatter helpers), never hand-drawn ASCII; `test/smoke.ts` flood-fills every map to assert full connectivity and `test/matchflow.ts` asserts every authored material resolves to art of the right kind — run both after any map edit. Map building must stay **deterministic** (`scatter` uses a seeded PRNG, never `Math.random`): two clients in one room have to agree about the world, and the tests assert two builds are identical.
- `shared/weapons.ts`, `shared/constants.ts` — tuning values used by both sides.
- `shared/hitscan.ts` — `rayCircle` / `castPellet` (one pellet vs walls **and** body circles). The server resolves real hits with it and the client's local tracer mirror ends its tracers with it, so a predicted tracer stops on the same flesh the shot hits.
- `shared/types.ts` — protocol/snapshot/entity types (type-only, see above).

Client-side, `client/js/state.ts` (`simStep`) mirrors server `applyInput` movement. If you add input-affected state (like stamina), it must: (1) live in shared code, (2) be replicated in the snapshot `self` block, (3) be restored in `GameState.addSnapshot` before replay.

### Server (`server/`)

`room.ts` holds the base `Room`: 30Hz tick, per-player input queue with a dt budget (anti-speedhack), hitscan resolution, damage/kill bookkeeping, and 15Hz personalized snapshots (`base` object mutated per client with `ack` + `self`). Mode rooms subclass it and override hooks: `addPlayer`, `removeBot`, `fillBots`, `hitscanTargets`, `damageTarget`, `onPlayerDeath`, `modeUpdate`, `respawn`, `inputAllowed`, `modeSnapshot`, and the bot hooks (`botEnemies`, `botGoal`, `botGoalReached`, `botThreat`). The base class defines them as no-op stubs (or optional methods) so `botThink` and matchmaking can call them mode-agnostically.

- `tdm.ts` — teams, score/time limits, spawn selection, match restart, bot eviction when a human joins a full team.
- **The bot roster is a property of the room, chosen at creation and never edited in-game.** A `join` carries `bots`, but `index.ts` honors it only when that join *created* the room (the same rule that arms an Outbreak checkpoint, see Persistent profiles) — a later joiner inherits the match instead of reshaping someone else's. `Room.botTarget` holds it and `fillBots()` applies it: per team in TDM, total squad size in zombie, both capped by the mode's own maximum and both breaking on `addPlayer` returning null so an over-large target can't spin. `fillBots` runs again from `leaveRoom` whenever a human departs, because a human joining a full team *evicts* a bot to get in — without the refill the roster only ever decays. There is deliberately no `addBot`/`removeBot` message: hiding the buttons but leaving the path live would be the same feature with worse discoverability.
- **Supply crates are Outbreak-only floor loot** (`Pickup` in `entities.ts`, placed and collected in `zombie.ts`). They carry the shop's own two effects at full strength — `refillAmmo` and a full heal — so scarcity is the entire balance: `PICKUPS_PER_WAVE` (2) placed at each `startWave` on random floor tiles at least `PICKUP_SPAWN_CLEAR` (400px) from every survivor spawn, accumulating to `MAX_PICKUPS` (4) because uncollected ones persist, and cleared by `resetGame`. The spot pool is precomputed in the constructor, like TDM's `openLeft/openRight`. **Humans only**: bots walk over them, since a squadmate spending a rare full refill it did not need is the one way the feature makes the game worse, and bots already buy at every wave break. A player who cannot use one leaves it standing (full health, full ammo) — the same silence-means-refusal shape as `buy`, which is why the `pick` event *is* the confirmation. Collection runs in every room state, so looting during the break is the reward for leaving the compound. Code says `pickup`, never `crate`: `shared/maps.ts` already has `T_CRATE` tiles, which are cover.
- `zombie.ts` — wave composition/scaling, zombie AI (direct steer on LOS else A*), shop, revive-on-wave-clear, squad-wipe reset, and **frenzy**: remaining ≤3 zombies or waveAge >75s ramps `z.effSpeed` above player walk speed (anti-kiting, paired with sprint stamina).
- `bot.ts` — bots are not special-cased in the sim: `botThink` emits the same input objects a client would send (`BotInput`), processed through the same pipeline. Skill knobs are `errBase`/`reaction` in `createBotController`.
- **Bots have infinite reserve but still reload.** The single exemption is in `Room.finishReload`: `if (!p.bot) ammo.reserve -= take`. Everything else about a bot's gun is unchanged — the mag still empties on the same round and the reload still costs the full `reloadMs`, so the reload is visible and audible exactly as a human's is; a bottomless *magazine* would have changed how a bot fights. Gated on `p.bot` rather than a flag, because being a bot is the actual reason and a flag is one edit from reaching a human. It is invisible on the wire (ammo only ships in the per-client `self` block), and it is why `botBuy` has no ammo row — a purchase gated on "reserve is low" could never fire.
- `entities.ts` — `Player`/`Zombie` interfaces and factories; `index.ts` — static serving (with on-the-fly type stripping), ws join/matchmaking (first room of the mode with human capacity), message routing. Wire input is parsed as `any` and validated where consumed. Rooms are destroyed when the last human leaves; bots never keep a room alive.

### Client (`client/js/`)

`main.ts` is the orchestrator; per frame it sends one input message and runs a **local gun-feel mirror** (muzzle flash/tracer/sound/cooldown/spread fired immediately) while the server remains authoritative for hits and ammo — hitmarkers/damage numbers come only from server events. Remote entities render 130ms in the past via snapshot interpolation (`INTERP_DELAY_MS`). Own `shot` events from the server are skipped (already predicted). UI is DOM (`hud.ts`), not canvas; sounds are WebAudio-synthesized in `audio.ts` (no audio assets shipped) and **entity** sprites are procedurally baked in `gfx/art.ts`. The **world** is drawn from one shipped CC0 tilesheet (`client/assets/tilesheet.png`, see _World art_ below) — that is the only image asset in the repository.

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
- **The device decides whether the pads come up, and there is no override.** `touchDefault()` (`(pointer: coarse)` and `maxTouchPoints > 0`) is settled once at boot in `main.ts`; the AUTO/ON/OFF menu row and its `wz3-touch` key were removed, because the two forced settings only mattered on hardware that misreports its own pointer, and the row's real cost was making every player classify their pointer before they could deploy. The line above is why OFF was never needed. `touch-preview.html` calls `setActive(true)` directly, so the pads are still reachable on a desktop for tuning. `test/touchdrive.ts` relies on CDP device emulation instead of a stored override — measured to report coarse/5 points on the mobile viewport and fine/0 on the desktop one, which is what makes both passes real.
- Landscape is required (`#rotate` gate in portrait, sim keeps running underneath); the menu stays usable in portrait. Fullscreen, orientation lock and wake lock are requested from the mode-card tap (a user gesture) and are **all best-effort** — iPhone Safari ignores element fullscreen and orientation lock, so the layout must be correct without them.

### World art (`client/assets/`, `client/js/gfx/tileset.ts`, `shared/maps.ts`)

> This is phase 1 of three: the pipeline, against the original layouts. The level
> redesign (rotational Compound, apartment-block Outbreak, overheads) and the
> lighting/x-ray work are specified in **`tasks/WORLD-ART.md`**, along with the
> design decisions behind them — read that before changing maps or lighting.

The world is drawn from Kenney's **Topdown Shooter** tilesheet, CC0, shipped
**unmodified** as `client/assets/tilesheet.png` (27×20 grid of 128px cells; the
index formula and a `cmp` command to verify provenance are in
`client/assets/LICENSE-ART.md`). It is the repository's only image asset.
`tileset.ts` is the semantic mapping — which cell is which material — and, like
`art.ts`, is **pure Canvas2D with no Pixi import** so the bake and any preview
page share one definition. Every cell reference in it was picked by measuring the
sheet; the comments record the measurement.

- **`Grid.mat` is a second array parallel to `tiles`, and it is RENDER ONLY.** `solid()`, `raycast()`, `los()`, `shared/physics.ts` and `server/pathfinding.ts` never read it, so no material can move a hitbox or desync prediction. This is what lets `T_CRATE` mean "any waist-high solid prop": a crate, a shipping box and a workbench have identical collision and differ only in `mat`. If you want `mat` in a gameplay path, the thing you want belongs in `tiles`. A mat byte is `id | MAT_INDOOR?` — low 7 bits the material, top bit "under a roof", the latter read only for the minimap today (and the ambient split in phase 3). Indoor-ness is a flag rather than baked into the id so the same concrete can be a lit forecourt in one place and a dark corridor in another.
- **`decor[]` is free-position scenery that can never matter.** The authoring rule is: *collides or occludes → tile-aligned in `tiles`/`mat`; neither → `decor`*. Tests assert decor is inside the map, never on a solid tile, and always a frame that exists.
- **The paint helpers name the tile KIND (`paintFloor`/`paintWall`/`paintCrate`), not solidity.** A "solid" filter silently relabels every crate as wall the first time a perimeter is painted — that actually happened. Related: **paint broad first, specific second.** Outbreak's perimeter pass ran after its per-building cladding and re-concreted all four buildings.
- **Walls are composited, not used as shipped, and that is the crux of fitting this pack to this grid.** The pack's wall tiles are *already* an autotile set but with the opposite convention: a cell is a room's floor with 12px wall bands on its walled *edges*, i.e. walls live on tile **borders**. Here `solid()` makes a whole 48px tile impassable. Dropping their tiles in draws a thin line and collides with the entire cell — players bouncing off what looks like open floor. So the geometry is ours and the pixels are theirs: fill the cell edge to edge with a material texture, then redraw the pack's own edge language (2px keyline, lit north face — both measured off the sheet) on the faces that actually front onto floor, selected by a 4-bit neighbour mask into 16 variants. **The visual edge is the collision edge by construction**, which is the property the whole scheme exists to guarantee, and `test/touchdrive.ts` asserts every composite fills its cell — `scene.ts` skips the floor sprite under a wall *because* of that.
- **The floor-side ambient occlusion is a separate sprite on the floor tile**, not part of the wall texture: it is the half of a wall's drop shadow that lands on the ground, and a texture is clipped to its own cell.
- **`FLOOR_FX.grain` exists because the pack has no textured asphalt.** Its dark grey is a flat interior-floor colour and the neighbouring cells that look like faint specks are *road dot markings* — used as variants they tile into visible polka dots across every street (they did). So the grain is generated at bake time in the pack's palette, deterministically per variant, and `variants` decouples baked faces from source cells. `wash` knocks back the pack's earth, which is vivid enough to fight the brick over any real area.
- **The tilemap is real sprites, not a baked map texture.** `buildMapCanvas` is gone. ~2200 batched quads for Outbreak, in exchange for: resolution independence (the old bake was 48px/tile and `sharp` gives every device a backing store up to 2×DPR, so it upscaled exactly where detail was wanted), no 4096px map-texture ceiling, and per-tile variation. Cells bake at `TILE * TILE_SS` = 96px from 128px source — a downscale, which is why the 2X sheet is used and why going higher would gain nothing. Nothing in the tilemap is pooled or updated: the world is static for a match.
- **World art is mandatory and fails loudly** (`MissingArtError` → `main.ts` bails to the menu with a message). The entity atlas hook degrades silently because it is an optional *override*; the tilesheet ships in the repo, so its absence can only mean a broken checkout or deploy — the case where silence costs an hour.
- **Bodies now carry a dark keyline** (`drawBody` runs the two-pass outline/fill trick `drawGun` already used). The old bright-biased ramp was tuned against a near-black `rgb(24..30)` floor; the tilesheet's floors are mid-tone (asphalt 74, concrete 156, shop tile 245) and against those a tinted ramp with no rim reads as a soft disc. **The radius invariant is preserved by construction:** shapes are drawn at `R - ol` and inflated by `ol`, so the peak moves from `p·R` to `p·R + ol·(1−p)`, still under R. `KEY_V` is deliberately below the 0.40 ramp floor — that rule is about the body's *masses* turning to mud under the lightmap, and a 1px rim is the exception that makes the masses legible.

### Rendering (`client/js/gfx/`, PixiJS v8 / WebGL)

`render.ts` is a facade re-exporting `Renderer`/`DrawView` from `gfx/renderer.ts`. Pixi is **vendored, not bundled**: `npm run vendor` copies the single-file ESM builds (`pixi.min.mjs`, `pixi-filters.mjs`) into `client/vendor/`, and an import map in `index.html` resolves the bare `pixi.js`/`pixi-filters` specifiers (tsc resolves types from the devDependencies). No build step; `client/vendor/` is outside tsconfig `include` on purpose.

- `gfx/renderer.ts` — the Pixi `Application` is a **page-lifetime singleton** (`main.ts` constructs a Renderer per `welcome`, reconnects included; re-initializing on the same canvas would leak WebGL contexts). `Renderer.create` is async (WebGL init) — `main.ts` guards event handlers against the ~1-frame gap. Pixi's ticker is stopped; `main.ts` owns the only rAF loop and `draw()` calls `app.render()` manually. `autoDensity: true` with a per-tier `resolution` means the backing store scales with DPR while `app.screen` stays in **CSS px** — every screen-space calculation (camera, crosshair, chevrons, stick→world) reads `renderer.screenW/screenH`, never `canvas.width`. **World zoom**: `draw()` sets `world`/`worldFx` scale to `renderer.zoom` (`zoomFor`, 1 on any viewport ≥1300×620, so desktop is unchanged) and every consumer of the world transform takes it — the camera clamp uses the *world* viewport size `screenW / zoom`, `lights.update` mirrors the scale, chevron range stays measured in world px, and `Text` (names, damage numbers) is counter-scaled by `1/zoom` to hold its pixel size. Zoom is cosmetic-plus-FOV only: light radii, `VIS_REACH` and chevron `REACH` are world constants, so two clients at different zooms have the same tactical information.
- `gfx/art.ts` — **all procedural sprite art** as pure Canvas2D draw functions with no Pixi import, so the same shape code feeds two consumers: the atlas bake and the DOM weapon icons (`weaponIconDataUrl` → `<img>`; see `weaponIconHtml` in `hud.ts`). Bodies (`player`/`walker`/`runner`/`brute`) are drawn as **greyscale luminance ramps** tinted at runtime — the ramp floor stays around 0.40, never near-black, because the Outbreak lightmap multiplies over them. Each kind has a 5-frame set (`idle` + a 4-frame walk cycle), all facing **+x** (aim = 0), baked at `BODY_SS`× and scaled down so arbitrary aim rotations resample cleanly. Guns are pre-coloured (never tinted), so each weapon gets its own palette for at-a-glance identity — declared as parts (`gunParts`) and rendered in two passes: a dark keyline (every solid part inflated by `OL`) then full colour, which is what makes a gun read against both the dark floor and the body it overlaps. `GUN_SPEC` sizes are **outer** dimensions including that keyline. Palettes are deliberately mid-tone, not near-black: the floor is only rgb(24..30) under a multiply lightmap, so dark guns vanish. `gunPal(id, forHud)` lifts them toward white for the near-black HUD.
- `gfx/textures.ts` — every entity shape is baked once into a single 1024² canvas atlas (`tex := entries` keyed by name); team/type-colored shapes are baked **white/greyscale and tinted at runtime**. World tiles are baked into a *second* atlas (`sharedTiles`, 2048×1024, 96px cells) from the tilesheet; only the minimap is still a per-match Canvas2D bake. Drop a Pixi spritesheet at `client/assets/atlas.json` with frame names matching registry keys to reskin with zero code changes (`tryLoadArtAtlas` — the doc comment there is the frame-name/anchor/tint contract). **Both atlases are page-lifetime (`sharedAtlas`, `sharedTiles`), only the minimap bake is per-match, and `destroy()` must keep it that way.** It depends solely on constants, so re-baking it would merely be waste — but *freeing* it breaks the renderer: Pixi builds the particle pipe's shader once per renderer and holds the source of whatever texture the particles draw from in a bind group, and our shells/sparks/smoke draw from the atlas. Destroying it destroyed that bind group, so from the next match on every `render()` threw before presenting — the canvas froze on the last good frame while the sim, the audio and the DOM HUD carried on.
- `gfx/scene.ts` — layer tree (order is load-bearing): `world(ground<under<actors<fxTop)` < lightmap < `worldFx(emissive<floats)` < screen UI < minimap. `worldFx` sits **above** the lightmap so tracers/flashes/damage numbers are never darkened. Entity visuals are per-id pooled containers (mark-and-sweep against each snapshot). Bodies rotate to `aim` and pick their walk frame from `WalkCycle`, which accumulates **distance actually travelled on screen** (`WALK_STEP_PX`) — never wall time, so feet don't skate and sprint/frenzy speed the cycle for free. The gun is a **separate sprite above the body** (bodies bake empty hands), so one frame set serves all five weapons; zombie claws are baked into the frames, but red eyes stay separate tinted overlays positioned from `HEAD` (one tint can't do two hues).
- `gfx/fxsync.ts` — mirrors the `Fx` pools (which stay pure simulation data) onto pooled sprites/`ParticleContainer`s; pools only grow, extras are hidden — zero allocation per steady-state frame.
- `gfx/lights.ts` — screen-sized lightmap RenderTexture composited with multiply blend. Zombie mode: 128-ray visibility polygon (via `grid.raycast`) masks the player light; **dims, never hides** (ambient floor is one constant). TDM: ambience only, **no LOS masking** — that would change gameplay information. Muzzle-flash light pulses come from `fx.glows`. Core blend modes only (`add`/`multiply`) — the vendored bundle can't resolve `pixi.js/advanced-blend-modes`. **The lightmap texture is replaced on a size change, never resized** (`fit`): Pixi caches a GPU render target per texture source and resizing one it has already drawn into reallocates the texture but not that framebuffer, so every later pass keeps writing the old viewport and the rest of the screen composites against texels nothing wrote — full brightness, no shadow, no vision cone. A phone locking landscape mid-boot did exactly that, which is why the dark only arrived on the *second* match.
- **Pickups get their own `worldFx` layer, not the `emissive` one** (`scene.ts`). Being above the lightmap is what makes them read at the ambient floor, and that is all they needed; putting them *inside* `emissive` would have blinked them on and off, because `fxsync` toggles `emissive.visible` by tracer/flash count, and it would keep the bloom filter running every frame of every Outbreak match for four sprites. Their minimap blips are **squares** while every entity blip is a disc — in Outbreak each survivor is already a green dot and `TEAM_COLORS[SURVIVOR].name` is the same green a medkit wants, so colour alone could not say "object, not person".
- `gfx/decals.ts` — persistent blood stamped into a half-res map-sized RenderTexture (one tiny render pass per stamp, zero per-frame cost); wiped on `matchstart` (TDM restart / zombie squad-wipe — both modes emit it).
- Bloom (`AdvancedBloomFilter`) applies to the `emissive` container only, toggled invisible on idle frames.

### Persistent profiles (`server/db.ts`)

Kills, deaths and Outbreak wave depth survive the room, in sqlite. `node:sqlite`
is builtin, so this still costs **zero npm dependencies** (`ws` remains the only
one), and pm2 is pinned to `instances: 1, exec_mode: fork` — a single-writer
synchronous database is exactly what that shape wants. **`server/db.ts` is the
only file that may import `node:sqlite`**: never `shared/` (it is served to the
browser with types stripped, so a `node:` import breaks the page rather than
failing a build) and never `client/`.

- **The point of the database is that the client stopped being trusted.** The
  Outbreak checkpoint used to be `wz3-zombie-cp` in localStorage, declared on
  join — anyone could resume at wave 995. `ZombieRoom.arm(resume)` now takes the
  number from the profile, honored only when that join *created* the room (the
  same rule `index.ts` applies to the bot roster, and the internal
  `humans === 1 && wave === 0 && state === 'break'` guard stays as a second
  fence). Existing local checkpoints were dropped, not migrated: honoring one
  once would have been a free ride to wave 995 for anyone who knew the key.
- **Everything here is fail-soft.** An unopenable or corrupt file logs one line
  and disables persistence — reads null, writes no-op, `/api/leaderboard` empty,
  `welcome` carries no token, `nameTaken` reports nothing taken so nobody is
  locked out. A stats file must never take a multiplayer server offline, and
  `max_restarts: 10` means a hard failure would take it offline *permanently*.
- **Identity is a server-minted 32-hex token** (`wz3-id`), shown in the menu as a
  recovery code — the code *is* the credential. It is minted on a first join and
  returned as `welcome.pid`, deliberately **not** `welcome.id` (that is the
  in-room player id and changes every match). There is no mint endpoint: a row is
  INSERTed only when a socket takes a room seat, so garbage rows cost a real
  match instead of a curl loop.
- **Callsigns are claimed once and owned forever.** `profiles.name_key` (case
  folded, internal whitespace runs collapsed) carries the UNIQUE index, and that
  index is the arbiter — two sockets can claim one name in the same millisecond.
  Note the fold's limit: it folds *padding*, so `Raptor  Prime` cannot shadow
  `Raptor Prime`, but `R aptor` is still its own name. Names starting `bot ` are
  reserved, because bots are `'BOT ' + name` and appear in the kill feed by name
  alone. `resolveProfile` runs **before** matchmaking so a refused name never
  consumes a room seat, and a resolved token ignores `m.name` entirely — **the
  wire can no longer set a display name.**
- **`best_wave` and `resume_wave` are two columns for one reason.** `best_wave`
  counts every wave you were present for, carried runs included; `resume_wave`
  advances only when `p.earning` (the room was armed at or below your own resume
  point). Without the split, one stranger's deep room hands a fresh player
  `checkpointPoints(40)` = 23,400 starting cash, permanently. `earning` is fixed
  at join, **after** arming, and resume stays quantised to `CHECKPOINT_EVERY` so
  the arming maths is untouched.
- **Stat writes are deltas, at two moments only**: match end (`resetMatch` /
  `resetGame`, whose resets zero the counters — hence `flushAndClearStats`, which
  clears the banked marks with them) and `leaveRoom`, before the player is
  deleted, because quitting mid-match is how people leave. `Room.flushStats` is a
  **no-op without a `profileId`**, which is what makes bots free and keeps
  directly-constructed rooms in `test/matchflow.ts` from ever opening a database.
  Waves write at each `startWave`, so a pm2 restart cannot cost an hour of a run.
- **The API is read-only** (`GET /api/profile`, `/api/name`, `/api/leaderboard`)
  and must be matched **before** the static branch, which rewrites any unknown
  path to `/client/<path>`. The 404 on an unknown token is load-bearing: it is
  what lets the menu tell a mistyped recovery code from a real one *before*
  reconnecting and claiming a second blank profile.
- The menu name field is editable only until a profile exists, then it is
  replaced by `#name-lock`. A first visit pre-fills an available `Player####`, so
  tap-and-play still needs no typing while the name stays visible and editable
  right up to the claim — the claim is permanent and there is no rename.
  `#cp-clear` is now a **non-destructive** per-run "start from wave 1" toggle
  (`fresh` on the join), not a delete.
- **`#code-btn` is never hidden**, and that is the whole of the new-device story:
  the restore field lives inside that panel, so gating the button on already
  having a profile put the recovery flow behind the exact condition it exists to
  fix. With no profile the button and panel title read RESTORE PROFILE and
  `#code-own` (our own code + COPY) is hidden — there is nothing to show yet —
  while `#code-none` explains what the field is for; the pair flips the moment a
  restore lands, because `renderProfile` runs again. Enter in `#code-in` submits,
  and the field is focused on open only off touch (a landscape phone would get a
  keyboard over the panel).
- **The leaderboard ranks lifetime kills, bots included**, two boards, zero-kill
  rows excluded. Known and accepted: a TDM room left running against bots ranks,
  and `best_wave` is inflatable by matchmaking into a deep room. `resume_wave`
  and the run economy are the things protected from both.
- **Tests must never touch a real record.** `WZ3_DB` overrides the path;
  `matchflow.ts` sets `:memory:` in its module body (db.ts opens lazily, so that
  runs in time), and `smoke.ts`/`touchdrive.ts` pass it in the server's spawn
  env. For `touchdrive.ts` this is not hygiene but correctness: callsigns are
  permanent, so on a second run against a real database `TOUCH` would already be
  owned, the menu would refuse to deploy, and every later check would hang.

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
  **When the client aborts rather than the player leaving, pass the reason to
  `quit(reason)` — never write `#conn-status` yourself afterwards.** `onclose`
  fires a task later and reports the quit reason, so a message written next to
  the `quit()` call is overwritten by the silent `''` milliseconds later. That
  is how the missing-world-art abort first shipped: it bailed to the menu
  correctly and displayed nothing at all.
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
- **The skirmish loadout is chosen on the respawn screen, and nowhere else.**
  There is no menu control: `setPrimary` in `main.ts` is the only writer of
  `wz3-primary`, so your gun is set by equipping one and it carries into every
  later match. Both call sites (the `#center-msg` taps and keys 1–4) are
  reachable only while dead, and that is load-bearing rather than incidental —
  the server's `primary` handler applies the weapon **immediately, with a full
  mag and a full reserve**. A living player who could reach it would have free
  infinite ammo by equipping and re-equipping. Never surface it in pause or any
  other panel without first making `primary` queue for the next spawn. It was
  removed from the menu because it only ever applied to skirmish — `ZombieRoom`
  hands out a pistol and overwrites the join's choice — so in a list of global
  settings it lied to half the players.
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
- Snapshot fields use short names (`k`, `d`, `w`, `rld`, `prot`, `fr`, `stam`, `spg`) to keep JSON small; they are typed in `shared/types.ts` — extend the types there when adding fields, and keep both ends consistent. Note the map is **not** in the snapshot: `SerializedGrid` (now including `mat` and `decor`) ships once in `welcome`, so its size is a one-off join cost, not per-tick. `Grid.deserialize` tolerates a missing `mat` rather than throwing, so an older server yields a playable world and a loud renderer error instead of a client that dies parsing `welcome`.
- `Snapshot` is a discriminated union on `mode` — narrow with `snap.mode === 'tdm'` (not the client's local `mode` variable) before touching mode-specific fields.
- **Entity radii live in `shared/constants.ts`** (`PLAYER_RADIUS`, `ZOMBIE_RADII`) and nowhere else: the server builds zombie stats from them (`ZOMBIE_TYPES` in `server/entities.ts`) and the client bakes body frames and rings at the same values (`ZTYPE`/`BODY_RADIUS` in `gfx/textures.ts`). Don't re-hardcode a radius — visuals would silently drift from the hitbox.
- **A silhouette may never extend past its collision radius** — the sprite outline *is* the hitbox, and the rings mark it. What binds this is the trailing foot at full stride and the walker's reaching claw. `tsc` cannot see it, but it is now **measured**: `test/touchdrive.ts` renders every kind's idle + 4 walk frames to a real canvas and asserts the peak alpha radius ≤ R. The keyline pass tightened the band to **0.912 / 0.975 / 0.920 / 0.945** (player / walker / runner / brute) — the walker has only 2.5% headroom left, so treat that one as full.
- Radii are gameplay constants, not render tweaks: they feed tile collision (`physics.ts`), TDM hitscan target radius (`tdm.ts`), zombie melee reach (`zombie.ts`) and A* clearance. **Brute stays at 22** — Outbreak's outer buildings have 1-tile (48px) doors, so a diameter of 48 would jam it in every doorway. `test/smoke.ts` now guards this, and it is worth knowing *how*, because the obvious test does not work: on a tile grid the nearest solid surface to a tile centre is an axis-aligned face `TILE/2` away, so **any** radius below 24 fits at every floor tile and sweeps between any two 4-adjacent ones — a clearance flood fill is therefore incapable of failing, and it does pass 950/950 at radius 24. What can fail is the inequality, so the assertion is `r < TILE/2` per type, with the margin printed (brute: 2px). Verified by raising brute to 24: the margin check fires, the fill stays green.
- `Renderer.gunTip()` takes a `WeaponId` and derives the muzzle from `GUN_SPEC[id].len` — the same table the sprites bake from, so flashes/tracers/flash-light stay on the barrel end for all five guns. Cosmetic only: the server's hitscan origin is the player centre.
- `client/atlas-preview.html` (served at `/atlas-preview.html`) renders every body frame, tint, rotation and gun at adjustable zoom with a dashed hitbox ring — the fastest way to judge sprite changes without playing. It imports `art.ts` directly and needs no Pixi.
