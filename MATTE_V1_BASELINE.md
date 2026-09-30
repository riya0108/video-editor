# Matte System — v1.0.0 Baseline

This is a frozen, point-in-time record of the matting/background-removal subsystem as it exists at the git commit noted below. It records what's actually in the tree today — nothing here reflects a change made as part of creating this document. See `MATTE_PRODUCTION_READINESS_REPORT.md` for the audit that immediately preceded this baseline, and `MATTE_IMPLEMENTATION_PLAN.md` / `MODEL_LICENSES.md` / `MEDIA_SECURITY.md` / `PERFORMANCE.md` for the detailed phase-by-phase history this baseline consolidates.

## Versions

| Component | Version |
|---|---|
| **Application** (`package.json`) | `video-editor` @ `0.0.1` |
| **Matting subsystem** | `v1.0.0` (this document defines it — no prior version was ever formally cut; first baseline after the Phase 1–17 build-out + the production-readiness fix pass) |
| Node.js (dev/build environment observed) | v26.5.0 |
| npm | 11.17.0 |
| Astro | 7.2.3 (installed; `^7.2.0` in `package.json`) |
| React / react-dom | 19.2.8 |

## Integrated ML models

All models are self-hosted under `public/models/` and run entirely client-side via ONNX Runtime Web or MediaPipe Tasks Vision — no model inference call ever leaves the browser.

| Model | Adapter | modelId | Role | Registered in production registry? |
|---|---|---|---|---|
| **U²-Net (portable, u2netp)** | `src/lib/matting/models/u2net.ts` | `u2net` | General/product segmentation — the only model actually reachable for the "no green screen" image path today | ✅ Yes |
| **MediaPipe Selfie Segmenter** | `src/lib/matting/models/selfie-segmenter-adapter.ts` | `mediapipe-selfie-segmenter` | Portrait segmentation, image + video | ✅ Yes |
| **BRIA RMBG-1.4** | `src/lib/matting/models/rmbg-adapter.ts` | `rmbg-1.4` | General segmentation | ✅ Registered, but **not reachable in practice** — non-commercial license excludes it from `isEligible()` unless a caller passes `allowNonCommercial: true`, and no production caller does |
| **RobustVideoMatting (RVM)** | `src/lib/matting/models/rvm.ts` | `rvm` | Temporal video matte | ✅ Registered as a deliberate, permanent stub — GPL-3.0 copyleft; `load()` always throws, `isEligible()` excludes it unconditionally; never executes any real GPL code |
| **MODNet** | `src/lib/matting/models/modnet.ts` | `modnet` | Portrait matting | ❌ **Not registered** — weight file was never bundled; excluded from `createModelRegistry()` as of the production-readiness fix pass (previously registered, and previously outranked u2net for every image request, causing a guaranteed 404 + user-visible warning on every one-click removal — see `MATTE_PRODUCTION_READINESS_REPORT.md` finding H1) |
| **BackgroundMattingV2** | `src/lib/matting/models/background-matting-v2.ts` | `background-matting-v2` | Known-background matte | ❌ **Not registered** — same reason as MODNet (weight file never bundled) |

