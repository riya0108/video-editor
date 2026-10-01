# Matte Changelog

## v1.2.0 — Diffuse/low-confidence edge band warning

Fixes one specific failure, selected via the process below. No matting algorithm (model selection, refinement, decontamination, compositing) was touched — this change is additive to `warnings` only.

### Which failure, and why not the literal #1-ranked one

Both `MATTE_V1_BENCHMARK_REPORT.md` ("five most important failure modes," ranked by severity) and `MATTE_FEATURE_GAP_ANALYSIS.md` ("five highest-impact gaps") rank the same item #1: the complete absence of a working soft-alpha matting model, responsible for the dataset's only FAIL case (`hard-semi-transparent-fabric`, MAD 0.1008). That failure was evaluated first and is **not** what this change fixes: `MATTE_V1.1_FIXES.md` already documents a prior, measured attempt (trimap-band feathering) that moved this case's MAD by under 1% (0.1008 → 0.1001), because the error lives in the subject's *interior*, not its edge — no post-processing signal can reach it. A real fix needs a different bundled model (MODNet/BackgroundMattingV2 adapters exist in the codebase but have no weight files — see `MODEL_LICENSES.md`), which is out of scope for a smallest-appropriate-change fix and would just repeat an already-falsified approach.

The next-highest-impact failure both documents independently agree on is benchmark failure mode #5 / gap-analysis item #2: **`hard-complex-background` (MAD 0.0566) and `hard-motion-blur` (MAD 0.0563) — both NEEDS_REFINEMENT-tier, materially wrong mattes — ship with no useful warning.** This is what this change fixes.

The gap analysis's own proposed "cheap fix" for this (wire the pre-built `MatteQualityEngine`) was checked by actually running it against all 25 real benchmark cases before writing any code, and rejected: `contaminationScore` saturates to `1.0` (max severity) on 22 of 25 cases including the cleanest case in the dataset (`easy-person-plain-bg`), and `overallQuality` scores `hard-complex-background` *higher* than several genuine PASS cases. Wiring it in would have made this worse, not better.

### Root cause

The only production low-confidence signal (`computeConfidence` in `quality-metrics.ts`) is driven almost entirely by `alphaHistogramBimodality` — how decisively the *whole frame* split into near-0/near-1 values, dominated by the large uniform interior. Measured directly: `hard-complex-background` scores confidence 0.9616 and `hard-motion-blur` scores 0.9832 — both comfortably above the existing `< 0.4` warning threshold. The model is *confidently* wrong on these two cases, not uncertain, so a whole-frame bimodality metric structurally cannot see a boundary-only problem.

### The fix

One new, additive warning condition in `removeBackgroundFromImage` (`src/lib/matting/pipeline/remove-background.ts`), using two metrics the pipeline already computes every call at zero extra cost (`softEdgeFraction`, `edgeGradientEnergy` from `quality-metrics.ts`):

```
qualityMetrics.softEdgeFraction > 0.45 && qualityMetrics.edgeGradientEnergy < 0.22
```

i.e. a boundary that is both unusually wide/diffuse *and* carries unusually low gradient definition — the signature of a low-confidence, spread-out transition, as opposed to either a clean hard edge or a deliberate soft edge (real hair/fur).

Both thresholds were derived by running the real, unmodified production pipeline against the full 34-case quality-benchmark dataset (25 image cases + 9 video cases × 8 frames = 72 video frames) **before** picking the final values — not reverse-engineered from the two target cases alone. See `src/lib/matting/pipeline/remove-background.ts`'s own comment above the constants for the full calibration rationale.

### Files changed

- `src/lib/matting/pipeline/remove-background.ts` — two new constants (`DIFFUSE_EDGE_SOFT_FRACTION_THRESHOLD`, `DIFFUSE_EDGE_GRADIENT_ENERGY_THRESHOLD`) and one new warning branch in the existing quality-analysis section. No change to model selection, refinement, decontamination, or the returned `alpha`/`foreground` data.
- `src/lib/matting/pipeline/remove-background.adversarial.test.ts` — two new targeted unit tests using synthetic alpha arrays (a full-width linear ramp vs. a single hard step), not benchmark fixtures.

### Regression risks (measured, not assumed)

Checked against the complete 34-case dataset before and after:

