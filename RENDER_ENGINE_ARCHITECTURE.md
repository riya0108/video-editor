# Phase 15 — Final Rendering Engine: Architecture

The final renderer turns a project into an MP4 that reproduces the timeline exactly, at a chosen output size and frame rate. It is separate from preview at every stage that could cost quality:

| | Preview | Final |
|---|---|---|
| Frames | whatever is decoded now (`peekFrame`), may lag while seeking | the exact source frame (`getExactFrame`), awaited |
| Resolution | adjustable (1/1–1/8) | composition × output scale, always |
| Resampling | `low` while playing | `high` |
| Missing source/frame/matte | layer skipped | error naming the frame |
| Decoders | pooled, playing | dedicated, never played, strictly in order |

Both paths draw the same `ResolvedFrame` with the same `drawResolvedFrame`. Geometry therefore cannot differ between them; only sampling and exactness do.

## 1. Pipeline

```
Project ─▶ Timeline ─▶ Composition graph ─▶ Render graph ─▶ effects ─▶ masks ─▶ mattes ─▶ compositing
(model)    (frames)    resolveFrame(f)      per layer:        (draw.ts, unchanged from preview)
                       ordered, evaluated   pixels→fx→masks→
                       layers               matte→transition
                                            →opacity/blend
                                                                         │ canvas, exact output size
   audio: mixTimeline (same segments/envelopes as playback) ───────┐     ▼
                                                                    ▼  VideoEncoder (H.264, WebCodecs)
                                                     AudioEncoder (AAC) │
                                                                    └──▶ MP4 mux (Mediabunny) ─▶ file
                                                                                      │
                                     read the FILE back ◀─────────────────────────────┘
                                     probe + decode ─▶ validation report ─▶ download
```

Files live in `src/lib/render/`:

| File | Role |
|---|---|
| `settings.ts` | output presets, setting checks |
| `plan.ts` | render plan (frame count, time mapping, checkpoints) |
| `graph.ts` | render graph + independent cross-check |
| `audio.ts` | audio stage |
| `job.ts` | the browser render job: encode, mux, read back, validate |
| `validate.ts` | pure validation checks |
| `probe-project.ts`, `probe-harness.ts` | test fixtures (not used by the app) |

`FinalRenderer` (`composition/final-renderer.ts`) gained an output scale and a media-time offset. UI: `components/tool/video/composition/VideoExportPanel.tsx`.

## 2. Output settings (`settings.ts`)

> Phase 16 extended these settings: containers, codecs, alpha, fit/fill framing, custom sizes and rates. See `EXPORT_ARCHITECTURE.md` §3. The rules below remain the defaults.

