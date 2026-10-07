# Final Rendering Engine — Changelog

## Phase 15 (2026-10-07)

### Added
- **Render engine** (`src/lib/render/`):
  - `settings.ts`: output sizes 1080×1920, 1920×1080, 1080×1080, 2160×3840; 24/25/30/50/60 fps; aspect must match the composition (same aspect at another size renders at a scale); high-quality default bitrate.
  - `plan.ts`: deterministic render plan. Exact frame count and duration; exact rational time mapping for any project/output rate pair; media sampled at each output frame's centre; validation checkpoints.
  - `graph.ts`: render graph description, and an independent per-frame cross-check of layer order, presence, effects, masks, mattes, keyframes, transitions and text against the raw timeline.
  - `audio.ts`: offline mix to exactly the video's duration; clipping reported; strict on undecoded audio.
  - `job.ts`: browser render job. `FinalRenderer` → WebCodecs H.264 → MP4 (Mediabunny); AAC encoded directly with measured priming compensation and exact end trim; the file is read back and validated; progress and cancel.
  - `validate.ts`: technical checks (size, frame count, fps grid, duration, audio format/duration), A/V sync by cross-correlation, PSNR fidelity, reports.
  - `probe-project.ts` / `probe-harness.ts`: test fixtures for real rendering tests.
- **`FinalRenderer.renderFrame(timeline, frame, { outputScale, mediaFrameOffset })`:** output scale and media-time offset; fractional frames.
- **UI:** `VideoExportPanel` in the composition editor (size, fps, progress, cancel, validation report, download).
- **Dependency:** `mediabunny` (MPL-2.0), added to Vite's pre-bundled deps; noted in `MODEL_LICENSES.md`.
- **Tests:** `render.test.ts` (26), `real-render.eval.test.ts` (54 checks over 9 real MP4s, decoded by ffmpeg; skips without local assets).
- **Docs:** `RENDER_ENGINE_ARCHITECTURE.md`, `RENDER_ENGINE_TEST_REPORT.md`, this changelog.

### Changed
- `MediaFrameProvider`: frame-sequence sources pick `⌊sourceFrame + 0.5⌋` (`sequenceFrameIndex`), matching what a video seek shows. Identical for whole frames, so preview is unchanged.

### Fixed (found by real rendering)
- Audio 44 ms late: AAC priming was untrimmed. Now measured and trimmed via an edit list.
- Audio track 31 ms longer than the video: encoder padding. Now cut to the video's end.

### Unchanged
- The preview path, the project format (v10), source media.