- **Zero PASS-tier cases fire the new warning** (checked all 25 image cases individually).
- **2 of 25 image cases are false positives** in the sense of firing on an ACCEPTABLE (not PASS) case: `hard-fine-hair` (MAD 0.0088) and `hard-fur` (MAD 0.0039). Both have genuinely soft hair/fur edges and are already imperfect by gradient-error (that's why they're ACCEPTABLE, not PASS) — a gently-worded advisory there is a defensible trade-off, not a regression of a clean result.
- **Correctly fires on both targets** (`hard-complex-background`, `hard-motion-blur`), plus `hard-curly-hair` (also genuinely NEEDS_REFINEMENT — a bonus catch), plus **7 of 8 `video-fast-movement` frames** (the dominant, and previously completely unflagged, video failure mode — benchmark failure #4), plus it caught a genuine severe transient failure inside `video-occlusion` frame 5 (MAD 0.153, worse than the FAIL threshold) that the case's averaged 0.0217 mean-MAD score alone hides.
- **Deliberately does not fire** on `hard-semi-transparent-fabric` / `hard-transparent-plastic` / `hard-transparent-objects` — a structurally different failure (error in the subject's interior, not a diffuse boundary) already diagnosed in `MATTE_V1.1_FIXES.md` as unfixable by any post-processing signal. Conflating the two failure classes under one warning would misdescribe what's actually wrong.
- **Zero false positives across all 7 other video cases** (`video-talking-person`, `video-walking-person`, `video-hand-movement`, `video-hair-movement`, `video-camera-movement`, `video-changing-background`, `video-scene-cut`) — including `video-hair-movement`, which has legitimately soft hair edges.
- Purely additive to `warnings` — **every MAD/gradient-error/connectivity-error/classification value across all 34 cases is byte-identical before and after** (verified programmatically below), so there is zero risk to actual matte quality, exports, or any existing test.

### Validation performed

1. **Targeted unit tests**: 2 new tests in `remove-background.adversarial.test.ts` (synthetic diffuse-edge vs. clean-edge alpha) — both pass.
2. **Full regression suite**: `vitest run` — 457/457 tests pass (455 pre-existing + 2 new), 0 failures.
3. **Type check**: `astro check` — 0 errors (pre-existing warnings unrelated to this change).
4. **Affected benchmark categories re-run live** (chrome-devtools-mcp, same methodology as `MATTE_V1_BENCHMARK_REPORT.md`): all 25 image cases + all 9 video cases (72 frames) re-run through the real pipeline.
5. **Compared against baseline** (`benchmark-artifacts/v1.1-final/raw/{images,videos}.json`, the current shipped state per `MATTE_V1.1_FINAL_VERIFICATION.md`): 0 of 25 image-case MAD values changed by more than floating-point noise; 0 classification changes (12 PASS / 6 ACCEPTABLE / 6 NEEDS_REFINEMENT / 1 FAIL, identical before and after); all 9 video cases' mean-MAD and temporal-consistency-error values unchanged.
6. **Unrelated categories checked for regression**: Easy (3/3 PASS, unchanged), Medium (3 PASS + 3 ACCEPTABLE, unchanged) — zero cases outside the Hard/video tiers triggered the new warning at all.

### Remaining issues (explicitly out of scope for this change)

- **True semi-transparency (glass, sheer fabric, smoke) is still not modeled** — the actual #1-ranked failure in both source documents. Needs a real bundled soft-alpha matting model; no post-processing fix is possible (confirmed twice now, independently).
- **`hard-transparent-plastic` / `hard-transparent-objects`** (same root cause as above) still ship with no warning — this fix's edge-diffuseness signature does not, and should not, try to cover an interior-transparency failure.
- **`hard-fine-hair` / `hard-fur`** now carry an advisory warning despite being decent (ACCEPTABLE-tier) results — an accepted, measured trade-off, not a defect, but worth knowing if a future pass wants to narrow the condition further (e.g. by combining it with a hair-candidate-density check to distinguish "legitimately furry" from "diffuse and uncertain").
- **`video-fast-movement` frame 2 of 8** sits just under the threshold and doesn't fire — 7/8 frames in that clip do, so the clip-level warning set still surfaces it, but the per-frame coverage isn't 100%.
- The broader gap-analysis findings (hair refinement, true video temporal consistency/occlusion handling, the fully-built-but-miscalibrated `MatteQualityEngine`) remain untouched, as instructed.
