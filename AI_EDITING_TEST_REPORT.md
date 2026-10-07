# Phase 14 — AI Editing Engine: Test Report

Date: 2026-10-07. The engine was built on 2026-10-06; that session was interrupted before it wrote this report. Everything below was re-run and re-verified on 2026-10-07.

Environment:
- macOS, Node 22, Vitest 5.
- Chrome via chrome-devtools-mcp.
- Astro dev server (`/tools/video/composition-preview`).
- Real models in the browser: BlazeFace, EfficientDet-Lite0, Whisper (fast tier).

## Summary

| Check | Result |
|---|---|
| Full test suite | **994 / 994 passed** (83 files) |
| AI suites (`src/lib/ai/ai.test.ts`, `real-voices.eval.test.ts`) | **48 / 48 passed** (44 + 4) |
| Type checking (`tsc --noEmit`) | **0 errors** |
| `astro check` | **0 errors, 0 warnings** |
| Production build (`astro build`) | **Complete** |
| Live: all 12 features run in the browser | **12 / 12 completed** |
| Browser console during live tests | **0 app errors.** Only library notices: MediaPipe's “Created TensorFlow Lite XNNPACK delegate” INFO line (logged via `console.error`), GL “error checking disabled”, Whisper “defaulting to English” |
| Bundled model hashes | **Match** `MEDIAPIPE_DETECTORS_NOTICE.txt` (SHA-256 re-computed) |

**Bugs found in live testing and fixed.** Each has a regression test that was confirmed to **fail without the fix** (fix temporarily reverted, test failed, fix restored):

1. **Fast shot detection put cuts half a frame early** (1.983 s / 3.983 s instead of 2.000 s / 4.000 s on a 30 fps clip).
   - Cause: sample times stepped in seconds at 12 fps, which drifts off the frame centres of a 30 fps source, so the "refined" cut landed between centres.
   - Fix: sample whole source frames and refine over the exact frame indices in between (`shots.ts`).
   - The existing "refined to the exact frame" test used a continuous-time fake that can't show this. The new test decodes frames the way the browser adapter does.
2. **The tracker snapped back to the start when the target walked out of frame.** A person walking out of a static office shot, tracked from the detector's person box: at 5.67 s the box jumped from the right edge back to its starting position (score 0.70, *not* reported lost).
   - Cause: a detector box is mostly background, so once the person left, the *original* template matched the now-empty start spot well above the fixed 0.5 threshold.
   - Fix: a motion gate. A match farther than 0.35 × the template size from the predicted position must score ≥ 0.85 to be believed (`tracking.ts`). Live after the fix: the box holds at the edge, and the last 6 of 73 frames are reported lost, with a warning.
3. **Object removal flagged a locked-off shot as "camera moves (motion 9.2)" and halved its confidence.**
   - Cause: camera motion was the *mean* temporal variation of a ring around the region, and the person being removed walks out through that ring.
   - Fix: use the *median*. A moving camera changes nearly every ring pixel, while a passing object changes only some (`object-removal.ts`). Live after the fix: motion 0, confidence 1.0. The moving-camera test still flags a real pan.
4. **Auto reframe silently zoomed 4.7×.** A 9:16 path applied to the playground's 16:9 composition covered the frame with a 9:16 sliver.
   - Fix: `applyReframe` refuses an aspect mismatch with an actionable message ("…reframes to 9:16, but the composition is 16:9. Switch the composition to 9:16 first, or re-run Auto reframe for 16:9."). The panel shows it; nothing is committed.
5. **Accessibility:** the Scenes row's precision menu was also labelled “Shot detection precision”. It is now “Scene detection precision”.

Recorded by the original session in code: the object detector returns **no detections** on the GPU delegate (int8 model, no error raised), so it runs on CPU. Live today, CPU detection worked (person 0.84).

## Automated (Node)

All algorithms run on synthetic media with exact ground truth. Model-backed providers run against fake backends (wiring, linking, errors) and against the real models in the browser (below).

| Area | What is asserted |
|---|---|
| Confidence / errors / store | clamped values and bands; typed error codes and retryability; foreign errors wrapped; item edits validated (ordered, in-span, non-empty, field exists); results serialize and reload, invalid files rejected |
| Job system | queued → processing → completed with progress and a stored result; failures become typed errors, never a silent success; cancel of queued and running jobs, including a provider that ignores the abort; retry as a new attempt; timeout; registry reports unavailable features and why |
| Silences | pauses found with padding; short pauses ignored; adaptive threshold works on a noisy floor where a fixed −40 dB fails; source-time mapping; clips without audio rejected |
| Shots / scenes | jump cut, hard cut (exact frames) and dissolve found, zoom ignored; 24→30 fps conformed footage keeps one dissolve; motion before a cut doesn't fake a dissolve (5/12/24 fps); coarse-rate cuts refined to exact frames; **frame-quantized 30 fps source at Fast → cuts exactly [1, 2]** (new); scenes group the jump cut; steady motion → no boundaries |
| Tracking | follows a moving object within 1 px; occlusion reported LOST with position held, then reacquired; **a loose box whose target walks out of frame is LOST and held at the edge, never back at the start** (new) |
| Object removal | moving object removed with the real background recovered (mean error < 2); static object → harmonic fill, honestly reported (0% real background); camera pan flagged; **the object leaving through the ring is not camera motion** (new) |
| Speakers | two synthetic voices separated, turn changes within 0.5 s; one voice → one speaker; a known count is honoured |
| Fillers / B-roll | hesitations always count, discourse markers only as asides; provider uses the shared transcript; hesitations pre-accepted, discourse not; B-roll keywords are content words |
| Highlights | the loud, busy window wins and the reasons say why; works on audio only |
| Detection / reframe | IoU links one moving face into one track, two far-apart faces into two; score filter; a model that fails to load → `model-load-failed`; reframe crop size, dead zone, speed limit, clamp; with no subject it stays centred and says so |
| Apply actions | source → timeline mapping through in-point and position; split at accepted shots only, one undo step, source refs untouched; scene results split at scene starts; silences cut with and without closing gaps; speaker turns label captions; face → keyframed ellipse mask, or blurred masked copy with muted audio (original untouched); reframe cover scale + keys; **reframe on a mismatched composition refuses** (new); B-roll placeholders; clean-plate overlay layer; key simplification keeps corners |

