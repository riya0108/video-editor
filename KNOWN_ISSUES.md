# Known Issues — Phase 19 QA

> **Superseded by FINAL_KNOWN_ISSUES.md / PRODUCTION_READINESS_REPORT.md (Phase 20, RC2).** Since this was written, P1-1 (Dissolve false-fail) and P1-2 (long-export memory) have been **fixed and verified**.

Severity:

- **P0 — critical:** crash, data loss, or a core workflow impossible.
- **P1 — major:** a core workflow broken or misleading for common real-world input, with no good workaround.
- **P2 — moderate:** wrong or degraded behaviour with a workaround.
- **P3 — minor:** polish, copy, or edge cases not reachable from the UI.

Every issue was found in the live editor (see FULL_QA_REPORT.md for how it was reproduced).

## P0 — critical

### P0-1 — WebM videos imported as audio, or rejected · **FIXED**

- **Repro:** drop any `.webm` video (a browser screen recording, or this app's own WebM / transparent export).
  - With a soundtrack: it was added as an **audio clip with no picture**.
  - Without one (e.g. VP9 + alpha): it was refused with "couldn't decode the audio…".
- **Cause:** `AUDIO_EXT` in `src/lib/audio/safety.ts` includes `webm`, and `isAudioFileName` matched on the extension even when the type was `video/webm`.
- **Fix:** `refineImportKind` in `src/lib/composition/media-import.ts`, called by the editor's import.
  - A `.webm`/`.ogg` not labelled `audio/*` is probed once for a video track (`<video>` metadata).
  - Audio-only files stay audio.
- **Verified:**
  - 5 unit tests.
  - Live: `alpha.webm` imports as a video layer and `voice-memo.webm` (Opus only) as audio.
  - Project 9 then exported a valid transparent WebM.

## P1 — major

### P1-1 — Export using the "Dissolve" transition is reported as FAILED · open (release blocker)

- **Repro:** any project with the built-in **Dissolve** (dither) transition → Export (any preset). Project 7 in the QA set reproduces it.
- **Observed:**
  - "Validation failed: Encoded frames match the render — 24 checkpoint frames, worst 21.7 dB at frame 108 (minimum 30 dB)".
  - The job is marked **failed** and the file is named `…-FAILED-VALIDATION.mp4`.
- **The file itself is fine:** frame count, timing and audio checks pass, and the content is correct.
  - The 2 px random dither pattern can't survive H.264 4:2:0 compression: 25.3 dB even at 40 Mbit/s.
  - Without the grain effect, it still fails at 26.1 dB.
  - The cross-dissolve and every other transition pass.
- **Cause:** the fidelity check treats encoder loss on high-detail content as a render error.
- **Workaround:** use Cross-dissolve, or set the Dissolve grain size larger.
- **Fix options** (not done: each is a decision about how strict validation is):
  - (a) compare checkpoints at a lower resolution, or after a blur, so codec noise averages out;
  - (b) scale the PSNR threshold with the reference frame's high-frequency energy;
  - (c) exempt frames inside a dither dissolve from the fidelity check (the structural cross-check still covers them).

### P1-2 — Exports are held entirely in memory; long exports can run out · open (release blocker for long-form)

- **Measured:** a 10-minute 1080p30 export (609 MB file) peaked at **≈ 2.3 GB** JS heap (≈ 3.8× the file size) and then fell back to 164 MB, so there's no leak.
  - Cause: the render job writes to a Mediabunny `BufferTarget`, then copies the whole file into a `Blob`.
- **Risk** (extrapolated from the measured ratio, not reproduced): a 30-minute 1080p export (≈ 1.8 GB) would need ≈ 7 GB, beyond a Chrome tab's limit, so the tab would crash and the export would be lost.
- **Fix direction:** stream to disk (Mediabunny `StreamTarget` → a `FileSystemWritableFileStream` from a save picker) instead of buffering.

### P1-3 — Audio files longer than 30 minutes are refused · open

- **Repro:** import a 31-minute podcast WAV.
- **Observed:** "31 minutes is longer than the 30-minute limit for one audio file. Split it into shorter parts…". The message is clear and nothing crashes.
- **Cause:** a deliberate decode budget (`src/lib/audio/safety.ts`). The whole file is decoded to Float32 PCM (≈ 690 MB for 30 min stereo).
  - Measured: with a 25-min file loaded, the heap was ≈ 420–500 MB.
- **Impact:** full podcast episodes and long recordings can't be edited without splitting them first.
- **Workaround:** split the file (as the message says).
- **Fix:** streaming or windowed decode. That's new functionality, so it's out of scope for this phase.

## P2 — moderate

### P2-1 — Full-frame CPU effects make exports slower than realtime · open

- **Measured:**
  - Project 3 (blur + vignette on a full-frame still, glow on the product): 6 s exported in **30.7 s**.
  - Project 6 (exposure on a full-frame cover image): 83.7 s in **138.6 s**.
- **Cause:** effects run on the CPU per frame. An effect on a *still* image is recomputed for every frame although its input never changes. (Effects on the GPU or in a worker was the recommended next step in PERFORMANCE_OPTIMIZATION_REPORT.md §8.)
- **Workaround:** none needed for correctness; the exports are valid, only slow.

### P2-2 — A truncated / damaged video imports silently · open

- **Repro:** import an MP4 cut short, so its header claims more duration than its data holds.
- **Observed:**
  - It imports with no warning.
  - After the real data ends, the picture holds the last decodable frame for the rest of the clip, in preview and in export.
  - Its soundtrack is reported as "no audio", although the first ≈ 12 s of AAC are intact.
  - The export validates, because the file is internally consistent.
- **Expected:** a warning like the one truncated WAVs already get ("header says 10.0 s but only 0.5 s… is present"), and the intact part of the audio kept.

### P2-3 — Exporting past the end of a truncated video was ~15× slow · **FIXED**

- **Cause:** a Phase 18 regression. `SequentialFrameCursor` restarted the decoder for every frame requested past the end of a finished stream.
- **Fix:** hold the last frame.
- **Verified:** unit test; live, 1,800 frames went from > 150 s to 9.3 s, and the export is valid.

## P3 — minor

| ID | Issue | Notes |
|---|---|---|
| P3-1 | **No "New project" command.** A fresh page always opens the demo project; starting from scratch means deleting the demo content. | Persistence handles a fresh project correctly; only the command is missing. |
| P3-2 | **Multi-file drop stacking:** each dropped file lands on top, so the *last* file in a drop is frontmost. Dropping "product.png + background.webp" hides the product behind the background. | User reorders the tracks. |
| P3-3 | **Caption tracks overlap:** every imported/generated caption track defaults to the same position, so 2+ caption tracks draw on top of each other. | Track placement can be changed. |
| P3-4 | **Corrupt-file message:** random bytes or a renamed PNG as `.mp4` get "couldn't play the video (…PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN…). It may use a codec your browser lacks…". It blames a codec and shows Chrome internals for what is a damaged / non-video file. | Copy. |
| P3-5 | **Dropping an `.srt`/`.vtt` on the editor** says "doesn't look like an image or video" instead of importing it as captions (the Captions panel does that). | Route subtitle files to the caption import. |
| P3-6 | **Engine API edges (not reachable from the UI):** <br>• `insertClip` of a text clip with a partial `textStyle` stores it un-normalized; it's normalized on reopen, and renders are identical. <br>• `trimClip(end)` before the clip start clamps to a 1-frame clip instead of refusing. | Found by the QA harness. |
| P3-7 | **Project frame rate is fixed at 30 fps.** 24/25/60 fps footage is conformed to 30 (exports can still be made at 24–60 fps by resampling). | Product decision. |
| P3-8 | **Large projects in the UI** (61 tracks / 601 clips, development build): playback 48.8 fps with 8 long tasks (max 115 ms); edit → paint 20–40 ms (first 128 ms). | Development build only; Phase 18 found React's cost to be ~0.5 ms per frame in production. |

## Not issues (verified, recorded so they aren't re-reported)

- Clipping warnings on Projects 2, 9 and 10 are correct: the mixes really exceed 0 dBFS.
- The 30-min refusal's message and the "Shorts accepts ≤ 3 min" warning are accurate.
- The `beforeunload` "unsaved changes" prompt fires correctly.
- Background-removed video, reframe crop, and the masked-video coverage in Project 9 were all checked numerically and are correct.