- **Sizes:** 1080×1920, 1920×1080, 1080×1080, 2160×3840.
- **Frame rates:** 24, 25, 30, 50, 60. Anything else is rejected before rendering.
- **The output must have the composition's aspect ratio.** Rendering a 16:9 composition into 9:16 would mean cropping or letterboxing, a creative decision the timeline didn't make. It is refused with what to change instead.
- **Same aspect at another size** renders at `renderScale = outputWidth / compositionWidth`; e.g. 2160×3840 from a 1080×1920 composition renders at 2×. Text, shapes and SVG are re-rasterized at output resolution, and media is sampled from full-resolution source frames. Nothing is an upscaled bitmap.
- **Video:** H.264 (falling back to HEVC, VP9 or AV1 only if this browser can't encode H.264 at that size, with a warning). Default bitrate is 0.15 bits/pixel/frame, clamped to 4–80 Mbit/s: 1080p30 ≈ 9.3 Mbit/s, 4K60 ≈ 75 Mbit/s. Keyframe every 2 s.
- **Audio:** AAC-LC, 48 kHz stereo, 192 kbit/s (Opus fallback). No audio track when nothing on the timeline is audible.

## 3. Render plan and time mapping (`plan.ts`)

The plan is pure and deterministic. It is decided before any pixel is drawn.

- **Frame count** = ⌈timelineFrames × fps / projectFps⌉. The last output frame starts before the timeline ends, so nothing is cut off.
- **Duration** = frameCount / fps, exactly. The audio is rendered to this length too.

Output frame *k* covers [k/fps, (k+1)/fps):

- **Timeline state** (clip activity, keyframes, transitions, captions) is evaluated at the frame's start: timeline frame `f_k = k × projectFps / fps`. This is an exact rational; integer division of integer products means no drift even an hour in. When the rates match, `f_k = k`, the same frame preview shows.
- **Media** is sampled at the frame's centre. The provider seeks a source frame `sf` to `(sf + 0.5) / projectFps`, so the renderer adds `mediaFrameOffset = 0.5 × projectFps / fps − 0.5` to every video and matte source frame. That offset is 0 when the rates match. A seek therefore never lands on a source frame boundary for any rate pair (24→60, 30→25, 60→24…). Frame-sequence mattes use the same rule (`sequenceFrameIndex = ⌊sf + 0.5⌋`), so a video and its matte never disagree.
- **Checkpoints:** up to 24 output frames are decoded back after encoding: first, last, eight evenly spaced, the frames on either side of clip starts and ends, and transition midpoints.

## 4. Render graph and cross-check (`graph.ts`)

- **Composition graph** of a frame: `resolveFrame()`'s ordered layers, every property evaluated.
- **Render graph:** what the compositor executes per layer, back to front: source pixels → effects → masks → matte → transition → opacity + blend → composite. `buildRenderGraph` describes it (for the report and tests); `drawResolvedFrame` executes it.

`crossCheckFrame` runs on **every** rendered frame. It re-derives from the raw timeline, outside the resolver's code path, what the frame must contain, and reports any disagreement:

| Check | Rule |
|---|---|
| Layer order | back-to-front paint order follows track order |
| Presence | every clip active at the frame on a visible track is drawn (or legitimately culled: opacity 0, fully off-canvas), and nothing else is |
| Effects / masks / matte | exactly the clip's enabled ones, in stack order |
| Keyframes | every animated property equals its track evaluated at the clip-local frame, set through the property's own setter (clamping included) |
| Transitions | both sides of an active transition are tagged with it, at the eased progress the transition model gives |
| Text and captions | a non-empty text or caption clip is drawn as text |

## 5. Video stage (`job.ts`)

A dedicated `FinalRenderer` (its own canvas and scratch surfaces) renders frames strictly in order. Each frame is:
1. checked to be exactly the output size;
2. cross-checked (§4);
3. at checkpoints, downscaled (480 px) as a reference;
4. wrapped in a `VideoSample` at timestamp k/fps with duration 1/fps, and handed to the encoder. The muxer snaps the track to the frame rate.

Cancellation is honoured between frames, and a failure cancels the output.

## 6. Audio stage (`audio.ts`, `job.ts`)

- **Mix:** `mixTimeline`, the offline mixer playback's own segments and gain envelopes are built from (fades, automation, mute/solo, resampling), rendered to exactly `durationSec` at 48 kHz.
- **Clipping:** over-full-scale samples are clamped and reported as a warning, never wrapped.
- **Strictness:** an audible clip whose audio is still decoding, missing, or (for an audio clip) failed is an error. A video with no soundtrack is fine.
- **Start alignment:** AAC encoders prepend priming samples (2112 on macOS) that decoders output as-is. The delay is **measured** per encoder configuration: a seeded noise burst is encoded and decoded with WebCodecs and located by cross-correlation. Every audio packet is then timestamped that much before zero, so the muxer writes an edit list that trims the priming.
- **End alignment:** the encoder pads and flushes extra frames. Packets wholly past the video's end are dropped, and the last one's duration is cut, so the audio track ends exactly with the video. The encoder is driven directly (WebCodecs `AudioEncoder` → `EncodedAudioPacketSource`) because both fixes need control over packet timestamps and durations.

## 7. Encoder and container

Mediabunny (`mediabunny`, MPL-2.0, used unmodified) muxes MP4 over WebCodecs, with the moov box in front (`fastStart: "in-memory"`) for progressive playback. It is pre-bundled in `astro.config.mjs` like every browser dependency, and the render job is a lazily loaded chunk (≈ 0.5 MB) fetched only when you render.

MP4 has no alpha channel. A transparent composition background is rendered over black, with a warning.

## 8. Validation (`validate.ts`, `job.ts`)

After writing, the job reads the **file** back. It never trusts the encoder's own bookkeeping. A render is reported as successful only if every check passes.

| Check | How |
|---|---|
| video track, resolution | demuxed track, display size |
| frame count | every packet counted |
| frame rate | every packet timestamp within 1/10 frame of the k/fps grid |
| duration | within ½ frame of frameCount / fps |
| audio track, format | 48 kHz / 2 ch (or none when nothing is audible) |
| audio duration | within 1 ms of the video's |
| audio in sync | decoded audio cross-correlated with the mix: offset ≤ 1 ms, correlation ≥ 0.9 |
| structure | §4 on every frame |
| fidelity | checkpoint frames decoded from the file vs. the rendered reference: PSNR ≥ 30 dB (a wrong, shifted or missing frame measures far below) |

The in-app validator proves the file is a faithful, correctly timed encoding of what the renderer drew, and that the drawn layers match the timeline structurally. *Which source frame* belongs at each instant is proven by the test suites (frame-counter footage decoded with ffmpeg; see the test report), not re-derived at export time.

## 9. UI (`VideoExportPanel.tsx`)

- **Output size:** sizes with a different shape than the composition are listed but disabled, with the reason.
- **Frame rate:** the project's rate is marked.
- **Render MP4:** shows a progress bar per phase (preparing, rendering frames *n / N*, mixing audio, writing file, validating) and a Cancel button.
- **Report:** every check with its measured detail, plus warnings. A file that failed validation is still downloadable for inspection, but is named `…-FAILED-VALIDATION.mp4`.

## 10. Determinism

Given the same project and media, the rendered frames are byte-identical across renders (verified with SHA-256 of full-resolution frames at 4K60 and 1080p25). The time mapping and plan are exact rationals, effects like grain are seeded by frame, and decoding is exact-frame.

The encoded bytes are not guaranteed identical across machines: hardware encoders differ. That is why fidelity is validated against the rendered frames, not against a stored file.

## 11. Not supported / known limits

> Phase 16 lifted the MP4-only, fixed-size and same-aspect limits. See `EXPORT_ARCHITECTURE.md` §8 for the current limits.

- **Containers:** MP4 only. No transparent export (it would need WebM/VP9 alpha or ProRes 4444).
- **Ranges:** the whole timeline is rendered; no in/out sub-range export yet.
- **Speed:** rendering is in-browser and bounded by exact-frame `<video>` seeks, one per media layer per frame. Measured on this machine, for a 4 s probe project with one video layer:
  - 1080p30: 6.2 s
  - 1080p60: 11.6 s
  - 4K60: 19.8 s

  The 8 s demo project (three media layers) took 23.8 s.
- **Aspect:** the output must match the composition's aspect. Change the composition size to export another shape.
- **Bitrate:** variable bitrate. Simple content (flat colours) encodes far below the target, as expected.
