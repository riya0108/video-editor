# Masks & Advanced Compositing — Changelog

## Phase 13 (2026-10-06)

### Added
- **Masks** (`src/lib/masks/`):
  - `model.ts`: rectangle / ellipse / polygon / freeform masks with mode (add, subtract, intersect, difference), invert, feather, expansion, opacity, roundness, and their own box transform in layer space. Validation, stroke simplification, keyframe paths `masks.<id>.<param>`.
  - `geometry.ts`: one adaptive polygon per shape (smooth freeform curve through its points), shared by both render paths.
  - `raster.ts`: pure-JS scanline coverage (nonzero), a sub-pixel signed distance field (nearest-feature EDT + exact edge geometry), feather/expansion profile, combination, and an LRU raster cache.
- **Keyframes** on every mask param through the Phase 8 engine (a property resolver; no new animation code).
- **Ops / engine:** `addMask`, `removeMask`, `moveMask`, `duplicateMask`, `updateMask` (auto-key aware). New error reasons `mask-not-found` and `invalid-mask`.
- **Compositing:**
  - Blend modes 7 → **17**: color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity.
  - Luma mattes (`MatteRef.channel`).
  - Render-time edge decontamination (`MatteRef.decontaminate`).
- **Background removal in the composition editor** (`composition/matte-generation.ts`): the existing matting engine runs on a layer's media, an image or sampled video frames, and becomes its matte. One undo step; progress, cancel and a quality report included.
- **Frame-sequence sources** (`MediaFrameProvider.addFrameSequence`, `composition/frame-sequence.ts`): sample-and-hold, for video mattes.
- **UI:**
  - `MasksPanel` (matte + masks, ◆ keyframe toggles, live scrubbing).
  - `MaskEditOverlay` (on-canvas move/resize/rotate/vertex editing, polygon and freeform drawing).
  - Grouped blend-mode menu.
- **Project format v10:** masks and mask keyframes; blend modes and matte fields validated.
- **Tests:** `src/lib/masks/masks.test.ts` (56).
- **Docs:** `MASK_COMPOSITING_ARCHITECTURE.md`, `MASK_COMPOSITING_TEST_REPORT.md`, this changelog.

### Changed
- `draw.ts`:
  - Masks are integrated. A single crisp mask takes the canvas clip fast path (no extra raster); softer masks take the isolated path.
  - Blend-mode table extended.
  - Luma and decontaminated matte paths added.
  - Scratch slots 4 (mask coverage) and 5 (matte conversion).
- `resolve.ts`: `ResolvedLayer.masks` (enabled, keyframe-evaluated); the matte gains `channel` and `decontaminate`.
- `visual.ts`: `BlendMode` union, `BLEND_MODES`, `isBlendMode`. `applyVisualPatch` validates the blend mode and matte fields.
- `CompositionPreview`: new `maskEditing` prop mounts the mask overlay.
- `CompositionPlaygroundPanel`: Masks & matte panel, mask drafts, background-removal flow.
- `TransformPanel`: grouped 17-mode blend select.

### Fixed (found during this phase)
- Raster-path mask edges up to 0.5 px off (centre-to-centre distances) → sub-pixel SDF.
- Phantom edges from float drift in scanline coverage → near-0/1 snapping.
- A thrown `setPointerCapture` could abort an overlay gesture → guarded.
- Green fringe on background-removed subjects → render-time decontamination with the engine's own stage.
- Unknown blend modes accepted from project files → validated.
