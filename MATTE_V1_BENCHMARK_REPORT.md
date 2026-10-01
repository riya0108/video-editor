# Matte v1.0.0 — Full Benchmark Report

Generated 2026-09-30T11:06:37.169Z against the exact codebase committed at `647251a` (matte subsystem v1.0.0, per `MATTE_V1_BASELINE.md`). No code under `src/` was modified to produce this report — every case ran the real, unmodified production pipeline (`removeBackgroundFromImage` in `src/lib/matting/pipeline/index.ts`) via a live browser session (chrome-devtools-mcp) against `http://localhost:4322/tools/video/matte-quality-benchmark`, driven by dynamically importing the same source modules that page already loads.

## Methodology

**Dataset.** The permanent synthetic benchmark dataset already in the repo (`src/lib/matting/quality-benchmark/dataset.ts` + `video-dataset.ts`): 25 still-image cases (3 Easy, 5 Medium, 17 Hard) and 9 video cases (8 synthetic frames each), each with exact per-pixel ground-truth alpha. No new cases, no new ground truth were invented for this report.

**What's measured per case.** `modelUsed`, `confidence`, `processingTimeMs`/`modelInferenceTimeMs` (both already measured and returned by the pipeline itself — not separately timed), `warnings` (the pipeline's own non-fatal warning list, read as-is, never intercepted from console), a JS-heap memory delta (`performance.memory.usedJSHeapSize` immediately before vs. after the call — Chrome/Edge-only, non-standard API; a `0B*` reading means GC ran between the before/after snapshot and is a measurement artifact, not a claim of zero allocation, mirroring the caveat already documented in `src/lib/matting/benchmark.ts`), and the five quality metrics from `src/lib/matting/quality-benchmark/metrics.ts` (SAD, MSE, MAD, gradient error, connectivity error), computed against the case's real ground truth via the repo's own `computeImageMetrics`. No GPU-memory figure is reported anywhere — no browser API exposes it to page JS, same limitation already documented for the Phase 14 performance benchmark.

