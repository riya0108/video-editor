# Phase 16 — Export System: Changelog

## Added

- **Presets** (`src/lib/export/presets.ts`): Instagram Reel, YouTube, YouTube Shorts, Square and Custom, with platform guidance (length and bitrate warnings). Frame rate follows the project when it's a standard delivery rate.
- **Export profiles** (`src/lib/export/profile.ts`): resolution, framing, FPS, container, video codec, quality level or target bitrate (VBR/CBR), audio codec, audio bitrate and alpha. Includes a quality→bitrate model with per-codec efficiency, profile checks (errors + warnings) and container/codec normalisation.
- **Export job system** (`src/lib/export/queue.ts`):
  - `queued → processing → completed | failed | cancelled`, with enforced transitions and per-job history;
  - sequential runner;
  - timeline snapshot at enqueue;
  - weighted progress with ETA;
  - cancel for queued and processing jobs;
  - "completed" only when every read-back check passed.
- **Render engine extensions** (`src/lib/render/`):
  - containers MP4 / MOV / WebM;
  - explicit codecs H.264 / HEVC / AV1 / VP9 / VP8, never silently swapped;
  - AAC / Opus;
  - alpha output (WebM VP9/VP8);
  - **framing** fit (letterbox) / fill (crop) for outputs of another shape;
  - any even size up to the H.264 level 5.1 frame limit;
  - any whole frame rate 1–120;
  - CBR/VBR.
- **New read-back checks:**
  - file written and readable;
  - container;
  - video codec;
  - measured bitrate ceiling;
  - alpha present/absent and decoded alpha fidelity;
  - audio codec with measured bitrate;
  - decoded audio duration;
  - video/audio decode failures as named checks.
- **Audio encoder preflight:** the exact audio configuration is test-encoded before any frame is rendered.
- **Export panel UI** (replaces the Phase 15 "Export video" box):
  - preset chips and every setting;
  - live summary, errors and warnings;
  - job list with status, progress (phase, frames, %, ETA), Cancel, Download (also for failed files, marked), Remove, and an expandable per-check report.
- Tests: `src/lib/export/export.test.ts` (29), `src/lib/export/export-real.eval.test.ts` (ffmpeg checks of real exports), browser harness `src/lib/export/export-harness.ts`.
- Docs: `EXPORT_ARCHITECTURE.md`, `EXPORT_TEST_REPORT.md`, this file.

## Fixed (found by real exports)

- **Opus audio was cut 20 ms short.** The end trim ignored the Opus pre-skip and dropped the last packet; it now cuts in presentation time.
- **Audio duration was judged from container metadata.** It is now measured by decoding, bounded by the container's presentation end.
- **AAC 384 kbit/s fails every encode on macOS Chrome** despite reporting support. YouTube/Shorts presets now use 320 kbit/s, 384 is no longer offered, and the preflight fails such configurations in ~20 ms instead of after the full render.
- **A corrupt bitstream during validation threw and lost the report.** It is now a failed check, and the file is kept.
- **Fidelity passed when decoding broke off early.** It now requires every checkpoint.

## Changed

- `RenderSettings` gained `container`, `videoCodec`, `alpha`, `framing` and `bitrateMode`. `OUTPUT_FRAME_RATES` now lists 24/25/30/48/50/60. Sizes and rates outside the old fixed lists are accepted when valid (even sizes, whole rates).
- `RenderPlan` carries `placement`.
- `AudioOutputSettings.codec` is `"aac" | "opus"` and is honoured exactly. The old silent AAC→Opus fallback is gone; the Phase 15 automatic H.264 fallback remains only when no codec is specified.
- **Opus in MP4 is not offered.** Mediabunny writes no edit list for it, so the audio would play 13.5 ms long.
- `technicalChecks` takes the configured codecs. `fidelityCheck` takes the expected checkpoint count.
- Phase 15 settings tests updated to the widened size/rate rules.
