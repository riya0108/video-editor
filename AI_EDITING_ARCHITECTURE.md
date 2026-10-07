# Phase 14 — AI Editing Engine: Architecture

Twelve analysis features for the composition editor: shots, scenes, objects, faces, speakers, silences, filler words, auto reframe, highlights, object removal, object tracking and B-roll ideas. Everything runs in the browser, on the user's device.

The design rests on three rules:
- **Analysis never edits.** A run produces a result: plain, serializable data the user can curate.
- **Only an explicit apply action touches the project.** It does so through `TimelineEngine.transact`, as one undo step.
- **Source media is never modified.** Apply actions produce splits, deletes, keyframes, masks, effects and new layers. They never re-encode pixels or samples.

The engine is also honest about what produced a result. Every provider declares whether it is a trained model, classical computer vision, signal processing or a heuristic. That label is shown in the UI and stored with every result, so a heuristic is never presented as a neural model.

## 1. Pipeline

```
AIPanel ──run(feature, clip, params)──▶ AIEditingSession
                                           │ 1. registry.pick(feature): first AVAILABLE provider
                                           │ 2. validate: layer kind, picture/audio present, region given
                                           │ 3. mediaFor(clip) → AIMediaSource (read-only frames + PCM)
                                           ▼
                                        AIJobQueue (FIFO, concurrency 1, cancel/retry/timeout)
                                           │ provider.run(request, { signal, progress, services })
                                           ▼
                                        AIResultStore (results = editable items, source-time)
                                           │ user accepts / edits / deletes items
                                           ▼
AIPanel ──apply action──▶ engine.transact(pure fn over TimelineModel) ──▶ ONE undo step
```

Files live in `src/lib/ai/`, except the panel (`components/tool/video/composition/AIPanel.tsx`).

## 2. Results and the store (`types.ts`, `store.ts`)

**Results are in SOURCE seconds,** on the media's own clock, not the timeline's. A result therefore stays valid when the clip is moved or trimmed. Apply actions map source time onto the timeline through the clip at apply time (§7).

An `AIResult` carries:
- Feature, provider id and kind, and model info (name, source, license).
- The target clip and analysed span.
- Items, honest `warnings`, `metrics` (duration, frames, audio seconds…), and the `params` actually used, for reproducibility.

**Items** are a tagged union, one kind per feature: `shot`, `scene`, `detection-track`, `speaker-turn`, `silence`, `filler`, `reframe`, `highlight`, `object-removal`, `track`, `broll`. Every item has:
- `accepted`, which apply actions honour. New items start accepted, except discourse-marker fillers (§9).
- A `confidence`.
- An `edited` flag.

**Confidence** is `{ value 0..1, basis }`. The basis says what the number *is*, so the UI never presents a heuristic margin as a calibrated probability:

| basis | meaning |
|---|---|
| `model-score` | the network's own (uncalibrated) output score |
| `margin` | distance past a decision threshold, squashed with a logistic (0.5 = at the threshold) |
| `heuristic` | a normalized hand-tuned score |
| `agreement` | fraction of evidence that agrees (e.g. frames the target was found in) |

Bands: high ≥ 0.75, medium ≥ 0.45, low otherwise.

**The store is separate from the timeline on purpose.** It supports:
- `updateItem` / `applyItemPatch`. Edits are validated: ranges stay ordered and inside the analysed span, boxes stay inside the frame, empty strings and fields the item doesn't have are rejected.
- `removeItem`, `setAllAccepted`, `latest(clip, feature)`.
- `serialize` / `load`, as `clipbench-ai-results` v1. An invalid entry rejects the whole file.

Results are **not** part of the project file (format v10 is unchanged).

## 3. Providers and the registry (`provider.ts`, `registry.ts`)

One interface covers every capability: `AIProvider { id, feature, label, kind, model?, description, needs, availability(), run() }`.

