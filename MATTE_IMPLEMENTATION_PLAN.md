# Matte / Background-Removal System — Implementation Plan

Status: **planning only — no implementation has started.** This document is the required deliverable before any code is written, per the project brief. It reflects the actual codebase as inspected on 2026-09-26, not assumptions about a typical web-app stack.

---

## 1. Current architecture (as it actually exists)

This is not the stack the brief's checklist implicitly assumes (no separate frontend/backend, no auth, no job queue, no database). Getting this section right is the point of "inspect before coding."

### 1.1 What this app is

A single Astro 7 + React 19 site (`src/pages/**/*.astro` hosting React "tool" islands under `src/components/tool/`). Every video/image/audio tool runs **entirely client-side in the browser tab**:

- Video/audio processing: `@ffmpeg/ffmpeg` + `@ffmpeg/core-mt` (multithreaded ffmpeg.wasm), loaded once per tab via `src/lib/ffmpeg/engine.ts`'s `FfmpegEngine` singleton.
- ML inference: `onnxruntime-web` (WebGPU or WASM) and `@mediapipe/tasks-vision`, both running in-browser.
- No server-side rendering of user media, no upload to any backend. Every upload screen in the app states this as a product promise ("processed locally in this browser tab and is never uploaded anywhere") — **this plan must not violate that promise.**

### 1.2 Backend / API

There is effectively no backend. `astro.config.mjs` uses `output: "static"` (the default) with a single exception: `src/pages/api/transcribe-source.ts` opts itself into on-demand rendering (`export const prerender = false`) to shell out to `yt-dlp` for resolving remote video URLs (YouTube/TikTok/etc.) for the transcript tool. That's the entire server surface. There is no database, no user accounts, no project/session persistence beyond in-memory React state for the lifetime of a tab.

**Implication for this plan: no API, no auth, no storage-service work is needed.** The matting system is client-side, like everything else.

### 1.3 Media processing pipeline (existing)

Two parallel compositing paths already exist for "cut a subject out and put it on a new background," both of which this plan extends rather than replaces:

