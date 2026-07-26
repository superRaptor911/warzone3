# Third-party art

## `tilesheet.png`

**Topdown (Shooter) Pack** by Kenney Vleugels — <https://kenney.nl/assets/top-down-shooter>

Licensed **CC0 1.0 Universal** (public domain dedication):
<http://creativecommons.org/publicdomain/zero/1.0/>

> You may use these assets in personal and commercial projects.
> Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

Credit is given here voluntarily. No attribution is legally required, and CC0
imposes no share-alike obligation on this repository.

### Provenance

`tilesheet.png` is a **byte-for-byte copy** of `Tilesheet/tilesheet_complete_2X.png`
from the pack's official download, with no edits, crops or recompression. Keeping
it unmodified is deliberate: it makes the provenance trivially checkable against
the upstream download, and it means a pack update is a straight file replacement.

To re-fetch and verify:

```sh
curl -sLO https://kenney.nl/media/pages/assets/top-down-shooter/230204340a-1677694684/kenney_top-down-shooter.zip
unzip -p kenney_top-down-shooter.zip 'Tilesheet/tilesheet_complete_2X.png' \
  | cmp - client/assets/tilesheet.png && echo identical
```

### Geometry

The sheet is a **27 × 20 grid of 128 px cells** (3456 × 2560). Kenney's own
`tile_N.png` filenames map to it row-major:

```
col = (N - 1) % 27      row = (N - 1) / 27      N is 1-based
```

Verified against every individually-shipped tile that is a full 64 px cell (306
of them; the rest are trimmed to their content bounding box and so do not
byte-match a cell, which is why the sheet — not the loose files — is the source
of truth here).

128 px cells are used rather than the 64 px sheet on purpose: a world tile is
`TILE = 48` px, and `resolutionFor` gives the default `sharp` tier a backing
store of up to 2× DPR. Baking from 64 px would mean upscaling exactly where the
detail is supposed to arrive. See `client/js/gfx/tileset.ts` for which cells are
used for what.

### What is *not* used

The pack's character sprites (`PNG/Soldier 1/`, `PNG/Zombie 1/`, …) are
deliberately unused. They are static weapon-holding poses with the gun fused
into the body, one zombie type, and silhouettes of 36 × 43 px — none of which
fits this engine's entity contract (a freely-rotating body, a 4-frame
distance-driven walk cycle, empty hands with a separate gun sprite for five
weapons, three zombie radii, and a silhouette that must stay inside the
collision radius). Bodies and guns stay procedural in `client/js/gfx/art.ts`.