Two other ML models exist elsewhere in the app for related-but-separate features, outside the matting subsystem's own scope but sharing its infrastructure:
- `realesr-general-x4v3.onnx` — the Upscale tool's super-resolution model (unrelated to matting).
- RMBG-1.4 is also still used directly (bypassing the matting router entirely) by `src/lib/ffmpeg/passerby-track.ts` (Remove Passerby's auto-tracking) via `person-cutout.ts`'s `loadSegmenter`. This is a real, currently-shipping non-commercial-license dependency outside the matting pipeline proper.
- The Video Editor's captions "occlude by person" style (`generatePersonCutouts`) uses the MediaPipe selfie segmenter directly (Apache-2.0), not RMBG.
- `person-cutout.ts`'s `generateSubjectCutouts` (the older, direct RMBG-1.4 call path) is dead code as of this baseline — confirmed zero real callers (only referenced in comments); superseded by `video-cutout.ts`'s router-driven `generateSubjectCutoutsViaMatting`.

## Model / checkpoint versions (provenance)

| File | Size | SHA-256 | Source |
|---|---|---|---|
| `public/models/u2netp.onnx` | 4,574,861 bytes (4.4M) | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` | Unmodified, downloaded from `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx` — the exact ONNX export the `danielgatis/rembg` tool itself uses at runtime. Verified functional end-to-end (Node/`onnxruntime-node` smoke test + live in-browser). |
| `public/models/selfie_segmenter.tflite` | 244K | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` | Google's MediaPipe Selfie Segmenter, already in production before the matting subsystem existed (predates Phase 1). |
| `briaai/RMBG-1.4` | — (fetched at runtime, not bundled) | — | Hugging Face Hub, `main` revision (not pinned to a specific commit — `src/lib/captions/person-cutout.ts`'s `loadRmbgConfig` fetches `.../resolve/main/config.json`). |
| `public/models/modnet.onnx` | — | — | **Does not exist.** Adapter code exists and is fully implemented; not bundled, not registered (see above). |
| `public/models/background-matting-v2.onnx` | — | — | **Does not exist.** Same status as MODNet. |

License text/provenance NOTICE for redistributed weights: `public/models/LICENSES/U2NET_LICENSE.txt`, `public/models/LICENSES/U2NET_NOTICE.txt`.

## Dependencies and versions (matting-relevant)

Resolved versions per `package-lock.json` at this commit:

| Package | Version | Role |
|---|---|---|
| `onnxruntime-web` | `1.26.0-dev.20260416-b7804b056c` | ONNX inference runtime (WASM + WebGPU execution providers) — pinned to a dated dev/nightly prerelease, not a stable release; reason undocumented in the tree (flagged as MEDIUM risk in the production-readiness report) |
| `@mediapipe/tasks-vision` | `1.0.1` | MediaPipe runtime (selfie segmenter) |
| `@huggingface/transformers` | `4.2.0` | Runs RMBG-1.4 (transformers.js) |
| `@ffmpeg/ffmpeg` | `0.12.15` | Video export (transparent-alpha video encode/decode, frame extraction for validation) |
| `@ffmpeg/util` | `0.12.2` | ffmpeg.wasm helper (`fetchFile`) |
| `@ffmpeg/core-mt` | `0.12.10` | Multi-threaded ffmpeg WASM core (patched thread-pool size — see `scripts/copy-ffmpeg-core.mjs`) |
| `astro` | `7.2.3` | App framework |
| `react` / `react-dom` | `19.2.8` | UI |

## Model licenses (summary — see `MODEL_LICENSES.md` for full detail)

| Model | License | Commercial use | Status in this baseline |
|---|---|---|---|
| U²-Net | Apache-2.0 | ✅ Yes | Bundled, live, the only model actually reachable for images today |
| MediaPipe Selfie Segmenter | Apache-2.0 | ✅ Yes | Bundled, live |
| BRIA RMBG-1.4 | Non-commercial only (BRIA's own license; paid commercial license available separately) | ❌ No (without a paid license) | Registered in the matting router but unreachable by default; **still directly powers Remove Passerby's auto-tracking** (`passerby-track.ts`) outside the matting router — treat that one feature as commercially unshippable without a BRIA license |
| RobustVideoMatting (RVM) | GPL-3.0 | ⚠️ Copyleft — do not integrate | Permanent stub only; `load()` always throws; no GPL code ever executes |
| MODNet | Apache-2.0 | ✅ Yes (once bundled) | Not bundled, not registered |
| BackgroundMattingV2 | MIT | ✅ Yes (once bundled) | Not bundled, not registered |
| `onnxruntime-web` | MIT | ✅ Yes | Runtime only, no weight implications |

## Current benchmark results

Captured live against this exact codebase, on the reviewing machine (8 CPU cores, ~8GB device memory, WebGPU available via Apple/Metal-3). Both benchmarks are internal, unlisted diagnostic tools (`/tools/video/remove-background-benchmark`, `/tools/video/matte-quality-benchmark`) that run the real production pipeline — not synthetic stand-ins.

### Performance (`remove-background-benchmark`)

Model used throughout: `u2net` (WASM execution provider — pinned; see `MATTE_IMPLEMENTATION_PLAN.md`/`u2net.ts` for the confirmed WebGPU MaxPool incompatibility that forces this).

| Case | Resolution | Inference | Total | Peak memory (JS heap delta) | Throughput |
|---|---|---|---|---|---|
| image-480p | 854×480 | 881ms | 1964ms | 28.3MB | 0.51 fps |
| image-720p | 1280×720 | 340ms | 1033ms | 30.7MB | 0.97 fps |
| image-1080p | 1920×1080 | 303ms | 1616ms | 143.7MB | 0.62 fps |
| video-480p @2fps | 854×480 | 2205ms | 2612ms | 0.0MB* | 2.30 fps |
| video-720p @4fps | 1280×720 | 2174ms | 3014ms | 0.0MB* | 1.99 fps |
| video-1080p @8fps | 1920×1080 | 1943ms | 3970ms | 194.5MB | 1.51 fps |

*0.0MB peak-memory readings reflect GC having already run between measurements — an artifact of the JS-heap-delta approximation method, not a claim of zero allocation (see the tool's own footer note). GPU memory is always `n/a` — no browser API exposes it to page JS.

### Quality (`matte-quality-benchmark`, version label `v1.0.0-baseline`)

Permanent synthetic dataset with exact ground truth (34 cases: 3 Easy, 5 Medium, 17 Hard, 9 Video). All 34/34 succeeded — zero crashes, zero failures.

| Category | Cases | Succeeded | Mean SAD | Mean MSE | Mean MAD | Mean gradient err. | Mean connectivity err. |
|---|---|---|---|---|---|---|---|
| Easy | 3 | 3 | 341.22 | 0.0003 | 0.0015 | 0.0080 | 0.0000 |
| Medium | 5 | 5 | 1186.00 | 0.0023 | 0.0051 | 0.0188 | 0.0023 |
| Hard | 17 | 17 | 7621.37 | 0.0150 | 0.0331 | 0.0325 | 0.0506 |
| Video | 9 | 9 | — | — | 0.0121 (MAD) | — | temporal consistency err. 0.0031 |

Worst individual Hard-category cases (all transparency/soft-edge class — a known, inherent limitation of u2net's binary segmentation, not a bug): `hard-semi-transparent-fabric` (MAD 0.1008), `hard-smoke-like-regions` (0.0843), `hard-curly-hair` (0.0760), `hard-transparent-objects` (0.0752).

**These numbers are only meaningful relative to future runs of this same benchmark** — never presented as equivalent to any other product's output or to the alphamatting.com leaderboard (the benchmark tool's own stated policy).

### Test suite

`npx vitest run`: **434/434 tests passed**, 51 files, 0 failures. `npx tsc --noEmit`: clean. `npm run build`: succeeds.

## Known limitations

Carried forward from `MATTE_PRODUCTION_READINESS_REPORT.md` (all CRITICAL/HIGH findings from that review are already fixed as of this baseline; the following MEDIUM/LOW items remain open by design — this baseline does not attempt to fix them):

1. **Default automatic pipeline uses simpler decontamination/hair-refinement engines**, not the more sophisticated `ColourDecontaminationEngine`/hair-refinement engines that exist in the codebase — those only run via manual refinement's one-click buttons.
2. **Per-frame video-cutout failures are silently swallowed** with no threshold-based warning — a clip where many frames failed looks identical, from the UI, to one where the subject legitimately left frame.
3. **`onnxruntime-web` is pinned to a dated nightly/dev prerelease** with no documented reason.
4. **Model-adapter `load()` has no concurrency guard** — two overlapping calls on the same instance could each create a real session, leaking the first (not reachable via the current UI, which disables the button while processing).
5. **Completed brush strokes always trigger a full-image recompute** in manual refinement rather than using the `DirtyRegion` the engine already computes — a latency-only cost on large images, not a correctness issue.
6. **One-click "Enhance hair detail"/"Reduce colour spill" are not themselves undoable** — they reset the undo/redo history rather than participating in it.
7. **U²-Net (the only bundled, working model) has no true soft-transparency modeling** — confirmed by this baseline's own benchmark numbers above (worst scores are all glass/smoke/sheer-fabric-class cases). No in-UI warning exists for users attempting these subjects.
8. **`frame-source.ts`'s `dispose()` never resolves pending waiters** — a latent deadlock risk, currently unreachable since nothing in production calls this module (see next item).
9. **The entire `src/lib/matting/video/` temporal-consistency subsystem, `model-router.ts`'s difficulty-aware routing, and the 12-signal `MatteQualityEngine`** are fully built and individually tested but are **not on the production path** — confirmed via repo-wide import search. The shipped video AI-cutout path runs each sampled frame through the plain image pipeline independently, with no temporal smoothing. Do not describe "temporal consistency," "intelligent routing," or the rich per-defect quality report as shipped, user-facing features on the strength of this code's existence — they are not reachable from any real user request today.
10. **Export validation only samples one mid-point frame** for transparent-video alpha checks, not the full timeline.
11. **RMBG-1.4 (non-commercial license) still directly powers Remove Passerby's auto-tracking feature** (`passerby-track.ts`) — this one feature is not commercially shippable without a separate BRIA license, independent of the matting router's own (correct) exclusion of RMBG-1.4 by default.
12. **`refine/viewport.ts`** (a complete zoom/pan coordinate module) exists but is unused — no zoom/pan capability exists in the shipped manual-refinement brush tool.

## What this baseline is not

This document does not itself change any code, fix any of the limitations above, or benchmark alternative approaches — it is a snapshot for future comparison, per the explicit scope of this task.