### Real-voice evaluation (`real-voices.eval.test.ts`)

Recorded macOS voices, generated into `.tmp-test-assets/phase14` (git-ignored; the suite skips where the files are absent). Ran and passed today:

| Case | Truth | Measured |
|---|---|---|
| Interview, two clearly different voices | 2 speakers, turns at 5.38 / 12.12 / 17.16 s | 2 speakers, > 95% of time correct, each change within 0.25 s |
| One voice | 1 speaker | 1 speaker |
| Panel, **two male voices of similar pitch** (~112 Hz and ~107 Hz) + one other | 3 speakers | **2 speakers (known limit)**, < 80% correct |
| Silence on the interview (min 0.3 s) | three 0.4 s pauses at the turn changes | all three found |

## Live (browser, real decoders and models)

Test media: a ground-truth shot clip built for this report (`shots-gt.mp4`, 30 fps: hard cuts at 2.000 s and 4.000 s, a 0.75 s dissolve over 5.25–6.0 s), plus the original session's assets (`walk.mp4`: a person walking across a static office; `hv.mp4`: an empty office and colour bars; `highlight.mp4`; recorded speech WAVs).

| Feature | Clip | Result |
|---|---|---|
| Shots, Fast | shots-gt | cut 2.000, cut 4.000, dissolve at 5.683 (inside 5.25–6.0); 86 frames, ~4 s. **Before fix: 1.983 / 3.983** |
| Shots, Precise | shots-gt | cut 2.000, cut 4.000, dissolve at 5.667; 203 frames, ~8.9 s |
| Scenes | shots-gt | 4 scenes (four different places: correct) |
| Faces (BlazeFace) | walk | one track 0.13–5.75 s, 23 detections, confidence 0.71 |
| Faces | hv (no people) | none, with a warning: correct |
| Objects (EfficientDet) | walk | person 0.25–6.0 s (0.84), chairs (0.52 / 0.60) |
| Objects | hv | chairs; **one false positive**: a single-sample "refrigerator" (0.57) on the colour bars, a model error at low-medium confidence that the user can delete |
| Speakers | interview | 2 speakers; changes at 5.33 / 12.02 / 17.06 s vs. truth 5.38 / 12.12 / 17.16 |
| Silences | interview (min 0.3 s) | 3 ranges, each spanning a true pause; adaptive threshold −69.1 dBFS |
| Filler words (Whisper) | speech-fillers | “Ah,” hesitation (pre-accepted); “Basically,” and “like,” discourse (left to the user); 30 words, ~8 s incl. transcription |
| B-roll (Whisper) | speech-broll | “mountains denver rocky” (good); “watched frozen laptop” (**weak**: lexical keywords, a verb won; documented limit) |
| Auto reframe 9:16 | walk | follows the face, crop 0.316 × 1 (= 9:16 of 16:9), confidence 0.96; centre x moves 0.32 → 0.81 with the walk. Rendered through the final renderer on a 1080×1920 composition: subject centred in every sampled frame |
| Highlights | highlight | 5–9 s, score 1.0, “louder (+1.0σ); more visual action (+2.0σ); continuous sound” |
| Object tracking | walk, from the detected person box | follows across the frame (0.93 agreement). **Before fix:** jumped back to the start at 5.67 s; **after:** held at the edge, 6 frames lost |
| Object removal | walk, region over the person's start | 100% real background, method temporal-plate; before/after image shows the person gone and the desk, chair and partition recovered. **Before fix:** motion 9.2 warning, confidence 0.5; **after:** motion 0, confidence 1.0 |

**UI and apply, in the panel:**
- Selected `shots-gt`, clicked **Run** on Shots. Got 4 items with exact times (0:02.00, 0:04.00), confidence badges and accept boxes.
- Un-ticked the dissolve, then clicked **Split clip at shots**. Result: exactly 2 splits (frames 60 and 120), no split at the rejected dissolve, all pieces referencing the same source.
- One **Undo** restored the single original clip.

**Apply via `engine.transact` (the panel's path):**
- **Cut silences, close gaps** on the interview: 3 ranges, 44 frames removed (711 → 667), the remaining pieces contiguous. One undo restores.
- **Blur face:** a new layer above with a Blur effect, muted audio, and one ellipse mask keyframed on x / y / width / height (23 keys each). The original was untouched; undo restores.
- **Reframe on 16:9:** refused with the message above, nothing committed. On 9:16 it applied 24 keys.

## Not covered

- Long clips (minutes): only clips up to 24 s were run live. Analysis cost scales with frames sampled; Precise shot detection decodes every frame.
- Cloud providers: none are registered.
- Real-footage camera pans for object removal: covered synthetically only.
