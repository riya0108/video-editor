# Phase 13 — Masks & Advanced Compositing: Test Report

Date: 2026-10-06.

Environment:
- macOS, Node 22, Vitest.
- Chrome via chrome-devtools-mcp.
- Astro dev server (`/tools/video/composition-preview`).
- Real matting engine (u2net, in-browser).

## Summary

| Check | Result |
|---|---|
| Full test suite | **946 / 946 passed** (81 files) |
| New suite `src/lib/masks/masks.test.ts` | **56 / 56 passed** |
| Type checking (`tsc --noEmit`) | **exit 0** |
| `astro check` | **0 errors, 0 warnings** (15 pre-existing hints, unchanged) |
| Production build (`astro build`) | **Complete** |
| Browser console during all live tests | **0 errors / 0 warnings** |
| Matting engine changed? | **No.** `git diff src/lib/matting` is empty |

**Mutation checks.** Each one was injected, caught by the suite, then reverted:
- The subtract formula.
- A stack that never starts full.
- The fast path ignoring inversion.
- `removeMask` keeping keyframes.
- The loader accepting orphaned mask keyframes.
- Mask rotation ignored.
- Feather not scaled with the layer.
- An all-frames-failed matte reported as success.
- Coverage float-drift snapping removed (catches bug 2 below).

## Automated (Node)

The rasterizer is pure JS, so edge, feather, expansion, inversion and combination are asserted on exact pixel values.

| Area | What is asserted |
|---|---|
| Model | All four shapes created; drawn points become box + normalized points and map back exactly; clamping; rejection of NaN, bad enums and too few points; `normalizeMask` on untrusted input; keyframe path parsing; stroke simplification keeps corners |
| Geometry | Box → content px; rotation about the centre; adaptive flattening (more segments at higher scale, vertices exactly on the ellipse); rounded corners stay in the box; freeform passes *through* its points and bulges between them; the vertex-drag inverse round-trips to 1e-9 |
| Coverage | Exact fractional span coverage (`[0, .75, 1, .75, 0]`); region offsets; total coverage = polygon area; nonzero rule (pentagram centre filled); degenerate input → empty, never NaN; **no float residue far from the shape** |
| Distance field | Squared EDT = brute force on a random grid; **sub-pixel SDF**: vertical edge at x = 30.3 exact to 0.05, a 30° edge within **0.12 px** of the analytic distance; near-zero expansion matches exact coverage |
| Expansion / feather | Square grown by 5 = 30² − (4 − π)·5² within 2% (round corners); shrink by 5 within 6%; feather symmetric about the edge (c[29] + c[30] = 1), monotone, ≥ 8 soft pixels; an edge just outside the region still feathers in; a sub-pixel sliver can be grown |
| Inversion, opacity, modes | Inversion; opacity 0.5; add/subtract/intersect/difference on a two-mask row, exact; a stack starting with subtract/intersect starts full; LRU cache hit/miss/bound |
| Ops / undo | Add/update/move/duplicate/remove with undo and redo; audio clip, locked track, unknown mask and invalid values rejected with typed reasons; keyframes through the Phase 8 engine (auto-key at the playhead, base untouched, evaluated values reach the resolver); removal drops tracks; duplicate copies them; split keeps masks and shifts keys; disabled masks not rendered; **masks follow the layer transform** |
| Persistence (v10) | Exact round-trip of masks, mask keyframes, new blend modes, luma and decontaminated mattes; v9 files load; corrupt masks, duplicate ids, orphaned mask keyframes, unknown blend modes and matte channels rejected |
| Draw paths | 17 blend modes map 1:1; back-to-front order with opacity/blend; **single crisp mask = canvas clip on the main surface, no scratch, no `getImageData`**; inverted rect/ellipse → even-odd clip; inverted polygon → raster; lone subtract = complement; soft mask → coverage on slot 4 → `destination-in` → composite with opacity + blend, region limited to the layer; matte then masks on the isolated layer; luma matte path; masks on text, graphics, video and images; feather/expansion scale with layer × render scale |
| Background removal bridge | Sampled frames (first and last included); alpha → matte bytes; video → sequence with a failed frame skipped and reported; image → still; all-failed throws; cancellation; shapes and text can't be background-removed; sample-and-hold lookup; **decontamination unmixes a green-blended edge pixel back to the foreground colour** |

## Live (browser, real renderers)

The final renderer was asked for real pixels; scenes were built in the page through Vite module imports.

