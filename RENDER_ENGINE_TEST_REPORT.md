# Phase 15 — Final Rendering Engine: Test Report

Date: 2026-10-07.

Environment:
- macOS, Node 22, Vitest 5, ffmpeg/ffprobe (Homebrew).
- Chrome via chrome-devtools-mcp (WebCodecs H.264 + AAC).
- Astro dev server (`/tools/video/composition-preview`).

## Summary

| Check | Result |
|---|---|
| Full test suite | **1074 / 1074 passed** (85 files) |
| New: `src/lib/render/render.test.ts` | **26 / 26** |
| New: `src/lib/render/real-render.eval.test.ts` (9 real MP4s, decoded by ffmpeg) | **54 / 54** |
| Type checking / `astro check` | **0 errors** / **0 errors, 0 warnings** |
| Production build | **Complete**; render job is a lazy 518 KB chunk |
| Real renders: 4 resolutions, 5 frame rates, 9 files | **9 / 9 passed in-app validation and every independent check** |
| Real-footage export through the UI (demo project, 8 s) | **Rendered and validated**, every check passed |
| Determinism (full-res SHA-256, rendered twice) | **identical** at 4K60 (7 frames) and 1080p25 (5 frames) |
| Browser console during all live tests | **0 errors / 0 warnings** |

## Bugs found by real rendering, fixed

Both were caught by the in-app validator *and* by ffmpeg, and both have regression coverage.

1. **Audio was 44 ms late** (beeps decoded at 1.544 s / 3.044 s instead of 1.500 / 3.000).
   - Cause: AAC priming (2112 samples) in the decoded stream, with no edit list to trim it.
   - Fix: measure the encoder delay per configuration (encode and decode a noise burst, cross-correlate) and start the audio track that far before zero, so the muxer writes an edit list.
   - After: +0.00 ms in-app; ffmpeg places the beeps at exactly 1.500 / 3.000 s.
   - The new in-app **audio-sync** check would have flagged it ("+44.00 ms", unit-tested).
2. **Audio track ran 31 ms past the video** (4.0307 s for a 4.000 s video).
   - Cause: encoder end padding and an extra flushed frame.
   - Fix: drive the AAC encoder directly, drop packets past the end, and cut the last packet's duration.
   - After: ffmpeg decodes exactly 192,000 samples (4.000 s) from a 4.000 s video. The audio-duration tolerance was tightened from one AAC frame to 1 ms, with the 4.0307 s case as a unit test.

Also found while writing tests:
- **Lag measurement on wideband audio:** the first coarse search (plain decimation) misread a 1-sample shift as 1276. Fixed by correlating amplitude envelopes coarse and raw samples fine. A unit test recovers shifts 0, 1, 2112, −37 and 5000 exactly.
- **Frame-sequence mattes vs. video:** a matte sequence used ⌊sf⌋ while video seeks show ⌊sf + 0.5⌋. They are identical for whole frames, but rate conversion would have put a video and its matte a frame apart. Fixed (`sequenceFrameIndex`), with a unit test.

## Real rendering tests

### Probe project (`probe-project.ts`)

A 4 s, 30 fps timeline that places every feature on the validation list at a known spot, at any composition shape:

| Element | What it proves |
|---|---|
| Frame-counter video: each frame's number as 10 binary blocks, fit "fill"; cut at 2 s where the source jumps 59 → 90, under a 0.5 s cross-dissolve | which **source** frame every output frame shows; transitions |
| 50%-alpha red PNG | alpha |
| Yellow rect + saturation −1 | effects |
| Green rect + ellipse mask | masks |
| Blue box, x keyframed 0.15W → 0.85W over 0–3 s, in front of the yellow rect | keyframes, transforms, layer order |
| Title text | text |
| Caption 1.0–2.5 s | captions |
| 44.1 kHz mono tone with 1 kHz beeps, placed at 0.5 s | resampling, audio duration, A/V sync |

Rendered by the production `renderTimeline` in Chrome, saved, then checked in Node by `real-render.eval.test.ts` with **ffmpeg as an independent decoder**, against expectations computed from the rendered timeline's own data (keyframe tracks, transition windows, layout).

### Matrix

All 9 files passed every in-app check and all 6 independent checks each (54 total):

| Output | Composition | Scale | Frames | In-app | Render time | Size |
|---|---|---|---|---|---|---|
| 1920×1080 @ 24 | 1920×1080 | 1 | 96 | ✓ | 5.6 s | 170 KB |
| 1920×1080 @ 25 | 1920×1080 | 1 | 100 | ✓ | 4.9 s | 161 KB |
| 1920×1080 @ 30 | 1920×1080 | 1 | 120 | ✓ | 6.2 s | 206 KB |
| 1920×1080 @ 50 | 1920×1080 | 1 | 200 | ✓ | 9.6 s | 309 KB |
| 1920×1080 @ 60 | 1920×1080 | 1 | 240 | ✓ | 11.6 s | 385 KB |
| 1080×1920 @ 30 | 1080×1920 | 1 | 120 | ✓ | 6.5 s | 499 KB |
| 1080×1080 @ 30 | 1080×1080 | 1 | 120 | ✓ | 6.2 s | 243 KB |
| 2160×3840 @ 30 | 1080×1920 | 2 | 120 | ✓ | 10.2 s | 1.1 MB |
| 2160×3840 @ 60 | 1080×1920 | 2 | 240 | ✓ | 19.8 s | 2.3 MB |

