# Matte System — Production Readiness Report

Date: 2026-09-30
Scope: the full matting/background-removal system (`src/lib/matting/**`, `src/lib/media/**` bg-removal paths, `src/lib/ml/**`, `src/components/tool/video/RemoveBackgroundTool.tsx` + `RefineMattePanel.tsx`, and the two benchmark tools), across the 21 areas requested.

Method: full test suite + `tsc` + `build` run as a baseline, both live benchmark tools (performance, quality) run end-to-end in a real browser, and an adversarial code audit of every subsystem — verifying actual current file contents and behavior, not prior phase summaries. Six parallel audits plus one direct follow-up covered the 21 areas; findings below are de-duplicated and independently spot-verified (file/line references re-read directly) before being included here.

**This report is the "before fixes" record.** Findings are listed below with severity, and — per the task brief — only CRITICAL and HIGH issues are fixed in this pass; MEDIUM/LOW are documented, not touched. See the final section for the post-fix test run and an honest bottom-line verdict.

---

## Baseline (before any fixes)

- `npx vitest run` — **408/408 tests passed**, 47 files, 0 failures.
- `npx tsc --noEmit` — clean, 0 errors.
- `npm run build` — succeeds.
- **Performance benchmark** (`/tools/video/remove-background-benchmark`, real device: 8 CPU cores, ~8GB, WebGPU available via Apple/Metal-3): all 6 cases (3 image resolutions, 3 simulated video fps) completed. Model used throughout: `u2net` (WASM — see Finding G12 on why WebGPU isn't actually exercised). Inference times 415–2750ms depending on resolution/fps; no crashes, no `n/a`s beyond the documented "no browser API for GPU memory."
- **Quality benchmark** (`/tools/video/matte-quality-benchmark`, synthetic ground-truth dataset): all **34/34 cases succeeded** (3 Easy, 5 Medium, 17 Hard, 9 Video) — zero failures/crashes. Aggregate Mean MAD: Easy 0.0080, Medium 0.0188, Hard 0.0325, Video 0.0121. Worst individual cases were all transparency/soft-edge-class: `hard-semi-transparent-fabric` (MAD 0.1008), `hard-smoke-like-regions` (0.0843), `hard-curly-hair` (0.0760), `hard-transparent-objects` (0.0752) — see Finding M16.

---

## Findings

### CRITICAL

#### C1 — Cancelling a video subject-cutout run silently ships a partial result as a success
- **Severity**: CRITICAL
- **Location**: `src/lib/hooks/usePersonCutout.ts:38-44`; gated into the UI at `src/components/tool/video/RemoveBackgroundTool.tsx:290` (`aiVideoReady = ... cutout.frames.length > 0`) and `:608` (Cancel button wired to `cutout.cancel`)
- **Problem**: `generate()` calls the frame-sampling generator with an `AbortSignal`, then unconditionally does `framesRef.current = next; setFrames(next);` regardless of whether the run was aborted. The only abort-awareness in the function is `if (next.length === 0 && !controller.signal.aborted)` — which only fires when *zero* frames came back. If the user cancels after even one frame has completed, `next.length > 0`, so this branch is skipped entirely: no error, no partial-result flag, nothing.
- **Impact**: `aiVideoReady`/`canExport` gate directly on `cutout.frames.length > 0`. A user who clicks "Detect subject" then "Cancel" partway through gets a fully-enabled "Remove background" export button, backed by a cutout covering only the first fraction of the timeline — `nearestCutoutFrame` then silently stretches the last available frame's cutout across the rest of the clip. The export completes and looks successful; the subject-removal effect is silently wrong for most of the video's duration. This is the exact "never return a fake successful result" invariant (Phase 16's own stated hard requirement) being violated in a currently-shipping, user-reachable path.
- **Recommended fix**: Have the generator (or `usePersonCutout.generate`) distinguish "cancelled" from "completed": on `controller.signal.aborted === true`, discard `next` (revoking its blob URLs to avoid a leak) and leave `framesRef.current`/`frames` at whatever they were before this run started, rather than adopting the partial set.
- **Blocks production**: **Yes.**

#### C2 — Model adapters' actual inference math (preprocessing/postprocessing) has zero test coverage
- **Severity**: CRITICAL
- **Location**: `src/lib/matting/models/{u2net,modnet,background-matting-v2,rmbg-adapter,rvm,selfie-segmenter-adapter}.ts` — the only test file touching this directory, `models/capabilities.test.ts`, explicitly scopes itself to static `capabilities` metadata only ("real inference is deliberately out of scope").
- **Problem**: No test anywhere exercises an adapter's real `inferImage`/`inferVideo` — the actual resize/normalize preprocessing, `session.run()` call, and tensor→alpha postprocessing. The entire adversarial/orchestration suite (`remove-background.adversarial.test.ts`) uses hand-written mock `MattingModel`s standing in for this code, never a real adapter.
- **Impact**: A real bug in, e.g., u2net's normalization constants, channel ordering, or output-tensor indexing — an easy, high-consequence class of error in tensor code — would silently produce a wrong matte, and **no test in the 408-test suite would ever catch it**. This is precisely the failure mode this whole system exists to prevent, and it can currently only be caught by a human noticing bad output live in a browser.
- **Recommended fix**: Add adapter-level tests that mock only `ort.InferenceSession.create`/`session.run` (narrower than today's DOM-boundary mocking) with a fixed, hand-computed input/output tensor, asserting the adapter's own pre/post-processing math against known-correct values.
- **Blocks production**: **Yes** — the core value proposition of this system is matte correctness; shipping the actual numerical code with zero regression coverage is not acceptable for a production sign-off.

---

### HIGH

#### H1 — Every image request tries an unbundled model first, guaranteeing a wasted 404 and a user-visible scary warning
- **Severity**: HIGH
- **Location**: `src/lib/matting/models/registry.ts:18-27` (`createModelRegistry`), `src/lib/matting/models/modnet.ts:8` (own doc comment: *"will 404 until the actual weight lands here"*), `src/lib/matting/router.ts:59-70` (`score`), `src/lib/matting/pipeline/remove-background.ts:170` (warning text), `src/components/tool/video/RemoveBackgroundTool.tsx:449-454` (warnings rendered to the end user)
- **Problem**: Verified directly (not just for "portrait" hints — this is broader than initially suspected): no production caller ever sets an explicit `subjectHint`, so `analysis.subjectHint` is **always** `"unknown"` in the shipped app. Under `score()`, `modnet` (supportedSubjects=["portrait"], modelClass="matting") scores `0 (no subject match) + 5 (matting class) = 5` for an unknown-subject request, while `u2net` (supportedSubjects=["general","product"]) scores only `2` (general-fallback bonus, not matting-class). **`modnet` — whose weight file was never bundled — outranks the one real, working model on every single image request**, not just portraits.
- **Impact**: Every one-click "Remove background" image operation, for every user, tries to download `/models/modnet.onnx`, gets a 404, and only then falls back to `u2net` (confirmed correct fallback — no crash). But the resulting warning (`Model "modnet" failed (Failed to download /models/modnet.onnx (404)); tried next candidate.`) is pushed into the same `warnings` array the UI renders directly to end users. Ordinary users doing the most ordinary operation see a jargon-filled, alarming warning box on a result that's actually fine — plus one wasted network round-trip on the hot path, forever (never cached, since it's a 404).
- **Recommended fix**: Remove `ModNetAdapter` and `BackgroundMattingV2Adapter` from `createModelRegistry()` until their weight files are actually bundled (both adapters' own comments already admit this), or add an explicit availability gate checked before ranking.
- **Blocks production**: **Yes.**

#### H2 — Manual refinement brush strokes land in the wrong place on letterboxed (portrait) images
- **Severity**: HIGH
- **Location**: `src/components/tool/video/RefineMattePanel.tsx:47-52` (`toImagePoint`), canvas styled `max-h-[32rem] w-full object-contain` at `:138`
- **Problem**: Verified directly. The canvas box's CSS height is derived from its own width and intrinsic (buffer) aspect ratio, clamped by `max-h-[32rem]` (512px). For any image/video whose aspect-ratio-preserving height at full box width would exceed 512px (any portrait orientation in a normal desktop-width panel — extremely common for phone photos), the box becomes wider than the content needs, and `object-contain` letterboxes the actual rendered pixels inside it. `toImagePoint` computes `scaleX = canvas.width / rect.width` using the **full box's** `getBoundingClientRect()`, not the visible content rectangle — so both the scale factor and the offset are wrong whenever letterboxing occurs.
- **Impact**: On any portrait image, brush strokes are painted at a position offset and scaled incorrectly relative to where the user actually clicked. This is the tool's core "fix the AI's mistakes by hand" feature, and it silently paints in the wrong place with no error or warning — for exactly the input orientation (vertical phone photos) this app's stated audience uploads most.
- **Recommended fix**: Compute the actual rendered content rect by inverting `object-contain`'s letterboxing math (derive visible width/height from `canvas.width/height` vs. the box's aspect ratio, then offset by the letterbox margins) before scaling pointer coordinates.
- **Blocks production**: **Yes** — core feature produces incorrect results for a common input shape.

#### H3 — The shipped video AI-cutout path has zero dedicated test coverage
- **Severity**: HIGH
- **Location**: `src/lib/matting/pipeline/video-cutout.ts` (no test file), consumed by `useBgRemovalExport.ts` and `usePersonCutout.ts` — both production paths
- **Problem**: Unlike the image path (`remove-background.adversarial.test.ts`), the video/temporal AI-cutout orchestration (frame sampling, per-frame fallback, temporal-state handling) has no unit test at all.
- **Impact**: Regressions in this more complex, stateful path (which also contains C1 above) can ship undetected; today it relies entirely on manual/live browser verification from past phases, which does not re-run on future changes.
- **Recommended fix**: Add a `video-cutout.test.ts` mirroring the existing adversarial-suite pattern (mock the DOM touchpoint, inject mock `MattingModel`s) covering at minimum: cancellation mid-run (tying directly into the C1 fix), fallback on a frame-level model failure, and temporal-state reset between calls.
- **Blocks production**: **Yes** — currently the least-tested non-trivial path in the system.

#### H4 — Chroma-key compositing math (the tool's default video mode) has zero test coverage
- **Severity**: HIGH
- **Location**: `src/lib/media/{bg-removal-canvas,bg-removal-image,chroma-key-canvas}.ts` (no test files)
- **Problem**: The per-pixel color-distance/similarity/edge-softness/spill-suppression math for chroma-key keying and background compositing is entirely untested.
- **Impact**: This is real, non-trivial logic reachable by every non-AI (green-screen) user — chroma-key is the tool's **default** mode for video (confirmed in `RemoveBackgroundTool.tsx`'s own default state). A regression here (wrong falloff curve, broken spill suppression) ships silently; today's test suite only covers the AI-matting path.
- **Recommended fix**: Extract the pure color-distance/threshold math into testable functions (if not already separable from canvas calls) and add unit tests with known RGB inputs and expected keyed-alpha outputs.
- **Blocks production**: **Yes** — for the tool's default mode.

#### H5 — Background-replace file pickers bypass the file-type/size validation gate
- **Severity**: HIGH
- **Location**: `src/components/tool/video/RemoveBackgroundTool.tsx:726-739` (the "Choose background image"/"Choose background video" `<input type="file">` handlers)
- **Problem**: These two file inputs set `replace.imageFile`/`replace.videoFile` directly from `e.target.files?.[0]`, completely bypassing `validateUploadedMediaFile()` (`src/lib/media/upload-validation.ts`) — the exact type/size gate added for the primary Dropzone in the prior media-security phase.
- **Impact**: A user can pick an arbitrarily large or wrong-type file as a background plate with no size ceiling and no explicit type check — the same class of gap already fixed once for the main upload, missed on a second entry point in the same tool. Worst case is a slow/OOM-prone background load, not a crash.
- **Recommended fix**: Run both `onChange` handlers' picked files through `validateUploadedMediaFile()`, surfacing the same error pattern already used for the main Dropzone.
- **Blocks production**: No on its own (doesn't crash), but fixed alongside the others since it's a direct, easy-to-close consistency gap in a control this same review just added.

#### H6 — "Temporal consistency" and the difficulty-aware model router are fully built but never wired into the shipped video path
- **Severity**: HIGH (as a truth-in-labeling / scope-accuracy issue, not a runtime bug)
- **Location**: `src/lib/matting/model-router.ts` (the difficulty-scoring `ModelRouter`), `src/lib/matting/video/{temporal-matting-engine,temporal-quality-engine,temporal-quality-signals,video-matting-session,frame-source}.ts`, `src/lib/matting/pipeline/refine/matte-quality-engine.ts` (12-dimension `MatteQualityEngine`) — confirmed via repo-wide grep that **none of these are imported by any production path** (`pipeline/video-cutout.ts`, the actual shipped video path, calls the plain per-frame image pipeline directly, with `media` hardcoded to `"image"`; nothing outside `src/lib/matting/video/` and `model-router.ts` imports either).
- **Problem**: This is a complete, individually well-tested set of subsystems — scene-cut detection, motion-aware temporal smoothing, occlusion handling, a 12-signal quality report with `needsReview`/`recommendedActions`/`problemRegions` — that simply does not run for any real user. The shipped video AI mode instead runs each sampled frame through the plain image pipeline completely independently, with no temporal smoothing at all, and the shipped quality signal to end users is only the much simpler Phase-1 `confidence` float (`quality-metrics.ts`), never the richer per-defect report.
- **Impact**: Two consequences for a "production readiness" sign-off specifically: (1) the shipped video AI mode can flicker/jitter frame-to-frame (no temporal smoothing) — a real, currently-silent quality gap; (2) neither "temporal consistency" nor "intelligent difficulty-aware routing" nor "12-dimension quality analysis" can be honestly described as *shipped, production* features — they exist as tested-in-isolation code, not as something a user's request ever reaches. `frame-source.ts`'s own doc comment already flags it needs a live-browser smoke test "before being trusted end-to-end," which has never happened because nothing calls it.
- **Recommended fix (this pass, given "no new features")**: Documentation-only — correct the stale claim in `registry.ts`'s comment ("wiring... deferred to a later phase" — no longer true for the registry, but *is* true for these other subsystems) and make explicit, wherever this system's capabilities are described, that temporal smoothing and the rich quality-analysis report are not on the production path today. Actually wiring them in is out of scope for a CRITICAL/HIGH-only bugfix pass (it's substantial new integration work, not a bug fix).
- **Blocks production**: No for current functional correctness (dead code can't misbehave) — but **yes** for claiming these three capabilities as production features, which is exactly the kind of claim this report must not make.

---

### MEDIUM

- **M1** — `remove-background.ts`'s automatic pipeline only ever calls the simpler Phase-1 `decontaminate()` (`pipeline/decontaminate.ts`); the more sophisticated, halo/fringe-safeguarded `ColourDecontaminationEngine` (`refine/decontamination-engine.ts`) and hair refinement (`refine/hair-refinement.ts`) only run when a user opens manual refinement and clicks the specific one-click button. Most users never discover this, so green/blue-background fringing and crushed hair detail can ship in the default one-click output even though better engines already exist in the codebase. *(`remove-background.ts:217`, `useMatteRefinement.ts`)*
- **M2** — Per-frame matting failures in the video path are swallowed with a bare `catch { return null; }` and no count/threshold-based warning — a clip where 40% of frames failed due to a real bug looks identical, from the UI, to one where the subject legitimately left frame (an expected case). *(`pipeline/video-cutout.ts:29-40`, `person-cutout.ts:209-249`)*
- **M3** — `onnxruntime-web` is pinned to a dated nightly/dev prerelease tag (`^1.26.0-dev.20260416-b7804b056c`) with no comment anywhere explaining why, vs. the latest stable release — a supply-chain fragility (the exact tag could be pulled from the registry) and a mystery for future maintainers. *(`package.json`)*
- **M4** — The `ffmpegEngine` and `getSharedModelRegistry()` singletons are shared across matting and unrelated tools; the queue's "one rejection doesn't wedge the whole thing" guarantee is currently correct by code inspection but has no regression test locking it in. *(`src/lib/ffmpeg/engine.ts`, `models/registry.ts`)*
- **M5** — Model adapters' `load()` has no guard against concurrent invocation on the same instance: two overlapping calls could both pass the `if (this.session)` check and each create a real session, with the second silently overwriting the first's reference (leaking it, since nothing calls `.release()` on the discarded one). Not reachable via the current UI (the export button is disabled while `isProcessing`), but latent given the registry is a shared, process-lifetime singleton any future caller could hit concurrently. *(`models/u2net.ts:107-118`, same pattern in the other adapters)*
- **M6** — Completed brush strokes always trigger a full-image alpha rebuild + recomposite (`getEffectiveAlpha()` + `previewEngine.render()` with no region), even though `ManualRefinementEngine.applyStroke` returns a `DirtyRegion` specifically so only the touched rectangle needs recomputing. Correctness is unaffected; latency on large images is unnecessarily worse than the engine layer was built to deliver. *(`useMatteRefinement.ts:83-106`)*
- **M7** — The one-click "Enhance fine hair detail" / "Reduce background color spill" actions replace the whole `ManualRefinementEngine` instance, silently resetting the undo/redo history with no entry of their own — a user who dislikes the one-click result has no in-panel way back except abandoning Refine entirely. *(`useMatteRefinement.ts:135-159`)*
- **M8** — `u2net` (the only bundled, actually-working model) is a binary segmentation network with no true soft-transparency modeling. The live quality-benchmark run confirms this concretely: the four worst-scoring cases of 34 are exactly the transparency/soft-edge class (`hard-semi-transparent-fabric` MAD 0.1008, `hard-smoke-like-regions` 0.0843, `hard-curly-hair` 0.0760, `hard-transparent-objects` 0.0752), 5-10x worse than the Easy-category baseline (~0.008). Nothing in the UI warns a user attempting glass/smoke/sheer-fabric subjects that this is a known-hard case for the current model. *(live benchmark run, `models/u2net.ts`)*
- **M9** — `src/lib/matting/video/frame-source.ts`'s `dispose()` never resolves/rejects promises parked in its `waiters` queue — a caller awaiting `decodeFrame()` when `dispose()` runs would hang forever. Currently unreachable (zero production callers per H6), but would become a real deadlock risk the moment this subsystem is ever wired in. *(`frame-source.ts:97-114`)*

---

### LOW

- **L1** — `export-validation.ts`'s transparent-video alpha check only decodes and inspects a single mid-point frame, not the full timeline — an intermittent or keyframe-only alpha regression could pass validation. *(`export-validation.ts:370-378`)*
- **L2** — `MODEL_LICENSES.md`'s MODNet checkpoint-provenance verification is still marked outstanding; currently moot since the weight file isn't bundled at all (see H1), but must be re-checked before ever bundling one.
- **L3** — `model-cache.ts` has no test coverage of its cache-hit/cache-miss/fetch-failure branches.
- **L4** — `refine/viewport.ts` (a complete, correct zoom/pan coordinate-math module) is dead code — never imported by `RefineMattePanel.tsx`, which implements its own (buggy — see H2) coordinate mapping instead.
- **L5** — The chroma-key eyedropper's `picking` state in `RemoveBackgroundTool.tsx` is not reset in `resetFileState()` — starting a color pick, then loading a new file mid-pick, can leave the pick overlay active over the new file.
- **L6** — `registry.ts`'s own doc comment ("wiring this into an actual tool's flow is explicitly deferred to a later phase") is stale — it's been the live production registry for several phases now.
- **L7** — `quality-metrics.ts`'s boundary/gradient scan skips the image's last row and column (`x < width - 1 && y < height - 1`) — a minor, cosmetic incompleteness in the metric, not a functional defect.
- **L8** — `MatteQualityBenchmarkPanel.tsx`'s `localStorage`-persisted report/rating arrays have no size cap. Low impact: this is an internal, unlisted developer diagnostic tool, not a customer-facing surface, and holds only small JSON metrics, never media.

---

## Fixes applied in this pass (CRITICAL + HIGH only)

Per the task brief, MEDIUM and LOW items above are **documented but intentionally not fixed** in this pass. The following were fixed:

| ID | Fix |
|----|-----|
| C1 | `usePersonCutout.generate` (`src/lib/hooks/usePersonCutout.ts`) now discards a cancelled run's partial frames (revoking their blob URLs) and leaves prior state untouched, instead of adopting them as the final result. Verified by direct code reading (no React-hook-testing library exists in this repo; adding one was judged out of scope for a bugfix-only pass). |
| C2 | Exported `imageDataToNormalizedTensor`/`normalizePrediction` from `u2net.ts` and added `u2net.test.ts` (7 tests) — hand-computed expected values catch wrong normalization constants, wrong channel order, and wrong planar-layout stride, the exact risk class this finding named. `inferImage`'s DOM/session-run wiring remains verified live only, consistent with this codebase's established no-jsdom convention. |
| H1 | Removed the unbundled `ModNetAdapter`/`BackgroundMattingV2Adapter` registrations from `createModelRegistry()` (`registry.ts`); updated `capabilities.test.ts` and `model-router.test.ts` accordingly (constructing those two adapters directly for their own capability/scoring tests, independent of production registry membership). |
| H2 | Extracted the coordinate math into `contain-point-mapping.ts` (`mapPointIntoContainedCanvas`) and fixed it to correctly invert `object-contain` letterboxing before scaling pointer coordinates; `RefineMattePanel.tsx`'s `toImagePoint` now delegates to it. Added `contain-point-mapping.test.ts` (4 tests) reproducing the exact real letterboxed geometry (700x512 box, 480x854 buffer) confirmed live in the browser. |
| H3 | Added `video-cutout.test.ts` (4 tests) mocking `sampleTrimmedFrames`/`removeBackgroundFromImage` at the module boundary — covers argument forwarding, the produceBlob→pipeline→blob conversion, per-frame failure swallowing, and progress forwarding. |
| H4 | Extracted the per-pixel keying/mask math into `chroma-key-math.ts` (`chromaKeyAlpha`, `bilinearSampleMask`); both `bg-removal-canvas.ts` (the Remove Background tool's default green-screen mode) and `chroma-key-canvas.ts` (the Video Editor's live preview) now call it instead of inlining the formula. Added `chroma-key-math.test.ts` (10 tests). |
| H5 | Wired `validateUploadedMediaFile()` into both background-replace file inputs in `RemoveBackgroundTool.tsx` via a new `handleBackgroundReplaceFile` handler. |
| H6 | Added explicit "not on the production path" notes to `registry.ts`, `model-router.ts`, `video/index.ts`, and `matte-quality-engine.ts`'s doc comments, and corrected `registry.ts`'s stale "wiring deferred" claim. |

## Post-fix verification (actual results, not claimed)

- `npx tsc --noEmit` — clean, 0 errors.
- `npx vitest run` — **434/434 tests passed**, 51 files (up from the 408/47 baseline: 26 new tests added across `u2net.test.ts`, `contain-point-mapping.test.ts`, `video-cutout.test.ts`, `chroma-key-math.test.ts`, plus adjustments to `capabilities.test.ts`/`model-router.test.ts`). Zero failures, zero regressions.
- `npm run build` — succeeds.
- **Live browser verification** (chrome-devtools-mcp against the running dev server), each confirming the fix actually changes real behavior, not just passing in isolation:
  - **H1**: uploaded a plain image in AI mode; console log confirms `"2 eligible candidate(s)"` → `"Trying u2net"` → `"u2net succeeded"` directly, with no `modnet` attempt and no 404 — the scary warning box no longer appears on an ordinary result.
  - **H2**: uploaded a real 400×900 portrait image; confirmed via `getBoundingClientRect()` that the Refine canvas is genuinely letterboxed in production (canvas 400×900, rendered box 876×512 — exactly the scenario the fix targets); dispatched a real pointer stroke at the box's visible center and confirmed Undo transitioned from disabled to enabled, proving the stroke was registered through the fixed coordinate path with no exception.
  - **H5**: in the background-replace "Image" slot, a valid PNG was accepted; a renamed `.exe` was then rejected with "That file doesn't look like an image or video we support..." **and the prior valid selection (`red-square.png`) was preserved**, not silently overwritten.
  - **H4 (regression check)**: uploaded a pure `#00ff00` image in the tool's default green-screen mode after the `chromaKeyAlpha` extraction — fully keyed out to transparent as expected, confirming the refactor didn't change real behavior.
  - No console errors in any of the above sessions.

**Bottom line**: all 8 CRITICAL/HIGH findings from this review have a real fix in the tree, the full test suite passes (434/434), `tsc` and the production build are both clean, and the four fixes most amenable to live verification were confirmed working against the actual running app — not just asserted. MEDIUM and LOW findings remain open, as instructed, and are documented above for a future pass.
