# Phase 9 — Effects Engine: Test Report

Date: 2026-10-03. Environment: macOS, Node 22, Vitest 5, Chrome via chrome-devtools-mcp (real rendering), Astro dev server.

## Summary

| Check | Result |
|---|---|
| Full test suite | **808 / 808 passed** (77 files). All pre-Phase-9 tests pass unchanged. |
| New effects suite (`src/lib/effects/effects-engine.test.ts`) | **27 / 27 passed** |
| Type checking (`tsc --noEmit`) | **exit 0** |
| `astro check` | **0 errors, 0 warnings**; no diagnostics in Phase 9 files |
| Linting | **No linter is configured in this repo**; `tsc` + `astro check` are the static checks |
| Production build | **Success** |

**Mutation checks:**
- Removing premultiplication from blur fails the dark-fringe and sharpen tests.
- Removing the frame seed from grain fails the grain determinism test.
- Reverting edge replication to transparent padding fails the full-frame border test.

## Kernels (exact pixel values, Node)

| Effect | Assertion |
|---|---|
| Brightness | 0.5 + 0.2 = 0.7; clamps at 1 |
| Contrast | +100%: (0.75, 0.5, 0.25) → (1, 0.5, 0) |
| Saturation | −100% = Rec.709 luma gray; +100% pushes channels apart |
| Exposure | +1 stop doubles **linear** intensity (sRGB-correct); 0 stops is identity |
| Temperature / Tint | Exact gains (R 0.625 / B 0.375 at +100%; G ±25%) |
| Blur | Energy conserved; a point spreads; **white shape over transparency keeps white edges** (premultiplied); radius scales with render scale (½-res preview ≈ export) |
| Sharpen | Edge contrast increases, flat areas untouched |
| Vignette | Relative to the layer's own bounds (center untouched, layer corner dark) |
| Grain | Deterministic per frame, differs across frames, ~zero mean, anchored in composition space (same noise at render scale 1 and 0.5) |
| Glow | Bright areas bloom past their edges; content below the threshold doesn't |
| Opacity | Alpha only |
| Stack order | brightness → contrast ≠ contrast → brightness |
| Edges | Blurring a full-frame opaque layer keeps the frame border opaque |

## Engine, keyframes, persistence

- Lifecycle: add (defaults) / reorder / disable (disabled = not processed) / edit (clamped) / remove are 6 operations = 6 undo steps, with undo/redo returning identical snapshots.
- Rejected: unknown types/params, NaN, audio clips, locked tracks.
- **Keyframes via the Phase 8 engine:** blur radius animated 0 → 30 gives 15 at the midpoint and holds after the end. A frame-aware edit auto-keys at the playhead without touching the static base. Keyed values are clamped to the param range. Removing an effect removes its tracks.
- Save/reload: order, enabled, params, metadata, and effect keyframes round-trip; evaluated stacks are identical at 4 frames.
- Invalid files rejected: unknown type, duplicate ids, keyframes pointing at a missing effect or missing param. Out-of-range params are clamped.
- Duplicate and split keep the stack.
- Layers without effects get `effects: []` and take the unchanged draw path.

## Effects on every layer kind

**Automated:** video, image, transparent PNG, background-removed (matted) overlay, text, shape, and SVG all go through the same isolate → (matte) → process → composite path. Processing reads exactly the layer's bounds plus spill (`getImageData` region asserted), and each is composited once.

**Live (final renderer, real pixels, before → after):**

| Layer kind | Effect | Result |
|---|---|---|
| Video | Saturation −100% | (243,183,152) → **(194,194,194)**, exact gray |
| Image (opaque) | Brightness +30% | R +77 (expected 0.3 × 255 = 76.5) |
| Transparent PNG | Exposure −2 stops | Star darkened (235 → 128); transparent surroundings **byte-identical** |
| Background-removed subject | Temperature +100% | R 108 → 135, B 66 → 50 (warmer), inside the matte only |
| Text | Glow | Halo alpha appears outside the glyphs; visible neon glow at radius 16 |
| Shape | Blur | Hard edge became a gradient |

**Combinations:** the transparent PNG ran exposure → glow → grain, and the shape ran blur → opacity. Both render correctly (QA image `.tmp-test-assets/phase5/qa/07-effects-scene.png`).

**UI (real controls):** 3 effects added from the menu, Saturation set to −100% in its field, Grain moved up twice, Vignette disabled: 7 undo steps, no console errors.

**Persistence (live):** save → full page reload → load: frames 10/30/55 **pixel-identical** (5 clips with effects, an animated glow intensity, deterministic grain).

## Performance (measured)

| Render | With effects (5 layers: saturation, temperature, exposure+glow+grain, blur+opacity, glow) | Without effects |
|---|---|---|
| Preview at ½ resolution | **27 ms/frame** (~37 fps) | 3 ms |
| Preview at full resolution | **86 ms/frame** (~12 fps) | 6 ms |
| Final frame 1920×1080 | ~200 ms | — |

## Bugs found during Phase 9

1. **Edge handling (fixed).** The first box blur treated pixels outside the processed region as transparent. That's right around small layers, which are padded with transparent spill, but wrong where the region is clamped at the canvas edge. A blurred or sharpened full-frame video would have faded to transparent at the frame border. Fixed with edge replication, which is identical where the border is transparent padding and continues real content where it's clamped. Regression test added.
2. The text-glow live probe initially showed "no change". Investigation showed the glow **was** applied (alpha 0 → 6) but the probe point sat far above the glyphs; at normal settings the glow is clearly visible. This was a measurement issue, not a code bug.

## Known issues / limitations

- **CPU processing:** heavy effect stacks on large layers won't hold real-time playback at full preview resolution (~12 fps measured). ½-resolution preview is ~37 fps. A WebGL backend behind the same kernel interface is the scaling path; it isn't built.
- Effects are processed in render space after the transform, with spatial params scaled by the render scale. Preview and export match proportionally, but are **not** bit-identical across resolutions (resampling differs).
- Content of a layer that extends beyond the canvas isn't available to spatial effects (edge replication approximates it).
- No effect presets/favorites, no masks, no LUTs, no per-effect blend modes.
- Glow and sharpen use one radius each (no multi-scale bloom).
