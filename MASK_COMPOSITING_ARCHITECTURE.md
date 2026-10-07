# Phase 13 — Masks & Advanced Compositing: Architecture

Status: implemented and verified (see `MASK_COMPOSITING_TEST_REPORT.md`). Builds on the composition engine (Phase 4), the transform system (Phase 5), the keyframe engine (Phase 8), effects (Phase 9), the timeline/undo engine, and the existing professional matting engine (`lib/matting`, Phases 1–17 of the matte work). The matting engine is **not modified or replaced**: `git diff src/lib/matting` is empty.

## 0. Inspection: what existed

- **Compositing was already premultiplied Porter-Duff** (`draw.ts`): layer alpha × opacity × matte, back-to-front by track order, with an "isolated layer" path (scratch canvas) for matted and effected layers.
- **Seven blend modes**, each mapped 1:1 to a Canvas `globalCompositeOperation`. Blend modes weren't validated on load.
- **Matte input existed** (`ClipVisual.matte = { sourceId, invert }`), alpha channel only. The only matte in the editor was a synthetic ellipse standing in for a background-removal result. The real matting engine wasn't connected to the composition editor.
- **The keyframe registry was built for this:** `registerPropertyResolver` lets a pattern of paths (effects use `effects.<id>.<param>`) animate through the same evaluator, ops, persistence and UI. Its doc comment already named "mask" as a future entry.
- **Effects established the per-clip list pattern:** a list on `Clip` with ordered ids, params keyframed in `clip.animation`, ops that are pure and validated with one undo step each, and a versioned, validated save format.

## 1. Pipeline (per layer, per frame)

```
resolveFrame:  keyframes evaluated (Phase 8) -> visual + masks (enabled, evaluated) + matte ref
draw:          content --(single crisp mask? canvas clip)--> isolated surface
               -> matte (alpha | luma | decontaminated alpha)
               -> masks raster (feather / expansion / several / partial opacity)
               -> effects (Phase 9)
               -> opacity + blend mode onto the frame
```

Order follows After Effects: **masks before effects**, so a blur softens a masked edge. Matte and masks both multiply alpha, so a background-removed subject plus a garbage mask simply combine.

## 2. Mask model (`lib/masks/model.ts`)

`clip.masks?: Mask[]`, where index = order. Each mask combines into the result of the masks above it.

| Field | Meaning |
|---|---|
| `type` | `rectangle` / `ellipse` / `polygon` / `freeform` |
| `mode` | `add` / `subtract` / `intersect` / `difference` |
| `enabled`, `inverted` | |
| `x, y, width, height, rotation` | **The mask's own transform** (its box), in the layer's normalized content space |
| `roundness` | Rectangle corner radius, a fraction of the shorter side |
| `points` | Polygon/freeform vertices, normalized **inside the box** |
| `feather`, `expansion` | Layer pixels |
| `opacity` | 0..1 |

**Why layer-normalized coordinates:** the mask follows the layer's transform, crop, fit and resize with no extra code, because it is defined *on the picture*, not on the screen. Path points live inside the box, so moving, scaling or rotating a drawn shape uses the same five numbers as a rectangle.

**Why feather and expansion are in layer pixels:** they scale with the layer (After Effects behavior). The renderer multiplies them by the layer's on-screen scale × render scale, so preview and export match proportionally.

**Validation** (`applyMaskPatch`, `normalizeMask`):
- Numbers are clamped to `MASK_LIMITS`.
- Non-finite values, unknown enums, and paths with fewer than 3 or more than 4096 points are rejected.
- Switching to a box shape drops the points.

**Keyframes:** paths `masks.<id>.<param>` for every `MASK_PARAMS` field. A resolver is registered in `animation/properties.ts`, so the Phase 8 evaluator, `addKeyframe`, `setPropertyAnimated`, auto-key, the keyframe panel and persistence all work unchanged. Points are edited but not keyframed per vertex (§9).

