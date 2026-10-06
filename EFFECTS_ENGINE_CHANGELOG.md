# Effects Engine — Changelog

## Phase 9 (2026-10-03)

### Added
- **Effect model** (`src/lib/effects/model.ts`): `Effect { id, type, params, enabled, metadata }` on `Clip.effects` (index = order). Includes param normalization/clamping, effect-path helpers (`effects.<id>.<param>`), and `effectKeyframes` (the effect's tracks in the clip's Phase 8 animation).
- **Effect registry** (`src/lib/effects/registry.ts`): 12 definitions (brightness, contrast, saturation, exposure, temperature, tint, blur, sharpen, vignette, grain, glow, opacity) with typed params, units, categories, spatial flags, and spill.
- **Kernels** (`src/lib/effects/process.ts`): pure CPU kernels on Float32 RGBA.
  - Exposure is linear-light (sRGB LUTs).
  - Blur, sharpen, and glow are premultiplied, Gaussian-approximating 3-pass box blurs (O(1) per pixel in the radius) with edge replication.
  - Vignette is relative to the layer's bounds.
  - Grain is deterministic and anchored in composition space.
- **Keyframe integration:** a dynamic property resolver in `animation/properties.ts` makes every effect param animatable through the existing engine (`registerPropertyResolver`).
- **Ops / engine:** `addEffect`, `removeEffect` (also removes its keyframes), `moveEffect`, `setEffectEnabled`, `updateEffectParams` (frame-aware auto-key). Each is one undo step.
- **UI:**
  - `EffectsPanel`: add-effect menu by category; enable, reorder, and remove; param fields with ◆ keyframe toggles; live scrub preview via a draft timeline.
  - `KeyframesPanel` labels and units for effect tracks.
- **Project format v6:** effects validated on load; effect keyframe paths must reference real effects and params; effect ids reserved on load.
- Docs: `EFFECTS_ENGINE_ARCHITECTURE.md`, `EFFECTS_ENGINE_TEST_REPORT.md`, this changelog.
- Tests: `src/lib/effects/effects-engine.test.ts` (27).

### Changed
- `draw.ts`: the isolated-layer path (previously matte-only) now runs for **matte or effects**: content → matte → effect stack over bounds + spill → composite. One path for every layer kind.
- `resolve.ts`: `ResolvedLayer.effects` holds the enabled effects with keyframe-evaluated params.
- `canvas.ts` `get2d` accepts `willReadFrequently`; renderer scratch canvases use it, since effects read them back.
- `CompositionPreview`: optional `draftTimeline` prop for previewing uncommitted edits made by pure ops.

### Fixed
- The box blur's out-of-region handling would have faded full-frame layers to transparent at the canvas border. It now uses edge replication.

### Not included (per scope)
Transitions, LUTs, masks, audio effects, AI effects, GPU backend.
