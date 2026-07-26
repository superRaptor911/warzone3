# World art & level redesign — phases 2 and 3

Handover for the remaining two phases of the world-art work. Phase 1 is done and
on disk (commit "Draw the world from real art instead of coloured rectangles").

Read `CLAUDE.md` → **World art** first: it documents the pipeline that landed
(the `mat`/`decor` model, wall compositing, the atlas, `FLOOR_FX`, the body
keyline). This file is only the part that is *not* yet in the code — the plan and
the design decisions behind it, so they do not get re-litigated or accidentally
reversed.

## What phase 1 delivered

Pipeline only, against the **existing layouts** — geometry deliberately
untouched. Kenney Topdown Shooter tilesheet (CC0) as the sole image asset,
`Grid.mat` + `Grid.decor` as render-only data, autotiled composite walls, floor
AO, generated asphalt grain, materials-aware minimap, entity keyline pass, and
tests. Compound is materialled as a vehicle depot, Outbreak as a quarantined
block, both with authored decor (82 / 163 items).

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

## Phase 2 — the level redesign

1. **Compound: mirror → 180° rotational symmetry.** Replace `mirrored()` with a
   `rotated()` helper: `set(x,y)` and `set(w-1-x, h-1-y)`. Still provably fair —
   each team's geometry is identical up to rotating the whole map — so there is
   no balance debt, but features stop pairing up across the vertical axis inside
   one field of view, which is what makes a mirror read as a mirror. This is what
   modern competitive shooters use. `openLeft`/`openRight` (`tdm.ts:31`) only
   split on `tx < w/2` and need no change.
2. **Redraw both maps as places.** Compound as a depot/checkpoint with a
   forecourt; Outbreak as an apartment block — lobby, flats, stairwell, back
   alley. Rooms should be identifiable by their floor material and (phase 2's
   real opportunity) their furniture: the pack has sofas, beds, kitchen counters,
   stoves, sinks, tables. Furniture that collides is a `T_CRATE` tile with its
   own `mat`; furniture that does not is `decor`.
3. **Author overhead placements into `mat` now, even though nothing renders them
   until phase 3.** This is deliberate: it means neither map gets authored twice.
   Needs a new material class flagged as overhead, plus a declared height.
4. **Budget overheads at ≤3% of floor tiles per map, and assert it.** The point
   of the cap is that x-ray stays the exception — push it further and players
   spend most of their time as flat silhouettes, which defeats the entity art.
   Reserve them for authored landmarks: a loading-dock awning, a pipe gantry, a
   container walkway, a checkpoint canopy.
5. **`map-preview.html`**, beside `atlas-preview.html`: every `mat` value, all 16
   autotile variants per wall family, the overhead bands, the indoor/outdoor
   split. The fast way to judge world art without playing a match.

### Testing notes for phase 2

- `test/smoke.ts` flood-fills both maps for connectivity and
  `test/matchflow.ts` asserts every authored material resolves to art *of the
  right kind* — both will catch a redesign mistake. Run them after every map
  edit.
- **Do not re-add a clearance flood fill.** One was written and found incapable
  of failing: on a tile grid the nearest solid surface to a tile centre is a face
  `TILE/2` away, so any radius below 24 provably fits everywhere, and the fill
  passes 950/950 even at radius 24. The check that guards the real hazard is
  `r < TILE/2` per zombie type with the margin printed, already in `smoke.ts`.
- Map building must stay **deterministic** — `scatter` uses a seeded PRNG. Two
  clients in one room have to agree about the world, and the tests assert two
  builds are byte-identical.

## Phase 3 — lighting, overheads, x-ray

1. **Per-material ambient floor.** `lights.ts` has one ambient constant per mode;
   it becomes a two-entry indoor/outdoor lookup driven by the `MAT_INDOOR` bit
   that `mat` already carries. Stays inside the existing rules: dims and never
   hides, identical on every client and every quality tier, and a rotationally
   symmetric map gives both teams the same split so TDM fairness is untouched.
2. **Overhead rendering.** Overhead `mat` values draw above `actors`. Detection
   is a grid lookup from the authored height — an actor is occluded if its centre
   tile lies in a prop's vertical extent. O(1) per actor per frame, no AABB fuzz,
   no half-occluded flicker.
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

## Known open issue

**Material boundaries are hard seams.** Dark asphalt meets brown gravel on a
straight tile line with no transition, because full-cell materials have no blend
tiles. Kenney's Tower Defense (Top-Down) pack *does* ship proper terrain blends
(grass/dirt/sand/stone with circular transitions, 64px, CC0) but in a much
brighter, more saturated palette — usable via a `FLOOR_FX.wash`-style colour
pass, which already exists for exactly this kind of problem. Worth deciding
during phase 2, since it changes how regions are painted.