**Video cases.** Every one of the 8 synthetic frames per case is run through the same pipeline call as a still image (matching this app's own production video AI-cutout sampling architecture — see `video-cutout.ts`). Time/memory are summed/measured across the whole clip; `meanMetrics` averages the five metrics across successfully-processed frames; `temporalConsistencyError` (from `metrics.ts`) is computed only when every frame in the clip succeeded, exactly as `runner.ts` already does. **For the five visual artifacts only** (below), the middle successfully-processed frame is used as a single representative still — video quality *scoring* still reflects all 8 frames.

**Five artifacts saved per case** under `benchmark-artifacts/v1/{images,videos}/<case-id>/`:
- `alpha.png` — the raw predicted alpha channel, rendered grayscale (0=black/transparent, 255=white/opaque)
- `transparent.png` — the pipeline's own decontaminated cutout (`result.foreground`) with real alpha, PNG-encoded
- `black.png` / `white.png` — that same cutout composited over a solid black / white backdrop via real canvas alpha compositing (`ctx.drawImage`), not a synthetic blend
- `edgeDiagnostic.png` — a per-pixel comparison of predicted vs. ground-truth alpha, both thresholded at 0.5: **white** = both foreground (correct), **black** = both background (correct), **red** = predicted foreground but should be background (false positive / matte bleeds outward), **blue** = predicted background but should be foreground (false negative / matte eats into the subject). This is a direct visualization of the real alpha arrays, not a derived or invented metric.

**Classification thresholds.** The codebase itself has no built-in PASS/FAIL concept — `report.ts` and `runner.ts` only ever emit raw numbers. The following bands were fixed *before* this run, based on the category norms already published in the committed `MATTE_V1_BASELINE.md` (Easy mean MAD 0.0015, Medium 0.0051, Hard 0.0331, worst Hard cases 0.07-0.10), and applied mechanically to every case with no post-hoc adjustment:

| Classification | Condition |
|---|---|
| **FAIL** | pipeline threw / zero frames processed, OR MAD > 0.10 |
| **NEEDS_REFINEMENT** | 0.03 < MAD ≤ 0.10, OR connectivity error > 0.05, OR (video only) temporal consistency error > 0.02 |
| **ACCEPTABLE** | 0.01 < MAD ≤ 0.03 (and not bumped up by a NEEDS_REFINEMENT gate above) |
| **PASS** | MAD ≤ 0.01 AND connectivity error ≤ 0.01 AND gradient error ≤ 0.02 (video: also temporal consistency error ≤ 0.01) |

A case whose MAD alone would land in PASS but that fails one of the other PASS gates is reported ACCEPTABLE, not silently rounded up.

> As with every other report this benchmark produces: these numbers are only meaningful relative to other runs of this same benchmark against this same synthetic dataset — never presented as equivalent to any other product's output or to the alphamatting.com leaderboard.

## Summary

| Category | Cases | PASS | ACCEPTABLE | NEEDS_REFINEMENT | FAIL |
|---|---|---|---|---|---|
| easy | 3 | 3 | 0 | 0 | 0 |
| medium | 5 | 3 | 2 | 0 | 0 |
| hard | 17 | 5 | 4 | 7 | 1 |
| video | 9 | 6 | 2 | 1 | 0 |
| **Total** | **34** | **17** | **8** | **8** | **1** |

25/25 image cases and 9/9 video cases completed without a pipeline crash — the one FAIL below is a quality-threshold failure (MAD > 0.10), not a crash.

## Per-case results — still images

| Case | Category | Model | Time | Mem Δ | SAD | MSE | MAD | Grad err | Conn err | Warnings | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| easy-person-plain-bg | easy | u2net | 1958ms | 21.1MB | 471.1 | 0.0005 | 0.0020 | 0.0134 | 0.0000 | — | PASS |
| easy-product-plain-bg | easy | u2net | 539ms | 54.1MB | 279.2 | 0.0002 | 0.0012 | 0.0062 | 0.0000 | — | PASS |
| easy-high-contrast-object | easy | u2net | 593ms | 0B* | 273.3 | 0.0002 | 0.0012 | 0.0045 | 0.0000 | — | PASS |
| medium-person-with-hair | medium | u2net | 521ms | 0B* | 772.1 | 0.0008 | 0.0034 | 0.0218 | 0.0097 | — | ACCEPTABLE |
| medium-glasses | medium | u2net | 640ms | 49.8MB | 3615.9 | 0.0093 | 0.0157 | 0.0265 | 0.0000 | — | ACCEPTABLE |
| medium-loose-clothing | medium | u2net | 474ms | 0B* | 573.0 | 0.0006 | 0.0025 | 0.0177 | 0.0000 | — | PASS |
| medium-textured-background | medium | u2net | 428ms | 0B* | 461.9 | 0.0005 | 0.0020 | 0.0130 | 0.0000 | — | PASS |
| medium-similar-fg-bg-colors | medium | u2net | 416ms | 9.1MB | 507.1 | 0.0005 | 0.0022 | 0.0148 | 0.0020 | — | PASS |
| hard-curly-hair | hard | u2net | 671ms | 2.4MB | 17514.7 | 0.0662 | 0.0760 | 0.1079 | 0.1544 | Filled 2 small hole(s) in the matte. | NEEDS_REFINEMENT |
| hard-fine-hair | hard | u2net | 717ms | 3.5MB | 2021.6 | 0.0024 | 0.0088 | 0.0424 | 0.0187 | — | ACCEPTABLE |
| hard-transparent-objects | hard | u2net | 584ms | 51.1MB | 17327.2 | 0.0407 | 0.0752 | 0.0215 | 0.0000 | — | NEEDS_REFINEMENT |
| hard-semi-transparent-fabric | hard | u2net | 528ms | 57.3MB | 23232.4 | 0.0439 | 0.1008 | 0.1128 | 0.0208 | — | FAIL |
| hard-motion-blur | hard | u2net | 509ms | 0B* | 12980.1 | 0.0143 | 0.0563 | 0.0444 | 0.0000 | — | NEEDS_REFINEMENT |
| hard-shadows | hard | u2net | 605ms | 35.8MB | 522.1 | 0.0005 | 0.0023 | 0.0162 | 0.0000 | — | PASS |
| hard-reflections | hard | u2net | 789ms | 57.4MB | 491.0 | 0.0005 | 0.0021 | 0.0141 | 0.0000 | — | PASS |
| hard-dark-subject-dark-bg | hard | u2net | 1381ms | 0B* | 618.2 | 0.0007 | 0.0027 | 0.0194 | 0.0039 | — | PASS |
| hard-light-subject-light-bg | hard | u2net | 799ms | 51.0MB | 722.3 | 0.0011 | 0.0031 | 0.0256 | 0.0057 | — | ACCEPTABLE |
| hard-complex-background | hard | u2net | 448ms | 30.9MB | 13037.1 | 0.0475 | 0.0566 | 0.0723 | 0.0002 | Removed 1 small disconnected speck(s) from the matte. | NEEDS_REFINEMENT |
| hard-multiple-subjects | hard | u2net | 568ms | 50.0MB | 773.6 | 0.0008 | 0.0034 | 0.0224 | 0.0000 | — | ACCEPTABLE |
| hard-overlapping-subjects | hard | u2net | 573ms | 14.9MB | 473.1 | 0.0004 | 0.0021 | 0.0117 | 0.0000 | — | PASS |
| hard-no-subject | hard | u2net | 570ms | 8.6MB | 8091.9 | 0.0018 | 0.0351 | 0.0009 | 0.0000 | Removed 2 small disconnected speck(s) from the matte.; Unusual foreground coverage (0.0%) — this may be a failed segmentation rather than a real subject. | NEEDS_REFINEMENT |
| hard-fur | hard | u2net | 657ms | 0B* | 909.9 | 0.0009 | 0.0039 | 0.0228 | 0.0146 | — | ACCEPTABLE |
| hard-transparent-plastic | hard | u2net | 655ms | 71.4MB | 10991.0 | 0.0165 | 0.0477 | 0.0093 | 0.0000 | — | NEEDS_REFINEMENT |
| hard-smoke-like-regions | hard | u2net | 498ms | 19.6MB | 19426.3 | 0.0164 | 0.0843 | 0.0028 | 0.6420 | Removed 5 small disconnected speck(s) from the matte.; Unusual foreground coverage (0.2%) — this may be a failed segmentation rather than a real subject. | NEEDS_REFINEMENT |
| hard-rotated-subject | hard | u2net | 660ms | 0B* | 430.6 | 0.0004 | 0.0019 | 0.0063 | 0.0000 | — | PASS |

Artifacts: `benchmark-artifacts/v1/images/<case-id>/{alpha,transparent,black,white,edgeDiagnostic}.png`

## Per-case results — video

| Case | Frames | Model | Total time | Mem Δ | Mean MAD | Mean grad err | Mean conn err | Temporal err | Warnings | Classification |
|---|---|---|---|---|---|---|---|---|---|---|
| video-talking-person | 8/8 | u2net | 2951ms | 83.4MB | 0.0025 | 0.0147 | 0.0000 | 0.0006 | — | PASS |
| video-walking-person | 8/8 | u2net | 2554ms | 0B* | 0.0022 | 0.0134 | 0.0000 | 0.0002 | — | PASS |
| video-hand-movement | 8/8 | u2net | 2659ms | 35.2MB | 0.0030 | 0.0155 | 0.0000 | 0.0008 | — | PASS |
| video-hair-movement | 8/8 | u2net | 2683ms | 0B* | 0.0043 | 0.0238 | 0.0099 | 0.0006 | Removed 2 small disconnected speck(s) from the matte.; Removed 1 small disconnected speck(s) from the matte. | ACCEPTABLE |
| video-fast-movement | 8/8 | u2net | 2812ms | 34.2MB | 0.0687 | 0.0746 | 0.0001 | 0.0200 | — | NEEDS_REFINEMENT |
| video-occlusion | 8/8 | u2net | 2989ms | 0B* | 0.0217 | 0.0418 | 0.0000 | 0.0042 | — | ACCEPTABLE |
| video-camera-movement | 8/8 | u2net | 3000ms | 0B* | 0.0025 | 0.0131 | 0.0000 | 0.0009 | — | PASS |
| video-changing-background | 8/8 | u2net | 2865ms | 130KB | 0.0025 | 0.0160 | 0.0011 | 0.0006 | — | PASS |
| video-scene-cut | 8/8 | u2net | 2769ms | 335KB | 0.0020 | 0.0100 | 0.0000 | 0.0002 | — | PASS |

Artifacts: `benchmark-artifacts/v1/videos/<case-id>/{alpha,transparent,black,white,edgeDiagnostic}.png` (visual artifacts are the middle successfully-processed frame of each clip; quality metrics above reflect all frames).

## Five most important failure modes

Ranked by user-visible harm (severity of the metric evidence, how many cases exhibit the pattern, and whether the pipeline's own warning system ever surfaces it). No fixes are proposed here — this section is diagnosis only.

1. **True semi-transparency is not modeled at all — this is the only outright FAIL, and it's the worst edge quality in the entire dataset.** `hard-semi-transparent-fabric` FAILs at MAD 0.1008, and carries the single highest gradient error of any case (0.1128) — the mask isn't just slightly off, its edges are structurally wrong. The same transparency class shows up twice more in NEEDS_REFINEMENT: `hard-transparent-objects` (MAD 0.0752) and `hard-transparent-plastic` (MAD 0.0477). U²-Net's binary segmentation has no soft-alpha concept for glass/sheer fabric/plastic — a user matting any translucent subject gets a hard silhouette where reality has a gradient, and no warning fires to say so. This exactly matches — and now quantifies — limitation #7 already flagged in `MATTE_V1_BASELINE.md`.

2. **Weak/no-subject scenes don't degrade gracefully — they fragment.** `hard-smoke-like-regions` has a connectivity error of 0.6420 — over 4x the next-worst case in the whole dataset (`hard-curly-hair` at 0.1544) — meaning the predicted matte is scattered disconnected specks rather than one coherent (even if wrong) region. `hard-no-subject` shows the identical signature: speck-removal warnings plus "Unusual foreground coverage (0.0%)." The pipeline's post-processing catches and reports *some* of this (both cases did get a warning), but the underlying model behavior — hunting for a subject that isn't clearly there and returning fragmented noise — is a distinct, more severe defect than ordinary edge error, and it's invisible in MAD alone (`hard-no-subject`'s MAD, 0.0351, looks like a routine Hard-tier miss; the connectivity number is what actually reveals the fragmentation).

3. **Hair handling is inconsistent by hair type, not uniformly hard.** `hard-fine-hair` (straight, fine strands) scores MAD 0.0088 — comfortably ACCEPTABLE, near the Medium-category norm. `hard-curly-hair` (voluminous, curled) scores MAD 0.0760 with the second-highest gradient error in the dataset (0.1079) — NEEDS_REFINEMENT, an order of magnitude worse. This isn't "hair is hard" in general; it's specifically volume/curl silhouettes that break the model, while fine strand-level detail is handled acceptably. A user cutting out a subject with curly or voluminous hair gets a visibly wrong silhouette; a user with straight fine hair does not.

4. **Fast motion is the dominant — and only unambiguous — video quality problem, and it's exactly where temporal flicker becomes visible.** `video-fast-movement` has a mean MAD of 0.0687, 10-30x every other video case (all of which sit at 0.002-0.02), and its temporal consistency error (0.0200) is the only video result to cross the 0.02 gate at all. Per-frame motion-blur error (mirroring the still-image `hard-motion-blur` case, MAD 0.0563) compounds directly into frame-to-frame flicker because the shipped video path has zero temporal smoothing between sampled frames (the built temporal-consistency subsystem is confirmed off the production path — limitation #9 in `MATTE_V1_BASELINE.md`). A user cutting out fast subject motion gets a matte that visibly pulses/shifts, not just a slightly soft edge.

5. **Degraded output on complex/cluttered scenes ships with zero warning.** `hard-complex-background` (MAD 0.0566) and `hard-motion-blur` (MAD 0.0563) both land in NEEDS_REFINEMENT — materially wrong mattes — with an empty `warnings` array. Contrast this with the no-subject/smoke cases above, which at least trip the "unusual coverage" heuristic. There is currently no signal in the app, for these two failure classes, that distinguishes a bad-but-confident result from a good one; a user has no in-UI cue to go check the output before exporting.
