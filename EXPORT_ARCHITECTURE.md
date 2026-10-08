# Phase 16 — Export System: Architecture

The export system sits on top of the Phase 15 render engine (`RENDER_ENGINE_ARCHITECTURE.md`). The render engine turns a timeline into a validated file. The export system decides **what file** to make (presets and every encoding setting), **runs exports as jobs** in a queue with progress and cancel, and reports a job as completed only when the file read back from disk passed every check.

```
 Export panel ──▶ ExportProfile ──checkExportProfile──▶ RenderSettings ──▶ ExportQueue.enqueue(snapshot of timeline)
 (preset + edits)  (src/lib/export/profile.ts)          (render/settings.ts)            │
                                                                                         ▼  one job at a time
                       queued ──▶ processing ──▶ renderTimeline (render/job.ts) ──▶ file read back + validated
                         │            │                                                  │
                         │            ├── every check passed ─────────────────▶ completed
                         │            ├── an error, or any check failed ──────▶ failed (file kept for inspection)
                         └────────────┴── cancel ─────────────────────────────▶ cancelled
```

## 1. Files

| File | Role |
|---|---|
| `src/lib/export/presets.ts` | the five presets, platform guidance, delivery frame rate |
| `src/lib/export/profile.ts` | `ExportProfile`, quality → bitrate, profile checks, container/codec normalisation |
| `src/lib/export/queue.ts` | `ExportQueue`: job state machine, sequential runner, progress/ETA, snapshotting, file names |
| `src/lib/render/settings.ts` | (extended) containers, codecs, alpha, framing, custom sizes and rates, placement |
| `src/lib/render/plan.ts` | (extended) plan carries the new settings and the placement |
| `src/lib/render/job.ts` | (extended) output format per container, explicit codecs, alpha, framing composite, audio preflight, presentation-time audio trim, read-back probing |
| `src/lib/render/validate.ts` | (extended) container, codec, bitrate, alpha, decoded-audio duration checks |
| `src/components/tool/video/composition/VideoExportPanel.tsx` | the export UI (replaces the Phase 15 panel) |
| `src/lib/export/export-harness.ts` | browser test harness, not used by the app |

## 2. Presets (`presets.ts`)

| Preset | Size | Video | Audio | Container | Guidance (warnings only) |
|---|---|---|---|---|---|
| Instagram Reel | 1080×1920 | H.264, quality "high" (≈ 9.3 Mbit/s at 30 fps) | AAC 128 kbit/s | MP4 | ≤ 3 min |
| YouTube | 1920×1080 | H.264, 8 Mbit/s (≤ 30 fps) / 12 Mbit/s (> 30 fps) VBR | AAC 320 kbit/s | MP4 | > 50 Mbit/s is pointless |
| YouTube Shorts | 1080×1920 | as YouTube | AAC 320 kbit/s | MP4 | ≤ 3 min, > 50 Mbit/s |
| Square | 1080×1080 | H.264, quality "high" | AAC 192 kbit/s | MP4 | — |
| Custom | composition size | H.264 "high" | AAC 192 kbit/s | MP4 | — |

- **Frame rate:** every preset uses the project's rate when it is a standard delivery rate (24/25/30/48/50/60), else 30, so motion is never resampled without need.
- **Audio rate for YouTube:** YouTube recommends 384 kbit/s AAC. Chrome's macOS AAC encoder reports 384 kbit/s as supported, then fails every encode at it (found by a real export, §7). The presets use 320 kbit/s, the highest rate that encodes, and YouTube re-encodes uploads anyway.
- **Framing:** platform presets default to "fit" (see §3). On a composition of the same shape that changes nothing. On another shape it letterboxes, says so up front, and records it in the report. Custom defaults to "match".
- **Editing:** every field stays editable after picking a preset. The job is then labelled "YouTube (modified)". An untouched preset is rebuilt when the composition's size or rate changes.

## 3. Settings (`render/settings.ts`, `export/profile.ts`)

