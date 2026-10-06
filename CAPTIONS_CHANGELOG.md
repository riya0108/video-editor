# Captions — Changelog

## Phase 12 (2026-10-03)

### Added
- **Caption clips and tracks:** `ClipKind "caption"` (text, clip-relative word timings, speaker) and `Track.caption` settings (style, preset, language, speaker colors).
- **`src/lib/captions/caption-model.ts`:**
  - Caption style settings, defaults, validation, 8 presets.
  - The Text Engine bridge (`captionTextStyle`, `captionDefaultVisual`, `captionDisplayText`).
  - Word-timing helpers: retime on correction, split, spread, `activeWordIndex`; millisecond precision.
- **`src/lib/captions/subtitle-io.ts`:** lenient SRT/VTT parser (speakers, inline word timestamps, warnings) and SRT/VTT/karaoke-VTT export.
- **`src/lib/captions/segmenter.ts`:** words → caption segments (subtitle / short-form profiles) and 16 kHz mono conversion.
- **`src/lib/captions/timeline-bridge.ts`:** caption-aware base visual and concrete placement for keyframing.
- **Ops / engine:**
  - `addCaptionTrack`, `importCaptionCues`, `captionCuesOf`.
  - `updateCaptionText`, `setCaptionSpeaker`, `setCaptionWords`, `setCaptionTiming`.
  - `setCaptionTrackSettings`, `applyCaptionPreset`, `mergeCaptionWithNext`.
- **UI:**
  - `CaptionsPanel`: generate, import, export, presets, styling, positioning, segment editor.
  - Caption clips on the timeline.
  - Inline caption editing on the canvas.
- **Speech-to-text on the timeline's own audio mix** (or one clip's track), so captions land at timeline positions.
- **Project format v9.**
- Tests: `src/lib/captions/captions.test.ts` (22).
- Docs: `CAPTIONS_ARCHITECTURE.md`, `CAPTIONS_TEST_REPORT.md`, this changelog.

### Changed
- `auto-caption.ts`: the transcription core is extracted as `transcribeAudio16k(pcm)`; `transcribeWords` is unchanged in behavior.
- `resolve.ts`: a caption branch (caption → text layer through `cachedTextLayout`); `effectiveVisual` uses `clipBaseVisual`.
- `operations.ts`:
  - `splitClip` splits caption words.
  - `trimClip` shifts caption words.
  - Visual patches use the caption base visual.
  - Keyframe ops make caption placement concrete.
- `CompositionPreview`: double-click/Enter edits captions in place (same overlay as text).
- `TimelinePanel`:
  - Adaptive ruler step (m:ss labels).
  - No ＋ transition buttons on caption tracks or on clips too narrow to click.
  - Caption clip color and labels.

### Fixed (found during this phase)
- VTT inline timestamps leaked into the caption text.
- Float noise in word timings.
- "Selected clip only" also transcribed other tracks.
- Async generation read render-time state.
- The preset label didn't switch to "Custom" after hand-tuning.
- The ruler smeared on long timelines.
- ＋ button clutter on caption tracks.
