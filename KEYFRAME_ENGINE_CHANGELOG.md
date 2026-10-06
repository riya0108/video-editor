# Keyframe Animation Engine — Changelog

## Phase 8 (2026-10-02)

### Added
- **One keyframe engine for every layer kind** (`src/lib/animation/`):
  - `easing.ts`: easing registry (linear, ease-in, ease-out, ease-in-out, hold, arbitrary cubic-Bézier via a Newton/bisection solver); `registerEasing` extension point for custom curves and spring; validation of easing from files.
  - `keyframes.ts`: `Keyframe` / `KeyframeTrack` / `ClipAnimation` types (clip-relative frames, outgoing-segment easing), `evaluateTrack` (binary search, hold before/after), upsert/sort/shift helpers, prev/next navigation, validation of untrusted data.
  - `properties.ts`: animatable property registry (position X/Y, scale X/Y, rotation, opacity, crop ×4) with `registerAnimatableProperty` as the extension point; `applyAnimation(clip, frame)` (returns the same object for static clips) and `valueAt`.
- **Timeline ops / engine** (all pure, one undo step each):
  - `addKeyframe`, `removeKeyframe`, `moveKeyframe`, `moveKeyframesAtFrame`, `updateKeyframe` (value/easing), `setPropertyAnimated` (stopwatch).
  - `setClipVisualsAtFrame`: keyframe-aware edit (auto-key) used by every existing editing path.
  - `editClips(…, frame)` for frame-aware content + visual edits.
- **UI:**
  - ◆ keyframe toggles on X, Y, Scale X/Y, Rotation, Opacity and Crop in the Transform inspector, which now shows evaluated values at the playhead.
  - `KeyframesPanel`: per-property keyframes with jump, frame, value, easing, delete, and prev/next navigation.
  - Keyframe diamonds on the selected clip's timeline bar (click to jump, drag to retime).
- **Project format v5:** `animation` persisted and validated on load.
- Docs: `KEYFRAME_ENGINE_ARCHITECTURE.md`, `KEYFRAME_ENGINE_TEST_REPORT.md`, this changelog.
- Tests: `src/lib/animation/animation.test.ts` (25).

### Changed
- `resolve.ts`: the single evaluation point. Each clip is evaluated at the frame being rendered before placement is computed, for every renderer and every layer kind. A live drag override takes precedence.
- `trimClip` (start) shifts keyframes to stay at the same moment; `splitClip` gives both halves the full (shifted) animation so curves are unchanged; `duplicateClipsAsLayers` offsets animated position too.
- Composition playground: all visual commits go through `setClipVisualsAtFrame` at the playhead; text/graphic resize commits are frame-aware.
- `NumberField` accepts an optional keyframe control. The Rotation field no longer wraps typed values (needed for multi-turn keyframes).
- New error reasons: `invalid-keyframe`, `keyframe-conflict`.

### Unchanged by design
- Clips without `animation` render and edit exactly as before. Verified by the full pre-existing suite plus explicit identity/equivalence tests.

### Not included (per scope)
Advanced effects, transitions, captions, audio automation, AI editing. Color interpolation, graph editor, and spring easing are future work on this engine.