## 3. Geometry (`lib/masks/geometry.ts`)

Every shape becomes **one closed polygon in content pixels** (`maskContentPolygon`). The renderer maps it through layer matrix × render scale.
- **Curves are flattened adaptively** to stay under about 0.25 render px of chord error. This applies to ellipses, rounded corners, and freeform curves, which are a closed uniform Catmull-Rom spline *through* the drawn points. A small preview gets few segments; an export gets more.
- **Polygon edges stay straight**, which is what distinguishes polygon from freeform.
- **Both render paths use this one function**, so they cannot disagree about where an edge is.
- **Fill rule is NONZERO everywhere**, matching canvas `clip()`.

## 4. Rendering (`composition/draw.ts`, `lib/masks/raster.ts`)

**Fast path, no extra raster** (`maskPlanFor` → `"clip"`). It applies when there's exactly one enabled mask with feather 0, expansion 0 and opacity 1. The layer is drawn straight into the frame through a canvas clip path, and text, vector shapes and video stay unrasterized. A lone *subtract* mask is the complement. Inversion is clipped even-odd with a surface rectangle, but only for rectangle and ellipse, which are always simple shapes. An inverted polygon/freeform could self-intersect, so it goes through the rasterizer to complement its nonzero fill exactly.

**Raster path** (everything softer). The layer is isolated; mask coverage is computed in pure JS over only the layer's paint region (bounds + shadow/stroke spill); then it's applied with `destination-in` through scratch slot 4. The rasterizer works in four steps:

1. **Scanline coverage.** Exact horizontal span coverage × 5 sub-scanlines, nonzero winding. Values within 1/2048 of 0 or 1 are snapped (see the test report: float drift otherwise creates phantom edges).
2. **Sub-pixel signed distance field** (`signedDistanceField`), used only when there's feather or expansion:
   - An exact Euclidean **nearest-feature** transform (Felzenszwalb & Huttenlocher, extended to carry the argmin) finds each pixel's nearest edge pixel.
   - Each edge pixel carries its true edge geometry. A partial pixel uses a line with a Sobel normal at the exact box-filter inverse offset (`coverageToEdgeDistance`, Gustavson & Strand 2011). A hard 0/1 boundary uses its actual pixel-side segment.
   - The distance is the minimum over the nearest edge pixel and its 8 neighbours. It's accurate to within 0.12 px on straight edges at any angle (tested).
3. **Profile.** Expansion shifts the edge (round joins, any shape). Feather is a smoothstep ramp of that width centred on the shifted edge, so feather preserves area.
4. **Inversion, then opacity, then combine.** Add = `a + c − ac`, subtract = `a(1 − c)`, intersect = `ac`, difference = `|a − c|`. A stack whose first mask subtracts or intersects starts from a full layer (After Effects).

**Cache:** `MaskRasterCache` (LRU of 16) is keyed by the exact render-space polygons, region and params. A static mask on playing video rasterizes once; any change to layer transform, mask or scale is a miss, never a stale hit.

## 5. Operations (`timeline/operations.ts`; `TimelineEngine` wrappers)

`addMask`, `removeMask` (drops its keyframe tracks), `moveMask`, `duplicateMask` (copies keyframes under the new id), and `updateMask(patch, frame?)`. These follow the effect-op contract: pure, validated first, locked tracks rejected, audio clips rejected, one undo step each.

`updateMask` with a playhead frame is **auto-key aware**: an animated param gets a keyframe at the playhead, and a static one changes its base value.

