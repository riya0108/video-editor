# Phase 16 — Export System: Test Report

Date: 2026-10-08.

**Environment:** macOS, Node 22, Vitest 5, ffmpeg/ffprobe (Homebrew, with libvpx, libdav1d), Chrome 154 via chrome-devtools-mcp (WebCodecs), Astro dev server (`/tools/video/composition-preview`).

## Summary

| Check | Result |
|---|---|
| Full test suite | **1151 passed**, 28 skipped (87 files); the skips are per-file eval tests that don't apply, e.g. alpha checks on opaque files |
| New: `src/lib/export/export.test.ts` | **29 / 29** |
| New: `src/lib/export/export-real.eval.test.ts` (real files, decoded by ffmpeg) | **48 / 48** applicable checks |
| Phase 15 suites (`render.test.ts`, real-render eval on the Phase 15 files) | all pass after updating 3 settings assertions to the widened rules |
| `tsc --noEmit` / `astro check` | **0 errors** / **0 errors, 0 warnings** |
| Production build | **Complete**; the render job is still a lazy chunk (551 KB, was 518 KB) |
| Real exports through the production queue + render job | **15 completed** (all checks), 1 cancelled, 1 preflight failure, 2 refused — each the expected outcome |
| Real-footage exports through the UI, by clicks | **3 completed, 2 cancelled** (one while processing, one while queued) |
| Mutation: sabotaged encoder | **failed** in both cases; control run completed |
| Browser console during all live tests | **0 errors / 0 warnings** |

## Bugs found by real exports, fixed

Each was caught by validating the file that was actually written. None was caught by the encoder, which returned without error every time.

1. **Opus audio 20 ms short (WebM)**
   - Seen: 3.98 s of audio for a 4.00 s video. ffmpeg decoded 191,688 samples instead of 192,000. The job was correctly marked **failed** by the audio-duration check.
   - Cause: Chrome's Opus encoder signals a 312-sample pre-skip (read from its OpusHead) and emits 201 packets for 200 frames' worth of input. The end trim cut in packet time and dropped the last packet.
   - Fix: cut in presentation time (`codecDelaySec`).
   - After: ffmpeg decodes 192,648 samples. That is ≥ 192,000; the tail is under one frame of padding silence that WebM can't trim (see 2).
2. **Opus in MP4 ran 13.5 ms long**
   - Seen: ffmpeg decoded 192,648 samples.
   - Cause: Mediabunny writes no edit list for an Opus track in MP4, so the encoder's last-frame padding can't be trimmed.
   - Decision: MP4/MOV take AAC only, where the edit list trims exactly (ffmpeg: 192,000 / 384,000 samples on every MP4/MOV export). Opus stays in WebM, where the ≤ 1-frame overhang is explicitly allowed and checked by ffmpeg (`n ∈ [audioSamples, audioSamples + 960)`).
3. **The validator read audio duration from metadata**
   - Seen: the 3.98 s file's container said otherwise.
   - Fix: the check now decodes the audio and uses where it actually ends.
   - Measuring that exposed a reader quirk: Mediabunny's decoder plays past an MP4/MOV edit list's end (4.0093 s) where ffmpeg stops at exactly 4.000 s. The decoded end is therefore bounded by the container's presentation end. Short audio is still caught, as a unit test confirms.
4. **AAC 384 kbit/s fails every encode on macOS Chrome**, although `AudioEncoder.isConfigSupported` says it's supported (reproduced standalone: 0 packets, `OperationError: Encoding error.`). The YouTube and Shorts presets failed after rendering all frames.
   - Fixes:
     - the presets use 320 kbit/s, the highest that encodes;
     - the UI no longer offers 384;
     - a new **audio preflight** encodes a test burst with the exact config before rendering.
   - After: a 384 kbit/s export fails in **22 ms** with "This browser's AAC encoder fails at 384 kbit/s although it reports support … Pick a lower audio bitrate."
5. **A corrupt bitstream lost the report**
   - Seen: under mutation (below), decoding during validation threw a bare "Decoding error.", so the job failed with no report and no file.
   - Fix: it is now a named failed check (`video-decode: The video can't be decoded at frame 15`), and the file is kept.
   - Also, fidelity now fails if fewer checkpoints were compared than taken (before, 2 good frames out of 14 would have passed).

## Real export matrix

All exports came from the Phase 15 probe project: a 4 s, 30 fps project with
- a frame-counter video, cut and cross-dissolve;
- a 50 %-alpha PNG;
- an effect, a mask and keyframes;
- text and a caption;
- a 44.1 kHz tone with beeps at 1.5 s and 3.0 s.

The "alpha" variant removes the video and makes the background transparent. Every export ran through `ExportQueue` → `renderTimeline` (`export-harness.ts`); files are in `.tmp-test-assets/phase16/final/` (git-ignored).