- **Live preview** (canvas, real-time): `src/lib/media/bg-removal-canvas.ts` — `keyChromaForeground` (chroma key), `applyMaskForeground` (bilinear-samples a `Float32Array` confidence mask as alpha — **already a continuous-alpha compositor**, not binary), `compositeBgRemoval` (full draw loop: background layer → foreground). Driven by `useBgRemovalPreview.ts` / `useChromaBgPreview.ts` feeding `FramedVideoStage`'s `canvasMode`/`onDrawFrame` API.
- **Export** (ffmpeg, final render): `src/lib/ffmpeg/bg-removal-command.ts` — `buildChromaRemovalCommand` (colorkey + despill), `buildAiCutoutRemovalCommand` (overlays pre-computed cutout PNG frames via `person-cutout-filter.ts`'s `planCutoutOverlay`). Driven by `useBgRemovalExport.ts`.

Both paths already support replace modes `transparent | color | gradient | blur | image | video` (`bg-removal-canvas.ts`'s `BgReplaceMode`) and already know how to export real alpha (ProRes 4444 `.mov`) when transparency is requested. **This plan's job is almost entirely to improve what feeds into these two paths as "the mask" — not to rebuild them.**

### 1.4 Existing ML/model infrastructure — the pattern to follow, not replace

This is the most important section for "don't rewrite unless necessary." The app already has a small but real model abstraction layer:

- `src/lib/ml/onnx-runtime.ts` — `detectRuntimeDevice()` picks WebGPU (with fp16 if the adapter supports `shader-f16`) or falls back to multithreaded WASM; `createInferenceSession()` wraps `onnxruntime-web` session creation with the right proxy/threading flags for this app's cross-origin-isolated environment.
- `src/lib/ml/model-cache.ts` — `downloadModelFile[FromUrl]` fetches a model (from an HF repo or an arbitrary same-origin URL), reporting byte-level progress, and caches it in the browser's Cache Storage (`clipbench-ml-models-v1`) so repeat visits don't re-download.
- `src/lib/media/selfie-segmenter.ts` — wraps MediaPipe's `ImageSegmenter` (Apache-2.0 selfie-segmentation model), GPU delegate with CPU fallback, self-hosted at `public/models/selfie_segmenter.tflite`.
- `src/lib/upscale/real-esrgan.ts` — wraps an ONNX super-resolution model through `onnx-runtime.ts` + `model-cache.ts`, self-hosted at `public/models/realesr-general-x4v3.onnx`. This is the closest existing precedent for "self-host a small ONNX model, run it through the shared runtime, tile large inputs to bound memory."
- `src/lib/captions/person-cutout.ts` — wraps RMBG-1.4 via `@huggingface/transformers`'s `pipeline("image-segmentation", ...)`, with a documented workaround for a real upstream config bug (`loadRmbgConfig` relabeling `model_type`). This is the model this plan recommends deprecating (see `MODEL_LICENSES.md`).

**Every one of these already follows the shape the brief asks for**: lazy-loaded, cached, singleton-per-model, GPU-with-CPU-fallback, progress-reporting. Section 3 below defines a thin common interface over this existing pattern rather than inventing a new one.

### 1.5 Worker / job architecture

There is no job queue or background-worker service. "Workers" in this codebase means literal Web Workers used for compute:

- ffmpeg.wasm's own worker (`ffmpeg-core.worker.js`, self-hosted, copied by `scripts/copy-ffmpeg-core.mjs` which also patches ffmpeg-core-mt's hardcoded thread-pool size — a real, previously-hit hang bug, see that script's comments).
- `onnxruntime-web`'s WASM execution proxy (`ort.env.wasm.proxy = true` in `onnx-runtime.ts`) — runs CPU inference off the main thread so a heavy model doesn't freeze the tab (explicitly why this exists: the upscale tool's SR net used to hang the UI).

Long-running work (exports, model downloads, frame-by-frame AI upscaling) is structured as `async`/`await` loops with a progress callback consumed by a `useXExport` hook and rendered via the shared `ExportStatus` component — see `useUpscaleExport`-style hooks and `upscale-media.ts`'s `upscaleVideoFile` (frame-by-frame extract → infer → re-mux loop). **This plan's video pipeline follows this exact same shape** (Section 6.2).

### 1.6 Asset / file storage

No persistent storage. Uploaded files live as in-memory `File`/`Blob` objects for the tab's lifetime; results are produced as new `Blob`s and downloaded via `URL.createObjectURL` + a synthetic `<a download>` click (see every tool's `downloadBlob`/`ResultPanel`). Model *weights* are the only thing persisted, via Cache Storage (`model-cache.ts`). **No new storage mechanism is needed.**

### 1.7 Editor / canvas architecture

`FramedVideoStage` (`src/components/tool/video/FramedVideoStage.tsx`) is the shared preview surface: fits a `<video>`/`<canvas>` into a letterboxed stage, exposes `canvasMode` (render a live-processed `<canvas>` over the video, fed by an `onDrawFrame` callback) and `checkerboard` (swap the black backdrop for a transparency checkerboard). This is exactly the surface the matting preview needs and it's already generic — no changes required, just a new `onDrawFrame` producer.

Region/mask editing UI already exists and is directly reusable for manual matte refinement:
- `RectOverlay` (`src/components/tool/video/RectOverlay.tsx`) — draggable/resizable box, used for logo/crop/passerby regions.
- `BrushOverlay` (`src/components/tool/video/BrushOverlay.tsx`) — freehand paint/erase strokes as a list of `{x,y}` points + radius, used by the Remove Logo tool's brush mode. **This is the "manual local refine" tool from the brief's diagram, already built.**

### 1.8 Undo/redo system

`src/lib/hooks/useHistoryState.ts` — a generic, structural-clone-based undo/redo with coalescing (rapid edits within 500ms merge into one checkpoint) and a full session timeline (`restoreTo`). The Video Editor's entire `EditorDocument` (crop, logo regions, chroma key, text, cuts, etc. — see `VideoEditorTool.tsx`) is threaded through exactly one `useHistoryState` instance via a generic `patch(key, updater, label)` helper. **This plan's non-destructive matte state (brush refinements, mode/model choice, replace-background settings) should live in the same kind of `patch()`-driven document**, either as new fields on the Remove Background tool's own local state (it doesn't currently use `useHistoryState` at all — see 1.9) or, if the brief's "undo/redo" requirement is to be taken literally for this tool, as a new `useHistoryState<MatteDocument>` instance scoped to that tool. Recommendation: introduce it scoped to the Remove Background tool (Phase 1), not retrofit the whole tool onto the Video Editor's shared document.

### 1.9 Export / render pipeline

Every tool follns the same shape: a `use<Tool>Export` hook exposing `{isProcessing, enginePhase, engineFraction, runFraction, error, result, run...()}`, rendered through the shared `ExportStatus` + `ResultPanel` components. `runFfmpeg()` (`engine.ts`) is the single choke point for every ffmpeg invocation — it stages inputs into ffmpeg's virtual FS, execs, reads the output, and cleans up, with a documented gotcha (a failed filter can still leave a 0-byte output file, so `runFfmpeg` explicitly checks for that rather than trusting a non-throwing `exec()`). Note also the recurring, load-bearing constraint across this codebase: **this ffmpeg-core.wasm build is single-threaded for filter execution** (`-filter_threads 1 -filter_complex_threads 1` appears in every command-builder, with comments explaining that certain filters — colorkey, chromakey, delogo — hang forever under the default multithreaded pool) and **`-threads 1` is required on every decoder input** (a documented pthread-pool-exhaustion hang, fixed once in `build-editor-command.ts` and separately in `bg-removal-command.ts`, `VideoSpeedTool.tsx`). Any new ffmpeg command this plan adds must carry the same flags.

### 1.10 API structure

Covered in 1.2 — one incidental server route, unrelated to this feature.

### 1.11 Authentication / project architecture

None exists. No user accounts, no saved projects, no server-side sessions. Nothing to integrate with.

### 1.12 Testing infrastructure

**There is none.** `package.json` has no test runner (no Vitest/Jest/Playwright in `devDependencies`), and a repo-wide search for `*.test.*`/`*.spec.*` under `src/` returns zero results (the only matches are inside `.agents/skills/`, which are Claude Code skill scripts unrelated to the app). This plan proposes introducing Vitest as the *first* test framework in this repo, scoped narrowly (Section 12) — not a wholesale testing-culture change forced onto the rest of the app.

### 1.13 Deployment infrastructure

Deployed via Vercel (`vercel.json` sets the two cross-origin-isolation headers ffmpeg.wasm's SharedArrayBuffer requires; `@astrojs/node` adapter in `standalone` mode powers the one dynamic route). `public/_headers` duplicates the same headers for Netlify/Cloudflare Pages compatibility. Static assets (including model weights under `public/models/`) are served as-is. **No deployment changes are needed** beyond adding new files under `public/models/`.

---

## 2. Proposed architecture (delta only)

Everything in Section 1 stays. This plan adds:

```
existing upload/tool UI (unchanged)
        │
        ▼
 MEDIA ANALYZER  (new, tiny) ── decides: image or video? rough subject
        │                        size/position? GPU available?
        ▼
 MODEL ROUTER    (new)       ── picks a model per Section 4, behind one
        │                        common interface (Section 3)
        ▼
 existing model wrappers (selfie-segmenter.ts, real-esrgan.ts-style)
   + two NEW wrappers (MODNet, U²-Net) following the exact same shape
        │
        ▼
 COARSE ALPHA (continuous, Float32Array — bg-removal-canvas.ts already
   consumes this shape via applyMaskForeground)
        │
        ▼
 ALPHA REFINEMENT (new, classical CV — guided filter, no new model)
        │
        ▼
 EDGE CLASSIFY (new, heuristic — informs which refinement strength to use,
   not a separate model)
        │
        ▼
 COLOUR DECONTAMINATION (new, classical CV, same family as the despill
   filter already used in bg-removal-command.ts's chroma path)
        │
        ▼
 [video only] TEMPORAL SMOOTHING (new, classical EMA — see MODEL_LICENSES.md
   for why this replaces RVM)
        │
        ▼
 QA ENGINE + AUTO-CORRECTION (new, heuristic checks + morphological cleanup)
        │
        ▼
 MANUAL REFINE (existing BrushOverlay component, new thin wiring only)
        │
        ▼
 FINAL ALPHA  ──────────────────────────────────────┐
        │                                            │
        ▼                                            ▼
 existing bg-removal-canvas.ts          existing bg-removal-command.ts
 (live preview, unchanged shape)        (ffmpeg export, unchanged shape,
                                          new alpha-input feeding it)
        │                                            │
        ▼                                            ▼
   preview canvas                          transparent/composited output
```

The existing chroma-key path is untouched end to end — this system only ever replaces "AI mode"'s mask source.

---

## 3. Model abstraction layer (common inference interface)

New file: `src/lib/matting/types.ts`

```ts
export interface MatteInput {
  source: CanvasImageSource;   // matches this app's existing convention everywhere
  width: number;
  height: number;
  /** Strictly increasing per-segmenter-instance timestamp — mirrors selfie-segmenter.ts's existing contract, kept identical so both model families share one call shape. */
  timestampMs: number;
}

export interface MatteResult {
  /** Continuous foreground confidence, 0-1, at the model's native output resolution — NOT resized to source here; callers (refinement stage) handle that, same division of labor bg-removal-canvas.ts already uses for applyMaskForeground. */
  alpha: Float32Array;
  alphaWidth: number;
  alphaHeight: number;
}

export type SubjectHint = "portrait" | "product" | "unknown";

export interface MatteModel {
  id: string;                 // e.g. "modnet", "u2net", "selfie-segmenter"
  /** What this model is best suited for — informs the router, not a hard constraint. */
  subjectHint: SubjectHint;
  supportsVideo: boolean;
  load(onProgress?: (fraction: number) => void): Promise<void>;
  infer(input: MatteInput): Promise<MatteResult>;
  dispose?(): void;
}
```

Every model — existing or new — gets a thin adapter implementing this interface:

- `src/lib/matting/models/selfie-segmenter-adapter.ts` — wraps the *existing* `loadSelfieSegmenter`/`segmentPersonMask` (no changes to `selfie-segmenter.ts` itself).
- `src/lib/matting/models/modnet.ts` — new, follows `real-esrgan.ts`'s exact shape (`downloadModelFileFromUrl` + `createInferenceSession` from the existing `onnx-runtime.ts`).
- `src/lib/matting/models/u2net.ts` — new, same shape.
- `src/lib/matting/models/rmbg-adapter.ts` — wraps the *existing* `loadSegmenter` (RMBG-1.4) from `person-cutout.ts`, unchanged, but the adapter itself carries a `LICENSE_WARNING` constant and is excluded from the router's default candidate list (Section 4) — reachable only behind an explicit "I have a commercial BRIA license" opt-in the router checks before ever selecting it.

This satisfies "every model must implement a common inference interface" and "models must be replaceable without rewriting the editor" — the router (Section 4) and refinement pipeline (Sections 7-9) only ever talk to `MatteModel`/`MatteResult`, never to a specific model's own API shape.

---

## 4. Model router / media analyzer

New file: `src/lib/matting/router.ts`.

**Media analyzer** (tiny, no model): given the uploaded file, reports `{ kind: "image" | "video", width, height, hasFace: boolean | "unknown" }`. Face detection is intentionally cheap and optional in Phase 1 — a real face-detector model is not in scope; `"unknown"` is a valid, honest answer, and the router treats it as "try the portrait model first, fall back to general" rather than blocking on a face-detection dependency that doesn't exist yet in this app.

**Router logic** (Phase 1, images and sparse-sampled video frames):

| Analyzer output | Primary model | Fallback |
|---|---|---|
| image/video, face likely present | MODNet | U²-Net |
| image/video, no face / unknown, general subject | U²-Net | MODNet |
| video, portrait framing, "occlude by person" / selfie-style use case | MediaPipe Selfie Segmenter (already integrated) | MODNet |

"Fallback" means: if the primary model's QA engine (Section 10) flags the result as likely-failed (e.g. alpha covers <2% or >98% of frame — mirrors the existing `NO_SUBJECT` error path in `bg-removal-image.ts`), automatically re-run with the fallback model before surfacing an error to the user.

This directly satisfies "do NOT hard-code the editor directly to one model" — `RemoveBackgroundTool.tsx` calls one function, `runMatteRouter(input, opts)`, and never imports a specific model module itself.

---

## 5. GPU strategy / CPU fallback

No new device-detection code. `detectRuntimeDevice()` (`src/lib/ml/onnx-runtime.ts`) already does exactly what's needed (WebGPU with fp16 if available, else multithreaded WASM) and is reused verbatim for MODNet's and U²-Net's ONNX sessions. MediaPipe's `ImageSegmenter` keeps its own existing GPU-delegate-with-CPU-fallback (`selfie-segmenter.ts`'s `createSegmenter("GPU").catch(() => createSegmenter("CPU"))`).

**New risk to verify in Phase 1** (not present in the existing upscale model): unlike `real-esrgan.ts`, which deliberately pins its model to WASM-only because the upstream ONNX export crashes WebGPU (JSEP) on a specific op, MODNet's and U²-Net's ONNX graphs have not yet been run through this app's WebGPU backend. Action: benchmark both on WebGPU before shipping; if either hits the same class of JSEP crash `real-esrgan.ts` documents, apply the same fix (pin to WASM, document why, exactly as that file does) rather than debugging the backend itself.

---

## 6. Image pipeline vs. video pipeline

### 6.1 Image pipeline (Phase 1)

Single inference call, synchronous-feeling UX (matches the existing "no green screen" image flow in `bg-removal-image.ts`):

1. Draw source image to a working canvas (existing pattern).
2. `runMatteRouter` → `MatteResult` (continuous alpha at model resolution).
3. Bilinear-upsample alpha to source resolution — **reuse `applyMaskForeground`'s existing bilinear-sampling loop** (it already does exactly this for the selfie-segmenter's mask; only needs a small refactor to expose the resize step standalone so the refinement stage in-between can operate on it, see Section 7).
4. Alpha refinement (Section 7) → edge classification (Section 8) → colour decontamination (Section 9).
5. Composite via the *existing* `compositeBgRemoval`/`drawBgReplacement` (unchanged).
6. Manual refine (Section 11) before final export, if the user opts in.

### 6.2 Video pipeline (Phase 2)

This is the one place this plan proposes a real architectural change, because the current video approach (sparse-sample at 2-8fps, hold the nearest sampled frame — `pickCutoutSampleFps`/`nearestCutoutFrame` in `person-cutout.ts`) is cheap but visibly "steps" between samples, and doesn't scale to a denser per-frame matte without hitting the documented `maxSafeCutoutInputs` ffmpeg thread-pool ceiling (each sampled cutout frame becomes its own `-loop 1` ffmpeg input; the pool only holds ~8-12 concurrent inputs).

**Proposed change: "alpha as its own video."** Instead of N separate looped-image ffmpeg inputs, generate one grayscale **alpha video** client-side (same frame-by-frame `<video>`-element decode loop `upscale-media.ts`'s `upscaleVideoFile`/`openVideoFrameSource` already uses — proven pattern, avoids ffmpeg's own flaky PNG muxer, which that file's comments note was found to hang), mux it into an ffmpeg input via the existing image-sequence-to-video approach, then merge it with the original color video in a **single** ffmpeg pass.

Merge filter: ffmpeg's `alphamerge` (or `[color][alpha]alphamerge`) is the natural fit. **Open risk, flagged, not assumed**: this project ships a custom minimal `ffmpeg-core.wasm` build (see `scripts/copy-ffmpeg-core.mjs` and the repeated "this filter isn't compiled into this build" comments already in the codebase for `blend`). `alphamerge`'s presence in this specific build must be verified before committing to this design — if it's missing, the fallback is compositing the alpha and color videos together directly during the frame-by-frame client-side loop (draw both into one RGBA canvas per frame, same as the image pipeline, then encode once) at the cost of losing hardware-accelerated ffmpeg encoding for that step.

Per-frame pipeline (mirrors `upscaleVideoFile`'s existing shape almost exactly):

1. Probe fps (`probeFps`, existing).
2. For each frame (fast mode caps at 15fps like the upscale tool's `FAST_MODE_MAX_FPS`; full mode uses source fps): decode via `<video>` + canvas (existing `openVideoFrameSource`/`grabFrame`), run the router, refine, decontaminate.
3. Write the refined alpha as a grayscale PNG frame + (if decontamination changed the RGB) the decontaminated color frame.
4. Temporal smoothing (Section 6.3) runs as a second pass over the buffered per-frame alphas before encoding, since it needs neighboring frames.
5. Encode alpha-video and (if changed) color-video via ffmpeg's image2 muxer (existing pattern from `upscaleVideoFile`), then one final `alphamerge`-or-fallback pass.

### 6.3 Temporal refinement (video)

No temporal *model* (RVM is GPL-3.0-blocked, see `MODEL_LICENSES.md`). Classical exponential-moving-average smoothing on the alpha channel across the buffered frame window: `alpha_t' = k·alpha_t + (1-k)·alpha_{t-1}'`, k tuned per subject-motion heuristic (faster inter-frame alpha change → higher k, so smoothing doesn't lag behind real motion). This is a known, honest limitation versus a purpose-built temporal network — documented as such, not oversold.

---

## 7. Alpha refinement pipeline

New file: `src/lib/matting/refine/guided-filter.ts`. A classical (public-domain-algorithm, no licensing concern) **guided filter** (He et al., edge-preserving smoothing using the source image as guidance) pass on the upsampled alpha — sharpens the matte back against real image edges instead of the soft blur a naive bilinear upsample produces. This is the mechanism behind the diagram's "ALPHA REFINEMENT" box; it's classical CV, not a model, so it carries zero licensing risk and no download cost.

---

## 8. Edge classification

New file: `src/lib/matting/refine/edge-classify.ts`. **Explicitly a heuristic, not a model** — worth stating plainly so "hair/hard/soft" in the diagram isn't read as a claim this ships a hair-specific matting network (none of the license-clear candidate models are trimap-based hair specialists; true state-of-the-art hair matting generally needs a user-supplied trimap or a much heavier network than fits this app's in-browser budget). The heuristic: for each local window of the alpha map, classify as

- **hard** — low local alpha-gradient variance, alpha near 0 or 1 (e.g. a product's clean silhouette edge),
- **soft** — high local alpha-gradient variance across many pixels (e.g. motion blur, glass, semi-transparent fabric),
- **hair** — high local *frequency* (Sobel/Laplacian energy on the source image) co-located with partial alpha values, distinguishing thin repeated structures from a smooth soft edge.

The classification's only job is to pick the guided filter's radius/epsilon per-region (hair regions get a smaller radius so fine strands survive; soft regions get a larger radius). It is not exposed to the user as a labeled feature ("hair mode") — overclaiming a capability heuristics can't reliably deliver would violate the brief's own "no unsupported quality claims" instruction.

---

## 9. Colour decontamination

New file: `src/lib/matting/refine/decontaminate.ts`. For semi-transparent alpha pixels, the source pixel's RGB is a blend of true foreground color and whatever background showed through — compositing it as-is onto a *new* background produces a visible fringe (the classic green-screen "green fringe on hair" problem, already solved for the chroma path via ffmpeg's `despill` filter in `bg-removal-command.ts`). This module is the AI-matte equivalent: estimate the local background color from nearby fully-transparent (alpha≈0) pixels, then unmix each semi-transparent pixel's color: `true_fg = (observed - (1-alpha)·estimated_bg) / alpha`. Classical technique (closed-form matting literature), no model, no license concern.

---

## 10. QA engine + auto-correction

New file: `src/lib/matting/qa.ts`. Heuristic checks, each with a defined auto-correction:

| Check | Threshold (starting point, tune during Phase 3 benchmarking) | Auto-correction |
|---|---|---|
| Alpha coverage collapse | <2% or >98% of frame is foreground | Re-run router with fallback model (Section 4); if still failing, surface the existing `NO_SUBJECT`-style error |
| Speckle noise | Many small (<0.1% of frame area) disconnected alpha islands | Connected-component analysis, keep only the largest N components |
| Edge ringing | High-frequency alpha oscillation right at the guided-filter boundary | Reduce guided-filter epsilon and re-run refinement only (cheap — doesn't re-run the model) |

This is explicitly a **rules engine over the alpha map**, not a learned QA model — consistent with keeping new model-licensing surface area to the two ONNX models already justified above.

---

## 11. Manual local refinement

No new UI primitive needed. `BrushOverlay` (already built for the Remove Logo tool) is reused: paint strokes stored as `{x,y}` points + radius, same as today, but instead of feeding `logo-removal.ts`'s delogo filter, strokes are rasterized into a mask that's **added to or subtracted from** the current alpha channel (paint = force-foreground, alt/erase mode = force-background) before the final composite. `RectOverlay`'s pattern is similarly reusable for a coarser "protect this whole region" tool if Phase 1 feedback shows brush-only isn't enough. All refinement happens on the **matte**, never on the original pixels — satisfying "do not destroy original pixels" by construction, since the source `File`/`Blob` this app already never mutates (confirmed pattern across every existing tool) is never touched by this step.

---

## 12. Non-destructive editing / undo-redo / final alpha

- Original source `File` is held exactly as today (never mutated) by the tool's existing `useVideoFile`/file-state pattern.
- New tool-scoped state: a `MatteDocument` (model choice, per-region brush refinements, replace-background settings) threaded through a **new, tool-scoped** `useHistoryState<MatteDocument>` instance (Section 1.8) — every matte-affecting action (mode switch, brush stroke, "reset matte") is a `patch()` call, giving free undo/redo/timeline consistent with the rest of the app, without touching the Video Editor's own `EditorDocument`.
- "Reset matte" always means "re-run the router from scratch," never "restore a cached original" — since the model output is deterministic per-input, there's nothing destructive to protect against beyond what `useHistoryState` already gives for free.
- **Final alpha** is the single `Float32Array` (image) or alpha-video (video) that both `bg-removal-canvas.ts` (preview) and `bg-removal-command.ts` (export) consume — no divergence between what the user previewed and what gets exported, which is not fully true of the current implementation (the AI-video preview already sample-and-holds, matching what export does, so this is preserved, not regressed).

---

## 13. UI requirements

Minimal, additive changes to `RemoveBackgroundTool.tsx` only:

- The existing `mode` toggle ("I have a green screen" / "No green screen (AI)") stays. Under "No green screen (AI)," add a small "Matte quality" sub-choice: **Fast** (today's RMBG-1.4/selfie-segmenter path, kept for back-compat and as an instant rollback target) vs. **Precision** (new router-driven pipeline). Default to Precision once Phase 1-3 benchmarking clears it; until then, ship it opt-in.
- A "Refine" step (new) appears after the AI cutout is produced: brush tool (reusing `BrushOverlay`) over a checkerboard preview of just the alpha, with add/subtract modes — mirrors the Remove Logo tool's existing brush UX almost exactly, so no new interaction pattern for users to learn.
- QA auto-correction is silent (no UI) unless it *fails* to recover, in which case it surfaces the same style of inline error the tool already has (`describeError` in `useBgRemovalExport.ts`).
- No changes to the Video Editor's own chroma-key panel (out of scope — that panel already has its own, separate, non-AI chroma pipeline, covered by the earlier logo/cuts/transparent-export work already merged this session).

---

## 14. API requirements

None. Confirmed in Section 1.2/1.10 — this is a purely client-side feature.

---

## 15. Storage requirements

None beyond the existing Cache Storage convention (`model-cache.ts`) for the two new model weight files. No database, no server-side asset storage.

---

## 16. Caching strategy

Reuse `model-cache.ts` verbatim: `downloadModelFileFromUrl` for MODNet/U²-Net (self-hosted under `public/models/`, matching the existing `real-esrgan.ts`/`selfie-segmenter.ts` convention of self-hosting small, permissively-licensed weights rather than fetching from a third-party HF repo at runtime). No new cache mechanism.

---

## 17. Performance strategy

- Tile large images if either new ONNX model's native input resolution is small relative to typical uploads (mirrors `real-esrgan.ts`'s `TILE`/`OVERLAP` tiling — verify at implementation time whether MODNet/U²-Net need this or whether their standard 512×512-ish input resolution with a single resize-down/resize-up is sufficient, which is the more common approach for segmentation-class models vs. super-resolution).
- Fast/Full quality split for video (Section 6.2), mirroring the upscale tool's existing `VideoUpscaleQuality` pattern exactly.
- Guided filter and decontamination are O(pixels) classical passes — cheap relative to model inference; not expected to be a bottleneck, but worth profiling once real benchmarks exist (Section 18) rather than assumed.

---

## 18. Testing strategy

Given zero existing test infrastructure (Section 1.12), scope is deliberately narrow:

- **Introduce Vitest** (new devDependency — first test framework in this repo) for the pieces that are pure functions over typed arrays and don't need a browser/GPU: guided filter math, colour decontamination math, morphological cleanup, QA heuristic thresholds, router decision logic. These are all unit-testable in Node with synthetic `Float32Array`/`ImageData`-shaped fixtures.
- **No automated visual-regression harness in Phase 1-3** — building one (pixel-diff against hand-labeled ground-truth mattes) is a real, separate investment this plan doesn't assume away; it's listed as a Phase 4/future item, not required for ship.
- **Manual QA via chrome-devtools-mcp**, the pattern already established this session (upload a real clip, exercise the UI, check console errors) — this catches integration/runtime issues Vitest's pure-function tests can't (WebGPU crashes, ffmpeg filter-availability gaps, actual visual quality).

---

## 19. Benchmark strategy

A small, curated set of deliberately difficult fixtures (not claimed to be a rigorous academic benchmark) covering the brief's own list: hair, glasses, motion-blurred edges, clothing edges, a semi-transparent object, a busy/textured background, a product shot. Stored under a new `src/lib/matting/__fixtures__/` (small images only — video fixtures stay out of the repo, sourced locally during manual QA instead, to avoid bloating the repo with binary video assets).

**No ground-truth mattes exist for these fixtures** (hand-labeling them is out of scope for this plan) — so quality claims are limited to *relative* comparisons (this pipeline vs. today's RMBG-1.4/selfie-segmenter path, side by side, judged by a human) and a small set of *objective-but-partial* signals that don't require ground truth: edge gradient energy at the alpha boundary (sharper = generally better, with diminishing-returns judgment needed since "sharper" isn't always "correct"), foreground color-bleed estimate before/after decontamination, coverage-collapse rate across the fixture set. **This plan does not claim "Photoshop-level" quality anywhere** — per the brief's own instruction, that phrase is only a stated aspiration to benchmark toward, not a claim to make before the benchmarking in this section has actually run.

---

## 20. Rollback strategy

Purely additive by construction:

- Nothing in Sections 1.3/1.4/1.7/1.9 (the existing compositing/export/preview code) is modified in a breaking way — only extended to accept a richer alpha/decontaminated-color input than today's single confidence mask, which `applyMaskForeground`'s existing bilinear-sampling shape already accommodates.
- The existing RMBG-1.4/selfie-segmenter "Fast" path (Section 13) stays fully wired and is the default until Precision mode clears benchmarking — an instant rollback is "flip the default back," not "revert a merge."
- No database migrations, no API versioning, no deployment changes to roll back.

---

## 21. Known limitations (stated up front, not discovered later)

- No dedicated temporal video-matting network (RVM is license-blocked) — video temporal consistency comes from classical EMA smoothing, which will visibly lag behind a purpose-built network on fast motion. See `MODEL_LICENSES.md`.
- No true trimap-based hair matting — the edge classifier is a heuristic that tunes classical refinement strength, not a hair-specialist model. Fine hair-strand separation on a busy background will not match paid, server-side, heavier-model competitors.
- BackgroundMattingV2's precision (Section 4/`MODEL_LICENSES.md`) is only reachable when the user's own footage happens to include a clean background-only plate, which this app's single-clip upload flow essentially never provides — treat it as a documented-but-rarely-used path, not a headline feature.
- No hand-labeled ground truth for objective quality scoring (Section 19) — benchmarking is comparative and human-judged, not a published metric.
- Face detection in the media analyzer (Section 4) is a heuristic "unknown is fine" placeholder in Phase 1, not a real face detector — the router degrades gracefully (tries both candidate models) rather than depending on it being accurate.

---

## 22. Security considerations

- **Hard constraint carried over from the existing product principle**: no user media may ever leave the browser tab. Every model in this plan runs in-browser (matches the existing pattern exactly) — no cloud matting API is in scope, ever, regardless of quality tradeoffs that might tempt one later.
- Model weights are fetched over HTTPS from either same-origin (`public/models/`, self-hosted) or, for any model this plan doesn't self-host, the existing Hugging Face resolve-URL convention (`model-cache.ts`) — no new third-party origin is introduced.
- **Pre-existing, not newly introduced**: downloaded model bytes are not currently hash-pinned/SRI-verified anywhere in this codebase (`model-cache.ts` trusts the fetch response). Not a regression this plan causes, but worth flagging as a Phase 4 hardening candidate (verify a known SHA-256 for each self-hosted model file before use) rather than silently inheriting it forever.
- New Vitest dev-dependency (Section 18) is dev-only, never ships to production bundles.

---

## 23. Implementation phases

**Phase 1 — Image pipeline, license-safe model swap** (the highest-value, lowest-risk slice)
- `src/lib/matting/types.ts`, `router.ts`, `models/{modnet,u2net,selfie-segmenter-adapter,rmbg-adapter}.ts`.
- MODNet + U²-Net ONNX wrappers, self-hosted weights + `public/models/LICENSES/`.
- `refine/{guided-filter,edge-classify,decontaminate}.ts`.
- Wire into `RemoveBackgroundTool.tsx`'s image path only, behind the new "Matte quality: Fast/Precision" toggle (Section 13), Fast still defaulted.
- New `useHistoryState<MatteDocument>` + `BrushOverlay` refinement wiring for images.
- Benchmark fixtures + manual chrome-devtools-mcp QA (Section 18/19).

**Phase 2 — Video pipeline**
- `video/alpha-video.ts` (dense per-frame alpha generation, mirrors `upscale-media.ts`'s frame-loop), `video/temporal-smoothing.ts`.
- Verify `alphamerge` filter availability in this project's ffmpeg-core.wasm build; implement the client-side-composite fallback if it's missing.
- Extend `bg-removal-command.ts` with a new, additive `buildRouterMatteVideoCommand` alongside (not replacing) `buildAiCutoutRemovalCommand`.
- Fast/Full quality split.

**Phase 3 — QA engine + auto-correction + testing**
- `qa.ts`, morphological cleanup.
- Introduce Vitest; unit-test every pure-function module from Phases 1-2.
- Expand benchmark fixture set; run the comparative (not absolute) quality pass from Section 19; decide whether Precision becomes the new default.

**Phase 4 — Follow-ups, explicitly out of scope for v1**
- Consolidate `person-cutout.ts`'s other RMBG-1.4 callers (captions "occlude by person," passerby-track) onto the new router, once it's proven out on the Remove Background tool.
- Investigate a license-clear temporal video-matting model as a genuine RVM replacement (none identified during this plan's research — see `MODEL_LICENSES.md`), or pursue a commercial RVM/BRIA license if either becomes strategically worthwhile.
- Model-weight hash pinning (Section 22).
- Automated visual-regression benchmarking against hand-labeled ground truth.

---

## 24. Files to create

```
MODEL_LICENSES.md                              (done — this plan's companion doc)
MATTE_IMPLEMENTATION_PLAN.md                   (this file)
src/lib/matting/types.ts
src/lib/matting/router.ts
src/lib/matting/qa.ts
src/lib/matting/models/modnet.ts
src/lib/matting/models/u2net.ts
src/lib/matting/models/selfie-segmenter-adapter.ts
src/lib/matting/models/rmbg-adapter.ts
src/lib/matting/refine/guided-filter.ts
src/lib/matting/refine/edge-classify.ts
src/lib/matting/refine/decontaminate.ts
src/lib/matting/refine/morphology.ts
src/lib/matting/video/alpha-video.ts
src/lib/matting/video/temporal-smoothing.ts
src/lib/matting/__fixtures__/*.png             (Phase 3)
public/models/modnet.onnx (+ LICENSES/MODNET_LICENSE.txt)
public/models/u2netp.onnx (+ LICENSES/U2NET_LICENSE.txt)
```

## 25. Files to modify

```
src/lib/media/bg-removal-canvas.ts     — extend applyMaskForeground's resize step to be
                                          callable standalone (refinement needs the
                                          upsampled-but-not-yet-composited alpha)
src/lib/ffmpeg/bg-removal-command.ts   — additive: new buildRouterMatteVideoCommand,
                                          existing functions untouched
src/lib/hooks/useBgRemovalPreview.ts   — additive: new mode branch, existing branches untouched
src/lib/hooks/useBgRemovalExport.ts    — additive: new run function, existing ones untouched
src/components/tool/video/RemoveBackgroundTool.tsx — new "Matte quality" toggle + refine step UI
package.json                           — add vitest (devDependency only)
```

**Nothing is deleted or rewritten in Phase 1-3.** `person-cutout.ts`'s existing RMBG-1.4/selfie-segmenter code paths keep working exactly as today for every current caller until Phase 4 explicitly revisits them.