Split, trim, duplicate and move need no mask code. Masks ride on the clip (split's spread copies them), and their keyframes ride in `clip.animation`, which split already shifts.

New error reasons: `mask-not-found`, `invalid-mask`.

## 6. Compositing

| Capability | Implementation |
|---|---|
| Alpha compositing | Premultiplied source-over (existing), with matte and masks multiplying alpha on the isolated layer |
| Layer ordering | Track order (existing; `reorderTrack`, Layers panel), back-to-front |
| Blend modes | **17**, each 1:1 to a canvas composite op: normal; darken/multiply/color-burn; lighten/screen/color-dodge/add (`lighter`); overlay/soft-light/hard-light; difference/exclusion; hue/saturation/color/luminosity. Validated on edit and on load. The editor groups them like Premiere/After Effects |
| Masking | §2–§4 |
| Matte input | `MatteRef.channel: "alpha" \| "luma"`. Luma = Rec.709 luma × alpha, for black/white mattes from other keyers. `MatteRef.decontaminate` (§7) |

## 7. Background removal → matte input (`composition/matte-generation.ts`)

`generateClipMatte(provider, clip)` calls the engine's own `removeBackgroundFromImage`, exactly as the Remove Background tool does, with the same license-safe defaults (lazy-loaded).
- **Images:** one run, giving a still matte source.
- **Video:** runs at sampled source frames (6/s by default, first and last always included). The result is a **frame-sequence source** (`MediaFrameProvider.addFrameSequence`), held between samples, which is the engine's own sparse video policy.
- **Failures:** a failed frame is skipped and reported, never faked. If every frame fails, the call throws.
- **Result:** the matte is applied as `visual.matte` (one undo step, non-destructive). The panel shows frames matted, frames skipped, the model used, and the engine's confidence.

**Edge decontamination at render time** (`MatteRef.decontaminate`, on by default for generated mattes). An alpha-only matte leaves the old background's color in soft edges (a green fringe on green-screen footage). The draw core runs the **engine's own decontamination stage** (`matting/pipeline/decontaminate.ts`, imported, not copied) on each frame's real pixels plus the matte. It writes unmixed RGB and alpha = content × consistency-checked matte. Because it runs per frame, it works for video, not just stills.

**Persistence:** projects store the matte's `sourceId`, never media (the project rule). After a reload the panel shows "Matte media missing" with **Regenerate matte**. The layer is omitted until then (existing rule: never draw a matted layer unmatted).

## 8. UI

- **Masks & matte panel** (`MasksPanel.tsx`):
  - **Matte:** status, Remove background (with progress and cancel), invert, alpha/luma channel, clean edges, remove.
  - **Masks:** add rectangle/ellipse, or draw polygon/freeform; per mask: enable, mode, invert, feather/expansion/opacity, box X/Y/W/H/rotation/roundness. Every number field has a ◆ keyframe toggle and scrubs live through a draft timeline built by the same pure op that commits.
- **On-canvas editor** (`MaskEditOverlay.tsx`, inside `CompositionPreview`):
  - Screen = viewport × layer matrix × content, so outlines ride along while the layer itself is dragged.
  - The active mask has a move body, corner resize (in the mask's rotated frame, opposite corner fixed), a rotate knob (Shift snaps to 15°) and vertex handles.
  - Polygon draw: click points; close on the first point or Enter; Backspace removes a point; Esc cancels.
  - Freeform draw: drag a stroke, simplified on release with Ramer–Douglas–Peucker (≈1.5 screen px).
  - Each gesture commits once (one undo step, keyframe-aware).
- **Transform panel:** the blend select now lists all 17 modes, grouped.

## 9. Not supported / future

- **Per-vertex path keyframes (rotoscoping)** aren't supported. Masks animate through their box (position, size, rotation), feather, expansion and opacity. A `masks.<id>.points.<i>.<x|y>` resolver would add per-vertex animation without touching the evaluator.
- **No layer-based track mattes** (using another *layer* as a matte). Matte input is a *source* (generated or imported).
- **Bezier tangent handles** aren't supported. Freeform uses an automatic smooth curve through its points; polygon edges are straight.
- **Video background removal is sparse** (sample-and-hold). Fast motion between samples can lag the matte by up to one sample interval (167 ms at the default rate). Dense per-frame video matting remains matting-engine future work, as documented there.
- **Mask motion blur** isn't supported.