The probe content is flat colour, so the variable-bitrate files are small. The real-footage export ran at 7.3 Mbit/s against a 9.3 Mbit/s target.

### Independent checks (ffmpeg), per file

| Check | Assertion |
|---|---|
| Format | ffprobe: exact W×H, `nb_read_frames` = plan, `r_frame_rate` = fps/1, duration to 1 ms, H.264; AAC 48 kHz stereo; decoded audio sample count **exactly** = duration × 48000 |
| Source frame per output frame | every frame outside the dissolve: the decoded counter equals ⌊(k + ½) × 30 / fps⌋ (+ the in-point jump after the cut). Covers 24/25/30/50/60 from a 30 fps project, plus scale 2 |
| Cross-dissolve | the window's middle frame: each counter block equals the transition model's progress mix of the two clips' bits (±18 levels) |
| Keyframes / transforms | 5 frames: the blue box centre is within **2 px** of the keyframe track evaluated at that output frame; full width preserved |
| Layer order | the frame where the box crosses the yellow rect: the overlap is blue |
| Effect | the yellow rect is neutral gray (channel spread < 14) at full luma |
| Mask | centre green; a corner outside the ellipse shows the layer beneath |
| Alpha | 50% red over gray: R − G ≈ 127 (±22), G ≈ B |
| Text | white glyph pixels present in the title band |
| Caption | absent on the frame before its first output frame, present on its first and last, absent on the next |
| Audio sync | both beep onsets within **1 ms** of 1.500 s and 3.000 s |

### Sensitivity (mutation)

With the rate-conversion offset disabled (`mediaFrameOffset = 0`) and a 60 fps re-render:
- the independent suite **failed** at the first converted frame ("k=1 → 1", expected 0), and the dissolve check failed too;
- the in-app validator still passed.

This is expected and documented (architecture §8): in-app validation proves the file faithfully encodes what was rendered; the time mapping itself is proven by these tests. The fix was restored afterwards.

### Real footage through the UI

Exported the playground's demo project (main video, alpha-matte PiP, transparent logo, glowing star, badge, title; 1920×1080, 30 fps, 8 s) with the Export video panel. The panel showed "Rendered and validated" with every check passing:
- 240 frames, every timestamp on the 30 fps grid;
- audio exactly 8.0000 s, in sync at +0.00 ms, correlation 1.000;
- structure cross-checked on all 240 frames;
- worst fidelity 43.4 dB.

ffprobe agrees: 240 frames, 30/1, 8.000 s video and audio. A decoded frame shows every layer as composed.

**Cancel** at frame 22 / 240 returned the panel to idle with no error and no partial report. Only same-shape sizes are selectable.

## Automated (Node): `render.test.ts`

| Area | What is asserted |
|---|---|
| Settings | exactly the four sizes and five rates; same aspect → scale (2160×3840 from 1080×1920 = 2); a different aspect, size or rate refused with the reason; bitrate formula and clamps |
| Plan | native rate = one output frame per timeline frame, zero offset; every rate gives 4 × fps frames, 4 s, 192,000 audio samples; a non-whole duration rounds up (31 frames @ 30 → 26 @ 25); time mapping exact one hour in, for all 25 rate pairs; media sampled at the output frame's centre for 15 pairs; matte sequence agrees with video seeks; checkpoints include first, last, clip edges and the transition centre; empty timeline / bad settings → `RenderPlanError` with every reason; audio track only when something is audible |
| Render graph | chain description back to front; a correct frame passes the cross-check at every frame **and every half frame**; a swapped order, dropped layer or extra layer is caught; culled layers are legitimately absent; a wrong keyframe value, missing effect, missing mask, spurious matte and wrong transition progress are each caught by their own check |
| Audio | exact length at 24/25/60 fps, resampled 44.1 → 48 kHz, mono on both channels; clamping reported, never wrapped; chunks cover every sample once with exact timestamps; still-decoding/missing audio blocks, a silent video doesn't |
| Validation | a correct probe passes all 8 technical checks; each defect fails only its own check (size, dropped frame, wrong rate, long duration, short/long audio incl. the 31 ms bug, wrong sample rate, missing track); PSNR values; flatten over black; fidelity and structure reports; audio lag recovered exactly for 5 shifts; sync check flags +44 ms |

## Not covered

- Long renders (minutes) and memory over long 4K renders: renders here were 4–8 s.
- Encoders other than this Mac's (Chrome on Windows/Linux, hardware vs. software H.264). The delay calibration and validation are designed for that, but weren't run there.
- Audio from a video's own soundtrack in the probe matrix: the demo-project export covers a video with sound, the probes use a separate WAV.