| Test | Result |
|---|---|
| **Simple mask** (rectangle, middle half of a 400² layer) | Edges exactly at x = 400/600 and y = 200: 401 inside (255), 398 outside (0), 201 inside, 198 outside |
| **Feathering** (ellipse, feather 40) | Alpha across the edge: 255 … 212, **132 \| 123** (sum 255, symmetric), 36, 0. The ramp spans ≈ 40 px |
| **Inversion** | Inside 0, outside 255; beyond the layer 0 (masks never add pixels) |
| **Multiple masks** (ellipse add + rectangle subtract) | Left 255, subtracted right 0 |
| **Animated mask** (x 0.25 → 0.75 over 30 frames) | The visible window moves left → centre → right at frames 0/15/30 |
| **Text** (rectangle keeps left half) | Left-half alpha unchanged (22,705 = 22,705); right half 22,719 → **0** |
| **Graphics** (rotated 30°, ellipse mask) | Clip path covers 56,463 px² against analytic 56,549 |
| **Video** (demo video, feathered ellipse) | Centre opaque with picture; outside transparent |
| **Transparent asset** (logo PNG with 139k partially transparent pixels) | Masked alpha never exceeds the asset's own (0 violations); half-mask → coverage 90,346 → 45,173 |
| **Blend modes** (#ff4000 over 50% gray) | multiply 128,32,0 · screen 255,160,128 · difference 127,64,128 · color-dodge 255,171,128 · add 255,192,128 · luminosity, soft-light plausible. Each matches the W3C formula |
| **Fast vs raster path parity** (after fixes 1–2) | Area 56,456 vs 56,463 (0.01%); max alpha difference 69/255, on edge pixels only (canvas vs our antialiasing) |
| **Expansion accuracy** (grow 10 px) | 66,203 px² vs **66,304** analytic offset-ellipse area (0.15%) |
| **Feather preserves area** | 56,597 vs 56,463 |
| **Background-removed subject** (real photo, **Remove background** button) | 2.1 s, u2net, engine confidence 98%. Corners alpha 0, subject alpha 255, 2.7% graded soft-edge pixels |
| **Edge decontamination** | Mean green excess on soft-edge pixels **74.7 → 40.9**; strongly green edge pixels 26,628 → 18,015. The engine's own decontaminated foreground for the same image measures **48.4**, so the compositor is at parity with the engine (slightly better per pixel) |
| **Video background removal** (8 s clip, UI button) | 49 sampled frames in 47.7 s, all matted, 97% confidence, live progress. The matte follows motion: subject centroid/area differ at frames 0/60/120/239, and frames 0 and 2 (same sample) are effectively identical |
| **Matte + masks** (bg-removed person + freeform subtract) | The freeform cut a smooth curved region out of the hand; composited over video and backdrop correctly |
| **On-canvas editing** (real pointer events on the overlay) | Polygon drawn by 4 clicks + close: 4-vertex mask. Freeform stroke: 121 samples simplified to 20 vertices. Vertex drag moves only that vertex. Body drag moved x by −0.0854 (≈ −50 screen px ÷ zoom ÷ fit). Corner resize grows w/h; rotate knob 27.3°. **4-step undo chain exact, full redo exact** |
| **Panel** | Mode select → Subtract; enable checkbox; matte report line; Clean-edges toggle |
| **Save → reload → Load** (masks on text, graphic, logo; keyframes; difference blend; video bg matte) | **Model identical; final-render checksums identical at frames 0/60/119.** The bg matte reports "missing" and offers **Regenerate matte** (media is never embedded) |
| **Preview vs final** | Full-scale preview alpha **identical** to final (max difference 0) at two frames; half-scale preview coverage ×4 within 0.6% |

**Performance** (1920×1080):
- **Feathered mask, final render:** about 42 ms per frame (1000×600 test scene).
- **Decontaminated video matte, final render:** about 100–120 ms per 1080p frame.
- **Preview, demo scene:** 71 ms (no matte) → 85 (plain matte) → 110 (decontaminated) at full resolution; 17 → 24 → 30 ms at half resolution. The scene's existing layers and effects account for the baseline.

## Bugs found during Phase 13 (all fixed)

1. **Raster-path edges up to half a pixel off (live test).** The first distance field measured pixel centre to pixel centre. The fast clip path and the raster path disagreed by up to 128/255 alpha on ~660 edge pixels of a rotated ellipse. The replacement is a sub-pixel SDF: nearest-feature EDT, true edge geometry per edge pixel (Sobel normal + exact coverage inverse; pixel-side segments for hard edges), and a minimum over the local edge. Two Node tests pin it: a slanted edge within 0.12 px, and near-zero expansion matching exact coverage.
2. **Phantom edges from float drift (live test).** The scanline accumulator left ~1.5e-8 coverage in empty rows. The SDF treated each as an edge, so a large rotated ellipse's raster path covered 13% too much. Coverage within 1/2048 of 0/1 is now snapped. The regression test fails without the fix (mutation check).
3. **A thrown `setPointerCapture` aborted a gesture (live test).** It can throw for an inactive pointer id. It's now guarded, so a drag never dies before it starts.
4. **Green fringe on background-removed subjects (live test).** The alpha-only matte applied engine alpha to original pixels. This added render-time decontamination with the engine's own stage (§7 of the architecture doc).
5. **Blend modes weren't validated on load.** A hand-edited file could carry any string. They're now validated on edit and load.

Test-script mistakes along the way (an image placed on a graphic track, reading `e.timeline` before the edit, undo calls in a probe script undoing the mask under test, a mis-assumed landscape demo video) were found and corrected. None were product bugs.

## Known limitations

- **Background-removal quality is the matting engine's.** On the test photo, small green patches between the fingers and near the hair are in the engine's own matte (u2net's wide, diffuse edge band; the engine itself warns about it). A subtract mask removes them. Decontamination reduces the fringe to parity with the engine, not to zero.
- **Video background removal is sample-and-hold** (6 samples/s by default). About 1 s per sampled frame with u2net.
- **Background-removal mattes aren't saved inside projects.** Regenerate after reload (one click).
- **No per-vertex path keyframes, no Bezier tangents, no layer track mattes, no mask motion blur** (architecture §9).
- **The raster path's antialiasing differs from Chrome's canvas clip** by up to ~0.27 alpha on edge pixels. Area agrees to 0.01%.
- **The on-canvas screenshot tool timed out** (known chrome-devtools-mcp issue in this environment). Visual checks used final-render PNGs saved under `.tmp-test-assets/phase13/` (git-ignored).