| Setting | Values | Notes |
|---|---|---|
| Resolution | any even W×H, 16–4096 per side, ≤ 9 437 184 px (H.264 level 5.1/5.2 max frame, e.g. 4096×2304) | standard sizes offered in a list |
| Framing | match / fit / fill | match refuses another shape (Phase 15 rule). fit scales the whole composition in, with black bars (transparent with alpha). fill covers the frame and crops symmetrically |
| FPS | whole numbers 1–120 (UI: 24, 25, 30, 48, 50, 60 + project) | the Phase 15 time mapping is exact for integer rates; NTSC fractional rates are not supported. A ratio that is neither a multiple nor a divisor of the project rate is warned about (uneven cadence) |
| Container | MP4, MOV, WebM | |
| Video codec | H.264, HEVC, AV1, VP9 (MP4) · H.264, HEVC (MOV) · VP9, AV1, VP8 (WebM) | an explicit codec is used exactly or the export fails before rendering; it is never swapped silently |
| Quality / bitrate | quality level (draft 0.05, standard 0.10, high 0.15, max 0.25 bits/pixel/frame × codec efficiency: H.264 1, HEVC 0.65, VP9 0.7, AV1 0.55, VP8 1.1; clamped 1–120 Mbit/s) **or** an explicit target bitrate, VBR or CBR | |
| Audio codec | AAC (MP4, MOV) · Opus (WebM) · none | Opus in MP4 is refused, see §7 |
| Audio bitrate | 96–320 kbit/s (API: 32–512), 48 kHz stereo | |
| Alpha | WebM + VP9 or VP8 only | Mediabunny encodes alpha as a second stream (Chrome's VideoEncoder has no native alpha) |

`checkExportProfile` validates everything at once and returns all errors (blocking) and warnings (informational). The Export button is disabled while there are errors, and each error says what to change.

### Placement (framing)

`placementFor(cw, ch, W, H, framing)` gives the scale and integer offset of the composition inside the output. The composition is rendered at that scale by the same `FinalRenderer` (text, shapes and SVG re-rasterised at output size, as in Phase 15). It is then copied 1:1 at an integer offset into the output frame, with no resampling. Examples:
- 1920×1080 → 1080×1920 fit: scale 0.5625, 1080×608 at y = 656;
- 1920×1080 → 1080×1080 fill: scale 1, 1920×1080 at x = −420.

## 4. Job system (`queue.ts`)

```
queued ──▶ processing ──▶ completed
  │            ├────────▶ failed
  └────────────┴────────▶ cancelled
```

- **Transitions** are a table (`JOB_TRANSITIONS`); any other move throws `InvalidJobTransition`. Every job keeps its status `history`.
- **Sequential:** one job renders at a time, in order. The renderer's exact-frame decoders are shared, so parallel renders would compete for them.
- **Snapshot:** `enqueue` deep-copies the timeline (`structuredClone`). Edits made while an export waits or runs never change what it produces.
- **Completed vs failed:** a finished render is **completed only if `report.ok`**, meaning every read-back check passed. A file that fails any check makes the job **failed** with the failed checks named. The file stays attached, downloadable as `…-FAILED-VALIDATION.ext`. An exception (plan refused, encoder error) is also **failed**, with its message.
- **Cancel:** a queued job goes straight to cancelled and never starts. A processing job is aborted: the render checks the signal between frames, before finalising and during validation, and the muxer output is cancelled. A render that finishes after Cancel was pressed is still recorded as cancelled, because the user asked for no file.
- **Progress:** one 0–1 bar across phases (preparing 2 %, frames 83 %, audio 5 %, writing 3 %, validating 7 %). The UI also shows the phase, frame *n / N*, and an ETA from the elapsed rate once frames are flowing. Each change emits a new immutable job object (`useSyncExternalStore`-friendly).
- **Remove:** only finished jobs can be removed. Download URLs are created on click and revoked after 10 s, so nothing leaks.

## 5. Validation of the written file

Phase 15 already read the file back. Phase 16 adds the checks the new settings need. A job is completed only if **all** of these pass:

| Check | How (on the file read back with Mediabunny) |
|---|---|
| file | blob non-empty and demuxable; an empty or unreadable file is a failed report, not an exception |
| container | demuxer's detected format MIME = requested (`video/mp4`, `video/quicktime`, `video/webm`) |
| video track, video codec | codec of the track = the codec requested (or configured) |
| resolution, frame count, fps, duration | as Phase 15 (every packet counted; every timestamp within 1/10 frame of the grid) |
| bitrate | Σ packet bytes × 8 / duration > 0 and ≤ 1.5 × target (keyframes on short clips, VBR peaks) |
| alpha | without alpha: the track must not be marked transparent. With alpha: the track must be transparent **and** the decoded alpha of every checkpoint frame must match the render (alpha PSNR ≥ 30 dB) |
| audio track, codec, format | codec = requested, 48 kHz stereo; measured audio bitrate shown |
| audio duration | the **decoded** audio's end (what a player outputs), bounded by the container's presentation end. Must equal the video ±1 ms. WebM only: may run past by under one Opus frame (20 ms), never short (§7) |
| audio sync | as Phase 15 (cross-correlation with the mix, ±1 ms) |
| structure | as Phase 15 (every frame cross-checked against the timeline) |
| video decodes / fidelity | every checkpoint frame decoded and compared with the rendered (framed) frame, PSNR ≥ 30 dB. A decode error is a named failed check with the frame number; fewer frames compared than checkpoints fails fidelity |

## 6. UI (`VideoExportPanel.tsx`)

- Preset chips (radio group), then every setting:
  - resolution, as W × H inputs plus a standard-size list;
  - framing, shown only when the shape differs;
  - frame rate;
  - container;
  - video codec (filtered to the container);
  - quality level or target bitrate, with VBR/CBR and the resolved Mbit/s;
  - audio codec and bitrate;
  - transparency, shown only when the container supports it.
- A one-line summary of the exact output, blocking errors (red), and warnings (amber).
- **Export** adds a job. The job list (newest first) shows status, settings and a progress bar with phase, frames, % and ETA. Cancel appears while a job is queued or processing, Download when a file exists (labelled "failed" if it failed validation), and Remove once it is finished.
- An expandable report shows every check with its measured value, plus the warnings (letterboxing, clipping…).

## 7. Decisions made from real exports

1. **Opus end trim is cut in presentation time.** Chrome's Opus encoder signals a 312-sample pre-skip in the OpusHead, which every decoder drops, and emits one more packet than the input length. Cutting at the video's end in *packet* time dropped that last packet: the audio was 20 ms short. `encodeAudioExact` now reads the pre-skip (`codecDelaySec`) and cuts in presentation time.
2. **WebM can't trim the last audio packet.** Mediabunny's Matroska muxer writes no `DiscardPadding`, so WebM keeps the final Opus packet whole. The tail past the video is encoder padding (silence) shorter than one frame: 13.5 ms measured. The audio-duration check allows exactly that in WebM and nowhere else.
3. **No Opus in MP4.** Mediabunny writes no edit list for an Opus track in MP4, so the same tail can't be trimmed there either: ffmpeg decodes 4.0135 s for a 4.000 s video. MP4 and MOV therefore take AAC only, where the edit list trims both the priming and the tail (exact 192 000 samples).
4. **Audio duration is measured by decoding.** Container metadata said 4.000 s for the 4.0135 s Opus file. The check now uses the decoded end, bounded by the container's presentation end: Mediabunny's decoder plays past an MP4/MOV edit list's end (4.0093 s) where ffmpeg and players stop at exactly 4.000 s.
5. **Audio encoder preflight.** Capability queries can be wrong: AAC 384 kbit/s "is supported" but fails every encode on macOS Chrome. Before any frame is rendered, the job encodes and decodes a test burst with the exact audio configuration (the delay measurement the audio stage needs anyway). A broken configuration now fails in ~20 ms with a clear message, instead of after the whole video render.
6. **Decode failures during validation are checks.** A corrupt bitstream used to escape as a bare "Decoding error." and lose the report. It is now a failed `video-decode` / `audio-decode` check on a kept file.

## 8. Not supported / known limits

- **Fractional frame rates** (23.976, 29.97, 59.94) are not supported. The exact time mapping is integer-based.
- **CBR is a request, not a guarantee.** The mode is passed to WebCodecs, and hardware encoders don't stuff bits on simple content: a 6 Mbit/s CBR HEVC export of flat probe graphics measured 0.84 Mbit/s. The bitrate check is a ceiling (≤ 1.5 × target), not a floor.
- **ProRes / other intermediates:** not encodable in the browser. MOV carries H.264/HEVC only.
- **Alpha** is WebM VP9/VP8 only. HEVC-with-alpha and ProRes 4444 have no browser encoder.
- **One export at a time.** Queued jobs wait. The queue lives with the page and is lost on reload.
- **Platform limits** (length, bitrate) are warnings from published guidance, not enforced.
