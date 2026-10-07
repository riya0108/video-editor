# AI Editing Engine — Changelog

## Phase 14 (2026-10-06, finished 2026-10-07)

### Added
- **AI editing engine** (`src/lib/ai/`):
  - `types.ts`: result, item, confidence and status model. Results are in source seconds; confidence carries its basis (model score, margin, heuristic, agreement).
  - `provider.ts` / `registry.ts`: one provider interface for models, classical CV, signal processing and heuristics. The registry reports every feature's availability honestly.
  - `jobs.ts`: FIFO job queue with progress, cancel, retry and timeout.
  - `errors.ts`: typed `AIError` codes with retryability.
  - `store.ts`: editable result store with validated item edits and its own JSON format.
  - `media.ts` / `media-browser.ts`: read-only frame and PCM access through the compositor and audio engine.
  - `session.ts`: editor-facing facade; validates inputs before queueing.
  - `apply.ts`: pure apply actions (split, cut ranges, label captions, mask/blur from a track, attach a layer, reframe, clean-plate layer, B-roll placeholders).
- **Twelve features** (`src/lib/ai/features/`): shot and scene detection, object and face detection (MediaPipe), speaker detection (MFCC clustering), silence detection, filler words (Whisper + lexicon), auto reframe, highlights, object removal (temporal clean plate), object tracking (NCC), B-roll suggestions.
- **Models:** `blaze_face_short_range.tflite` and `efficientdet_lite0.tflite` self-hosted in `public/models/` (Apache-2.0), with a provenance and hash notice. `MODEL_LICENSES.md` rows added.
- **`TimelineEngine.transact(fn)`:** runs a composed edit as one undo step.
- **UI:** `AIPanel` in the composition playground (capabilities, jobs, editable results, apply actions).
- **Tests:** `src/lib/ai/ai.test.ts` (44) and `src/lib/ai/real-voices.eval.test.ts` (4, skips without local assets).
- **Docs:** `AI_EDITING_ARCHITECTURE.md`, `AI_EDITING_TEST_REPORT.md`, this changelog.

### Fixed (found in live testing on 2026-10-07)
- Fast shot detection reported cuts half a frame early on sources whose frame rate isn't a multiple of 12 fps. Sampling now uses whole source frames.
- Object tracking jumped back to its start position when a loosely boxed target left the frame. A motion gate now requires strong evidence for far matches, so the target is reported lost instead.
- Object removal mistook the removed object leaving through the measurement ring for camera motion. It now uses the median ring variation.
- Auto reframe silently applied a 4.7× zoom when the composition's aspect didn't match the path's. It now refuses with an actionable message.
- The Scenes precision menu had the Shots menu's accessible name.

### Unchanged
- The project file format (v10). AI results are not stored in projects.
- Source media: never modified by analysis or by any apply action.