| Export | Output | Codecs | Framing (placement) | Status | In-app checks | Wall | Size | Video bitrate |
|---|---|---|---|---|---|---|---|---|
| reel (preset) | 1080×1920 @30 | MP4 H.264 + AAC 128k | same shape | completed | 17/17 | 10.0 s | 509 KB | 0.98 Mbit/s |
| youtube (preset) | 1920×1080 @30 | MP4 H.264 8 Mbit/s + AAC 320k | same shape | completed | 17/17 | 9.6 s | 275 KB | 0.38 |
| shorts (preset) | 1080×1920 @30 | MP4 H.264 + AAC 320k | same shape | completed | 17/17 | 21.1 s | 557 KB | 0.95 |
| square (preset) | 1080×1080 @30 | MP4 H.264 + AAC 192k | same shape | completed | 17/17 | 9.9 s | 255 KB | 0.47 |
| youtube-60 | 1920×1080 @60 | MP4 H.264 12 Mbit/s + AAC | same shape | completed | 17/17 | 18.9 s | 431 KB | 0.69 |
| webm-vp9-opus-720p | 1280×720 @30 (from 1920×1080) | WebM VP9 + Opus 160k | scale 2/3 | completed | 17/17 | 6.8 s | 620 KB | 1.09 |
| mp4-av1-60 | 1920×1080 @60 | MP4 AV1 + AAC 256k | same shape | completed | 17/17 | 12.8 s | 267 KB | 0.38 |
| mov-hevc-cbr-25 | 1080×1920 @25 | MOV HEVC 6 Mbit/s CBR + AAC 320k | same shape | completed | 17/17 | 5.6 s | 503 KB | 0.84 |
| mp4-vp9-noaudio-48 | 1080×1080 @48 | MP4 VP9 "max", no audio | same shape | completed | 13/13 | 10.3 s | 640 KB | 1.28 |
| webm-vp9-alpha | 1080×1080 @30 | WebM VP9 **alpha** + Opus | same shape | completed | 17/17 | 2.4 s | 208 KB | 0.14 |
| webm-vp8-alpha | 1920×1080 @25 | WebM VP8 **alpha** + Opus | same shape | completed | 17/17 | 23.7 s | 308 KB | 0.24 |
| fit-youtube-from-916 | 1920×1080 from a 9:16 comp | MP4 H.264 + AAC | fit: 608×1080 at x=656 | completed | 17/17 | 11.6 s | 240 KB | 0.31 |
| fill-square-from-169 | 1080×1080 from a 16:9 comp | MP4 H.264 + AAC | fill: 1920×1080 at x=−420 | completed | 17/17 | 6.4 s | 201 KB | 0.36 |
| fit-reel-alpha-bars | 1080×1920 from a 16:9 comp | WebM VP9 alpha + Opus | fit: 1080×608 at y=656, transparent bars | completed | 17/17 | 3.2 s | 148 KB | 0.10 |
| 4k-shorts | 2160×3840 @30 (from 1080×1920) | MP4 H.264 + AAC | scale 2 | completed | 17/17 | 11.1 s | 1.16 MB | 2.27 |
| cancel-mid | YouTube preset | — | — | **cancelled** at frame 30 (`queued>processing>cancelled`), no file | — | 1.3 s | — | — |
| preflight-aac-384 | YouTube + AAC 384k | — | — | **failed** in preflight (22 ms) | — | — | — | — |
| refused-hevc-webm | Custom WebM + HEVC | — | — | **refused** before queueing: "HEVC (H.265) can't go in WEBM. WEBM takes VP9, AV1, VP8." | — | — | — | — |
| refused-opus-mp4 | Custom MP4 + Opus | — | — | **refused**: "Opus audio can't go in MP4. MP4 takes AAC." | — | — | — | — |

The probe content is flat colour, so variable-bitrate files come out well under target. The real-footage UI exports below ran at 4.4–6.5 Mbit/s.

### Independent checks with ffmpeg (`export-real.eval.test.ts`)

Run on every completed file, against the requested profile and the rendered timeline.

| Check | Assertion |
|---|---|
| Container | WebM: EBML DocType `webm`. MP4: ftyp major brand `isom`. MOV: `qt  ` |
| Video | ffprobe codec name = requested (h264 / hevc / av1 / vp9 / vp8); exact W×H; `nb_read_frames` = plan; `r_frame_rate` = fps/1; every packet pts on the k/fps grid |
| Bitrate | Σ packet sizes from ffprobe → > 0 and ≤ 1.5 × target |
| Audio | codec, 48 kHz, 2 ch. Decoded sample count **exactly** = duration × 48 000 for MP4/MOV; for WebM in [exact, exact + 960). Both beep onsets within **1 ms** of 1.500 s / 3.000 s. No audio stream when "no audio" was chosen |
| Source frame per output frame | through the placement: crop of the composition's counter rows at (P.x, P.y). Every frame outside the dissolve decodes to ⌊(k + ½)·30/fps⌋ (+ in-point jump). Covers 25/30/48/60 fps, scale 2/3 and 2, fit letterbox |
| Framing | fit: the middle of each bar is black (≤ 20) or fully transparent (α ≤ 4). fit and fill: the keyframed box centre lands at P.x + key(t)·scale within 2.5 px, at full scaled width — proves both scale and offset |
| Alpha | decoded with libvpx (keeps the alpha side stream) to RGBA at 3 frames: empty area α ≤ 4; 50 % logo α = 128 ± 20 and red; masked shape α ≥ 247; outside the ellipse mask α ≤ 4. Includes transparent letterbox bars |
| Job outcomes | every completed job has a 100 % passing report; the cancelled job left no file; refused combos were never queued; the 384k preflight failure is reported as such |