- **`needs`** declares the inputs: video, audio, transcribe, region. The session checks them *before* queueing, so a job never fails on a missing input.
- **`availability(services)`** returns available or `{ reason }`. It is checked again at run time.
- **Services are injected** (`AIServices`): `transcribe` (16 kHz PCM → word timings, wired to the app's Whisper) and `registerImage` (RGBA → a frame-provider source). This keeps providers testable without a browser.

`AIRegistry.pick(feature)` runs the first *available* provider and reports every unavailable one's reason. `capabilities()` lists all 12 features honestly, including unavailable ones and why. Swapping in a better model later (a neural diarizer, an inpainting network, a cloud API) means registering another provider for the same feature id. Jobs, results, the store, the UI and apply actions don't change.

`createDefaultRegistry(env)` wires the app's providers. The detectors come from an injected environment: MediaPipe in the browser, fakes in tests.

## 4. Jobs (`jobs.ts`)

```
queued → processing → completed | failed | cancelled
queued → cancelled                (before it started)
failed | cancelled → queued       (retry: a new attempt, same request, fresh signal)
```

- **FIFO with concurrency 1 by default.** The models compete for the same GPU and CPU.
- **Progress** is a 0..1 fraction plus a human-readable stage ("Reading audio", "Transcribing speech"…).
- **Cancel** aborts the provider's signal. A provider that finishes anyway after the abort is still reported **cancelled**, and its output is discarded.
- **An optional timeout** aborts the job and fails it with code `timeout`.
- **A job never completes without the provider actually returning output.** A thrown error is never turned into an empty success.

## 5. Errors (`errors.ts`)

Everything is normalized to `AIError { code, message, retryable }`. Anything else a provider throws is wrapped as `inference-failed`.

| code | when | retryable |
|---|---|---|
| `provider-unavailable` | no provider available in this environment | no |
| `model-load-failed` | weights or runtime failed to load (network, corrupt file); also speech-to-text failures | yes |
| `invalid-input` | wrong layer kind, empty or too-small region, audio too short | no |
| `media-unavailable` | picture or audio not loaded or not decodable | yes |
| `inference-failed` | the provider ran and failed | yes |
| `no-result` | ran fine, nothing usable (e.g. no speech recognized) | no |
| `cancelled` / `timeout` | user cancel / time limit | yes |

The MediaPipe loaders reset their cached promise on failure, so a retry after a network error reloads.

## 6. Media access (`media.ts`, `media-browser.ts`)

Providers never touch `<video>`, files or the timeline. They ask an `AIMediaSource` for:
- `frameAt(t, maxSide)`: the decoded frame shown at source time `t`, downscaled so its longer side is at most `maxSide`, as a fresh RGBA buffer.
- `audio()`: planar PCM of the analysed span only (t = 0 is the clip's in point).

The browser adapter reads through the compositor's `FrameProvider.getExactFrame` and the audio engine's decoded PCM, **read-only**. Frames are copied into a fresh canvas and PCM is sliced into new arrays, so analysis cannot alter the original media.

**Time base.** The timeline conforms sources to the project frame rate, so source frame f = source seconds × frame rate, for video and audio alike. The adapter decodes frame `round(t × fps − 0.5)`, the frame whose interval contains `t`. Frame-accurate features sample at **frame centres** (`(f + 0.5) / fps`), so a time maps to exactly one frame.

## 7. Apply actions (`apply.ts`)

Apply actions are pure `(timeline) → timeline` functions built only from existing `timeline/operations.ts` ops. The panel runs each through `TimelineEngine.transact`, which is new in this phase: one atomic edit, one undo step, nothing committed if any op throws. Only **accepted** items are used. Items that fall outside the clip's current span (it was trimmed after analysis) are skipped.

| Action | From | Produces |
|---|---|---|
| `splitAtBoundaries` | shots / scenes / highlights | splits at accepted boundaries; scene results split at scene starts only |
| `removeRanges` | silences / fillers | overlapping ranges merged, then deleted; with `closeGaps`, later clips on the **same track** ripple left (other tracks are not shifted; the UI says so) |
| `labelCaptionSpeakers` | speaker turns | sets the speaker on each caption clip (Phase 12) whose midpoint falls in a turn |
| `maskFromTrack` | face/object track or tracker output | an ellipse mask (Phase 13) keyframed to follow the box; `blur` mode duplicates the clip above with a Blur effect, the mask and **muted audio** |
| `attachLayerToTrack` | track | position keyframes on another layer, keeping its offset from the tracked centre |
| `applyReframe` | reframe path | `fit: none`, a cover scale, and position keys simplified with 1-D Ramer–Douglas–Peucker (1.5 px). **Refuses** when the composition's aspect differs from the path's (§11) |
| `addObjectRemovalLayer` | clean plate | a new image track directly above the clip, placed exactly like it (compensating the plate's analysis resolution) |
| `addBrollPlaceholders` | B-roll ideas | a "B-roll suggestions" text track on top with an editable placeholder at each accepted range |

## 8. UI (`AIPanel.tsx`)

The panel is mounted in the composition playground for the selected video, image or audio clip. It has four parts:
1. **Capabilities.** Each feature shows a kind badge (Model / Classical CV / Signal / Heuristic) whose tooltip names the model and license. Per-feature options: shot precision, reframe aspect, speaker count, and a region editor that can also be filled from a detected object.
2. **Jobs.** Live status, progress and stage, with cancel and retry.
3. **Results.** Per result: kind badge, item count and duration, and warnings. Per item: an accept checkbox, a click-to-seek label, the confidence and its band, inline edits (e.g. speaker name) and delete. Accept all and reject all are also available.
4. **Apply.** Explicit buttons per result kind. Each shows a notice on success or the `ApplyError` message on failure.

## 9. Features

| Feature | Provider | Kind | How |
|---|---|---|---|
| Shots | `shots.histogram` | classical CV | 8×4×4 HSV histogram + 32 px luma thumbnail per frame; hard cut = outlier vs. local median; dissolve = twin comparison plus a check that the middle frame really is a blend of the ends (mixing weight 0.2–0.8); cuts refined to the exact frame. Fast = 12 fps, Precise = every frame |
| Scenes | `scenes.shot-grouping` | classical CV | consecutive shots with similar mean histograms (Bhattacharyya < 0.3) |
| Objects | `objects.efficientdet-lite0` | model | EfficientDet-Lite0 int8 (COCO 80), **CPU delegate** (§10); 2 samples/s, IoU-linked into tracks |
| Faces | `faces.blazeface` | model | BlazeFace short-range (GPU, CPU fallback); 4 samples/s, IoU-linked |
| Speakers | `speakers.mfcc-clustering` | signal processing | MFCC 1..12 + pitch over 2 s windows, average-linkage clustering, boundaries refined to pauses. A classical baseline, **not** a neural diarizer |
| Silences | `silence.rms` | signal processing | 20 ms RMS vs. an adaptive threshold (noise floor + 12 dB, capped at −30 dBFS); min duration and padding |
| Filler words | `fillers.whisper-lexicon` | model | Whisper transcript + lexicon. Hesitations (um/uh…) are pre-accepted; discourse markers (“you know”, “like,”) only as asides and left to the user |
| Auto reframe | `reframe.subject-follow` | model | largest face, else person, else centre; gaps hold, 8% dead zone, smoothing, speed limit, clamp |
| Highlights | `highlights.activity-heuristic` | heuristic | loudness z-score, sound activity, visual activity; relative to *this* clip |
| Object removal | `object-removal.clean-plate` | classical CV | per-pixel temporal median inside the region, harmonic fill where the background is never seen; transparent patch layer. **Not generative**; static camera only |
| Object tracking | `tracking.ncc` | classical CV | zero-mean NCC template matching with an adaptive + original template, a motion gate, and explicit LOST frames (position held, not guessed) |
| B-roll ideas | `broll.transcript-keywords` | heuristic | phrases from the Whisper transcript, TF-IDF content words → query. Fetches no footage |

The Whisper transcript is cached per clip span, so fillers and then B-roll on the same clip transcribe once.

## 10. Models and licensing

| Model | Where | License |
|---|---|---|
| BlazeFace short-range (230 KB) | self-hosted `public/models/blaze_face_short_range.tflite` | Apache-2.0 |
| EfficientDet-Lite0 int8 (4.6 MB) | self-hosted `public/models/efficientdet_lite0.tflite` | Apache-2.0 |
| Whisper (existing caption model) | Hugging Face Hub, on first use | MIT |

Provenance and SHA-256 are in `public/models/LICENSES/MEDIAPIPE_DETECTORS_NOTICE.txt`. Both hashes were re-verified against the bundled files. The MediaPipe WASM runtime loads from jsdelivr, the same convention as the existing selfie segmenter. Rows were added to `MODEL_LICENSES.md`.

The object detector runs on the **CPU delegate**. With the GPU delegate, this int8 model loads without error but returns no detections.

## 11. Not supported / known limits

- **Object removal** is not generative and needs a static camera. Where the background is never seen, the border fill is smooth and blurry on texture. Camera motion is measured (median ring variation) and flagged.
- **Tracking** uses a fixed box size: no scale or rotation change, and no occlusion reasoning beyond lost/reacquire.
- **Speakers** confuses similar voices. Two male voices of similar pitch merge (measured, see the test report). Overlapping speech is not handled.
- **Fillers** depend on Whisper, which tends to omit disfluencies. A missing filler is not proof there was none, and the warning says so.
- **B-roll keywords** are lexical (TF-IDF, no part-of-speech), so a verb can make the query (“watched frozen laptop”).
- **Reframe** keys the clip for the *current* composition and refuses a mismatched aspect. Switch the composition to the target aspect first.
- **No cloud providers.** The abstraction supports them; none are registered.
- **AI results are not saved with the project.** The store has its own JSON format.
