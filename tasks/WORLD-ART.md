# World art & level redesign — phase 3

Handover for the last phase of the world-art work. Phases 1 and 2 are done and on
disk ("Draw the world from real art instead of coloured rectangles", "Draw the
levels as places").

Read `CLAUDE.md` → **World art** first: it documents everything that landed (the
`mat`/`over`/`decor` model, wall compositing, furniture props, the rotational
authoring, `FLOOR_FX`, the atlas, the body keyline). This file is only the part
that is *not* yet in the code — the plan and the design decisions behind it, so
they do not get re-litigated or accidentally reversed.

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
  and rendered by nothing yet. 2.55% / 2.30% of floor tiles against the 3% cap.
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

## Phase 3 — lighting, overheads, x-ray

1. **Per-material ambient floor.** `lights.ts` has one ambient constant per mode;
   it becomes a two-entry indoor/outdoor lookup driven by the `MAT_INDOOR` bit
   that `mat` already carries. Stays inside the existing rules: dims and never
   hides, identical on every client and every quality tier, and Compound's
   rotational symmetry gives both teams the same split (asserted), so TDM
   fairness is untouched. Both maps now have real indoor space to split on —
   Compound is 37% indoor floor, and `map-preview.html`'s "mark indoor" toggle
   shows exactly which tiles the lookup will read.
2. **Overhead rendering.** `OVER_ART` and `drawOver` already exist and are
   exercised by the preview page; what phase 3 adds is the bake (`overKey`,
   `overVariants`, ~13 more atlas cells — the count note in `textures.ts` says
   they fit, but only just) and a layer above `actors`. Detection is a grid
   lookup: an actor is occluded if `grid.overAt` of its centre tile is non-zero.
   O(1) per actor per frame, no AABB fuzz, no half-occluded flicker. Draw
   overlapping overheads in `OVER_HEIGHT` order.
3. **X-ray silhouette — exactly this, no more.** Reparent the whole
   `PlayerVisual.root` above the occluder and flat-tint **only the body** (team
   colour, alpha ~0.8, no luminance ramp). The edge ring, spawn-protection ring,
   gun, aim dot, name, health bar and reload label all render as normal. All nine
   children of `PlayerVisual.root`, and the zombie's frenzy ring / eyes / bar,
   must survive. **Assert it** — the rule is easy to erode later.
4. **The silhouette stays inside `world`, under the lightmap.** Above it, an
   occluded player would be *brighter* than an exposed one, which is an
   information gain and breaks the zero-delta rule.
5. **Extend `touchdrive.ts`'s brightness pass over the new lightmap path.** This
   is the same danger zone as the lightmap texture-resize bug that made Outbreak
   render fully lit; screen luminance is the only instrument that sees it.

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
- The overhead budget assertion prints its margin (0.45 / 0.70 points). If phase
  3 makes x-ray feel good and the temptation is to add more overheads, that is a
  *design* decision to re-take deliberately, not a number to nudge.
