# WARZONE·3

Multiplayer top-down 2D shooter for the browser. Authoritative Node.js server,
zero-dependency canvas client, two game modes, and bots you can add to either side.
Written in TypeScript with no build step.

## Run

```sh
npm install
npm start          # http://localhost:3000
```

Requires Node 22.18+ (the server and tests run TypeScript natively via type
stripping). Open the URL in any modern browser. Open it in several tabs/machines
on the same network to play multiplayer — matchmaking drops players of the same
mode into a shared room automatically.

```sh
npm test           # type check + headless: map sanity, live-server smoke of both modes, match lifecycle
npm run check      # type check only (tsc --noEmit)
```

## Modes

- **OUTBREAK** — co-op zombie survival (up to 5 survivors). Endless escalating waves
  of walkers, runners and brutes. Kills and wave bonuses pay points; press **B** to
  buy weapons, ammo and med kits. Dead squadmates revive when the wave is cleared;
  a full wipe ends the run. Stragglers can't be kited forever: when a wave is down
  to its last few zombies (or drags past 75s) they **frenzy**, ramping up faster
  than walking speed — sprint away in bursts or turn and fight.
- **5v5 SKIRMISH** — team deathmatch, first to 40 kills or best score in 5 minutes,
  3-second respawns with brief spawn protection.

**Bots**: buttons on the right edge of the HUD add/remove bots — to your team, the
enemy team (TDM), or your survivor squad (Outbreak). Bots path with A*, hold weapon-
appropriate engagement ranges, strafe, kite zombies, reload, and buy upgrades between
waves. When a human joins a full team, the newest bot makes room.

## Controls

| Input | Action |
|---|---|
| WASD / arrows | move |
| mouse | aim / fire (hold for auto) |
| Shift | sprint (drains stamina, blooms your spread) |
| R | reload |
| 1 / 2 / wheel | switch weapon |
| B | armory (Outbreak) |
| Tab | scoreboard |
| 1–4 while dead | change loadout (TDM) |

## Gunplay

Five hitscan weapons (pistol, SMG, rifle, shotgun, sniper) with per-weapon recoil
bloom + recovery, movement spread penalties, damage falloff over range, magazine +
reserve ammo, and reload/switch timing — all resolved server-side. The client
predicts its own movement and gun feel (muzzle flash, tracers, sound, kick) locally,
so it stays responsive under latency.

## Architecture

```
shared/    constants, weapon defs, map builder + grid raycasts, movement physics
           (imported by BOTH server and browser so prediction matches simulation)
           types.ts  wire protocol + snapshot types (type-only, erased at runtime)
server/    authoritative sim @30Hz, snapshots @15Hz over WebSocket (ws)
           room.ts   base sim: input pipeline, hitscan, damage, snapshots
           tdm.ts    5v5 room · zombie.ts  survival room (waves, shop, zombie AI)
           bot.ts    bot controller (produces the same inputs a client would send)
           pathfinding.ts  A* with clearance-aware smoothing
client/    canvas renderer, snapshot interpolation (130ms), client-side prediction
           with smoothed reconciliation, WebAudio-synthesized sounds, DOM HUD
```

No build step: Node executes the `.ts` sources directly (type stripping), and the
dev server strips types on the fly when serving `client/` and `shared/` modules to
the browser as ES modules — edit a file, refresh the tab. `tsc` is type-check only
(`noEmit`); nothing is ever compiled to disk.
