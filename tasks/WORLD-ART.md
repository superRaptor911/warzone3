# World art & level redesign

All three phases are done and on disk ("Draw the world from real art instead of
coloured rectangles", "Draw the levels as places", "Light the places and hang the
overheads over them").

Read `CLAUDE.md` → **World art** and **Rendering** first: they document what the
code does (the `mat`/`over`/`decor` model, wall compositing, furniture props, the
rotational authoring, `FLOOR_FX`, the atlases, the body keyline, the ambient split,
the overhead and x-ray layers). This file is the part that is *not* in the code —
the design decisions behind it, so they do not get re-litigated or accidentally
reversed.

## What has landed

**Phase 1 — the pipeline**, against the original layouts, geometry deliberately
untouched. Kenney Topdown Shooter tilesheet (CC0) as the sole image asset,
`Grid.mat` + `Grid.decor` as render-only data, autotiled composite walls, floor
AO, generated asphalt grain, materials-aware minimap, entity keyline pass, tests.

**Phase 2 — the levels as places.**

- Compound is authored entirely through `rotated()` and is **exactly** 180°
  rotationally symmetric — asserted, tiles/materials/overheads/spawns/decor. It
  is a depot checkpoint: two three-room base buildings (muster / office /
  workshop), a covered loading dock, a gravel plant yard, and a brick guard post
  in the middle built as one authored L closed by its own rotation.
- Outbreak is a quarantined apartment block: a spine corridor with three rooms
  each side (living room, service core with the stair block, kitchen, bedroom,
  lobby, second living room), the squad holding the lobby through four doors, a
  back alley behind a plank hoarding, plus a boarded shop and a lock-up garage on
  the ring road.
- Furniture is `T_CRATE` + a `mat`: sofas, beds, worktops, sinks, hobs, desks,
  benches, round tables, placed with `propRun` for the multi-tile pieces.
- `Grid.over` + `OVER`/`OVER_HEIGHT` carry the overheads, authored in both maps
  ahead of the renderer. 2.55% / 2.30% of floor tiles against the 3% cap.
- `client/map-preview.html` draws a whole map from real art, plus every material,
  wall variant, prop, decor frame and overhead variant.

## Decisions already made — do not re-open these

These came out of a design interview; the reasoning matters more than the
conclusion, so it is recorded.

- **One material world, two locations.** A single coherent pack, not a mix.
  Cross-artist mixing is the main way asset-flips read as cheap. Kenney's own
  catalogue is one style, so combining *his* packs is free if more vocabulary is
  needed.
- **Theme is "a building and its street"**, because that is what the pack
  actually contains: furnished interiors, floor materials, asphalt with road
  paint. There are **no** shipping containers, jersey barriers or forklifts in
  it — an earlier "industrial yard" direction was retracted on that evidence.
  Outbreak → quarantined apartment block. Skirmish → depot/office + forecourt.
- **Entities stay procedural.** The pack cannot supply them: no walk cycle (six
  static weapon-holding poses), guns fused into the bodies, one zombie for three
  required silhouettes, 36×43 sprites against a 34px collision diameter, and
  three weapons where `GUN_SPEC` needs five distinct lengths. `tryLoadArtAtlas`
  remains the open door if a suitable pack ever appears.
- **Map sizes stay 40×30 and 44×34.** Place-ness comes from materials, districts
  and prop density, not acreage. Enlarging silently slackens two tuned systems:
  `MAX_ZOMBIES_ALIVE` is 26, so a bigger Outbreak is a sparser one, and TDM's
  40 kills / 5 minutes assumes current walk distances.
  - **The corollary took a year to notice: fixed small maps make the camera's
    zoom a level-design decision.** Nothing in this file ever decided how much
    world a player sees, and `zoomFor` only ever scaled *down* (parity with the
    pre-zoom renderer), so at 1:1 a 1920×1080 client saw 91% of Outbreak's width
    and *all* of Compound's — at which point the camera pins to the map centre
    and stops tracking the player sideways. A place you can survey from your
    chair is not a place you move through, and the levels were authored as
    rooms, lanes and thresholds. So the target is now symmetric and every client
    frames the same 1300×620 world px (`client/js/view.ts`, and see CLAUDE.md →
    Rendering for the ceiling and the weapon-range trade). If the maps ever do
    grow, that is the number to re-take with them.
- **Props may occlude, with an x-ray pass, and the information delta must be
  zero.** Occlusion in a fixed top-down camera is *not* view-dependent: a car
  roof drawn over the tile north of it hides that player from all ten players at
  once, including someone at 90° with clear LOS whose shots still land. So the
  x-ray is not polish, it is the only thing keeping this legal.
- **Material seams stay hard, and no terrain-blend pack is coming.** This was the
  phase-2 open question. Kenney's Tower Defense pack does ship circular
  grass/dirt/sand transitions, but adopting them means a second palette to wash
  into line, a per-tile blend mask, and a new authoring concept — for a problem
  that is better solved by *authoring*: a region is bounded by a wall, a kerb of
  road paint, or a doorway threshold, and where it is not, the seam is a real
  surface change (carpet to boards, tarmac to gravel yard) that is hard-edged in
  the world too. Both maps are painted that way now. The rule that replaced it,
  and which is worth keeping: **paint from the street inwards, filtered to one
  tile kind per pass.**

## Phase 3 — lighting, overheads, x-ray (landed)

What shipped, and the decisions inside it that are worth keeping:

1. **Per-material ambient floor**, as `client/js/gfx/ambient.ts` — pure, because
   `lights.ts` imports Pixi and Node cannot import it, and the two things that can
   be wrong (the ordering of the values, the mask that selects between them) are
   both provable without a screen. Measured on the preview canvas: identical
   materials come out at 1.00 with ambient off, 0.79 with TDM's pair and 0.73 with
   Outbreak's.
   - **It is information-neutral by argument, not by hope.** Multiply scales a body
     and the floor under it by the same factor, so an out-of-sight zombie's
     contrast against its room is the same at either value. What *would* break
     "dims, never hides" is a value near black, which is why the test asserts a
     55–95% band and a per-channel floor rather than just "darker".
   - **`MAT_INDOOR` is authored on floors only, so the rest is derived.** Without
     that a building's walls and furniture stay at full outdoor brightness inside a
     dark room. The 8-neighbourhood was measured against the 4: 40/28 lit specks
     down to 10/7, and the survivors are outer corners of a footprint where the
     roof edge honestly is.
   - Compound's roofed region is asserted to be its own 180° rotation. The `mat`
     symmetry check is not sufficient — this mask reads `tiles` too.
2. **Overheads are drawn** from the tile atlas (13 more cells, which took it to 184
   of the 200 a 2048×1024 sheet holds — the next family needs a taller canvas),
   grouped by id and added in ascending `OVER_HEIGHT` order.
3. **X-ray, exactly as specified and no more.** The whole root is reparented into
   an `xray` layer and only the body swaps to a flat bake at 0.8 alpha; all nine
   children of a player and all seven of a zombie draw as they do in the open.
   `test/touchdrive.ts` builds a real `Scene` (no WebGL needed) and counts them.
   - **`flat-<kind>-<frame>` is its own bake, not a tint of the ramp**, and it is
     made by compositing the real draw calls (`source-atop` white) rather than by
     re-drawing the shapes — so the silhouette is pixel-identical in coverage to
     the body it stands in for, asserted, and inherits the radius invariant instead
     of re-arguing it.
4. **Both new layers stay inside `world`, under the lightmap.** Above it, an
   occluded player would be *brighter* than an exposed one.
5. **The brightness pass now measures the shape of the light, not just its
   amount.** `Page.luma()` returns mean plus a centre box and the four corners:
   Outbreak must read >1.5× brighter at the centre (that ratio *is* the vision
   cone, and a mis-ordered ambient overlay would flatten it without moving the
   mean), TDM must read under it (no LOS masking, ever), and TDM's mean must be
   more than twice Outbreak's (the mode axis). The two-match equality check now
   covers the cone as well, since the ambient geometry is rebuilt per match.

### Still open, deliberately

- The awning's source cells are a flat tan slab in the middle of the 9-slice, so a
  4×2 canopy reads as a plain block. It was picked in phase 2 on extent and trim,
  and changing it is an art decision, not a rendering one.
- Corpses and blood decals sit below the overheads and are hidden by them. They are
  cosmetic and carry no information a live actor does not, so they get no x-ray.

### Testing notes

- `test/smoke.ts` flood-fills both maps for connectivity, and `test/matchflow.ts`
  covers the material/overhead/symmetry invariants; `test/touchdrive.ts` holds
  everything that needs real pixels (wall composites filling their cell, prop
  extent, body silhouettes, screen luminance). Run all three after a map edit.
- **Do not re-add a clearance flood fill.** One was written and found incapable
  of failing: on a tile grid the nearest solid surface to a tile centre is a face
  `TILE/2` away, so any radius below 24 provably fits everywhere, and the fill
  passes at radius 24. The check that guards the real hazard is `r < TILE/2` per
  zombie type with the margin printed, already in `smoke.ts`.
- Map building must stay **deterministic** — `scatter` uses a seeded PRNG. Two
  clients in one room have to agree about the world, and the tests assert two
  builds are byte-identical.
- `test/touchdrive.ts` also holds the x-ray's scene-graph assertions, and they are
  the ones to keep honest: child counts per actor, which layer a covered actor is
  parented to, which texture set its body came from, and the order of the layers
  inside `world`. A Scene builds without a WebGL context, so this costs nothing.
- The overhead budget assertion prints its margin (0.45 / 0.70 points). Now that
  x-ray works and adding overheads *feels* free, that is exactly when the cap
  matters: it is what keeps x-ray the exception rather than the normal way players
  see each other, and raising it is a design decision to re-take deliberately, not
  a number to nudge.