**Result: 48 / 48.**

## Mutation: "never report success because the encoder returned"

Run live in the browser through the real queue (Square preset):

| Sabotage (no error raised anywhere) | Job | Failed checks |
|---|---|---|
| `VideoEncoder.encode` silently drops every 10th frame | **failed** | frame-count 108/120; fps (frames off the grid by 366.7 ms); duration 3.9667 s; fidelity 18.7 dB at frame 59 |
| Every 3rd delta packet's second half zeroed | **failed**, file kept | video-decode at frame 15 (after fix 5) |
| Control, unpatched | **completed** | — |

The earlier pre-fix Opus files also act as mutations for the independent suite:
- the 20 ms-short WebM (191,688 samples) fails its `≥ exact` bound;
- the MP4+Opus file (192,648 samples) fails its `= exact` bound.

## UI test (real footage, by clicks)

On the playground's demo project (1920×1080, 30 fps, 8 s):
- real video;
- alpha-matte PiP;
- transparent logo;
- glowing star;
- badge;
- title;
- captions.

Steps:
1. Queued **YouTube**, **Instagram Reel** and **Square** with the panel's buttons while the first render was running, plus a duplicate YouTube job.
2. Cancelled the duplicate YouTube job while processing: `queued>processing>cancelled`, and the next job started.
3. Cancelled Square while queued: `queued>cancelled`, never started.

Results:
- **YouTube:** completed, 17/17, 240 frames, 6.45 MB, rendered in 34.7 s. A second YouTube job completed identically.
- **Instagram Reel:** completed, 17/17. The report carries "Letterboxed: the 1920×1080 composition is scaled to 1080×608 and centred in 1080×1920, with black bars." A decoded frame shows the full composition centred with black bars.

ffprobe agrees on both files: 240 frames, 30/1, 8.000 s, AAC 48 kHz stereo, exactly 384,000 decoded audio samples.

Live progress read during a render: "Rendering frames 100 / 240 · 37 % · 25 s left".

**Test-tool note:** a chrome-devtools click on a preset chip scrolled just under the site's sticky header landed on the header (`elementFromPoint` confirmed it). This is a positioning artifact of the automation, not an app bug: with the panel scrolled into view, every click worked.

## Automated (Node): `export.test.ts`

| Area | What is asserted |
|---|---|
| Presets | exactly the five; each yields an error-free profile and an identity placement on a matching composition; YouTube 8/12 Mbit/s by rate and AAC 320k; Reel/Square at "high"; frame rate follows the project (25, 60, 24) and falls back to 30 for 29.97; Custom starts at the composition size with "match"; Reels/Shorts > 3 min and > 50 Mbit/s are warnings, never errors |
| Profile → settings | quality bitrate formula, codec efficiency and clamps; every field reaches `RenderSettings` exactly; container↔codec pairs refused with the reason (H.264 in WebM, AAC in WebM, VP9 in MOV, alpha in MP4/AV1); `normalizeProfile` repairs them; bitrate ranges; uneven-cadence warning |
| Framing | match refuses; fit 1920×1080 → 1080×1920 = 1080×608 at y = 656; fill → 1920×1080 at x = −420; same shape = identity |
| Read-back checks | a correct probe passes every new check; each defect fails only its own (container, codec, 1.6× bitrate, zero bytes, unrequested alpha, audio codec); alpha check (lost alpha, bad frame, nothing compared); alpha PSNR; fidelity fails when decoding broke off |
| Audio fixes | OpusHead pre-skip parsing (312 samples; buffer and view; none for AAC); the live 20 ms-short case fails; WebM overhang < 1 frame passes, > 1 frame fails; MP4 at +13.5 ms fails; decoded end bounded by the container's end; short decoded audio caught |
| Job system | the transition table; queued → processing → completed only with a passing report; sequential and in order; a failed check → failed with the check named, and the file kept; errors (incl. `RenderPlanError` reasons) → failed; cancel queued / processing / finished; a render finishing after Cancel is still cancelled; timeline snapshot isolation; progress fraction, ETA, monotonic, immutable snapshots; remove only finished; file names |

## Not covered

- Long exports (minutes) and memory over long 4K renders. Exports here were 4–8 s.
- Encoders other than this Mac's Chrome (Windows/Linux, other GPUs). The preflight and read-back validation are designed to catch their quirks, but weren't run there.
- Playback of the files in Instagram/YouTube themselves. Files follow published upload specs, but no upload was made.
