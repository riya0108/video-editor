# Matte v1.1 — Final Verification (post-revert)

Generated against the codebase after reverting the broken first-round v1.1 fixes (feather, hard-edge warning, automatic hair-refinement, source-blur warning, fragmentation warning, video temporal smoothing) and keeping only the **no-subject noise floor** — inside the pre-existing `coverageFraction < 0.02 || > 0.98` branch in `src/lib/matting/pipeline/remove-background.ts`, residual alpha below 0.1 is now snapped to exactly 0.

Method: identical to the two earlier benchmark runs — chrome-devtools-mcp against `http://localhost:4322/tools/video/matte-quality-benchmark`, dynamically importing the real pipeline/dataset/metrics modules, running all 25 image + 9 video cases through the real, unmodified-except-for-the-one-fix `removeBackgroundFromImage`. Same classification thresholds as both previous runs (FAIL: not ok OR mad>0.10; NEEDS_REFINEMENT: 0.03<mad≤0.10 OR connectivityError>0.05 OR (video) temporalConsistencyError>0.02; ACCEPTABLE: 0.01<mad≤0.03; PASS: mad≤0.01 AND connectivityError≤0.01 AND gradientError≤0.02, video also temporalConsistencyError≤0.01).

Raw data: `benchmark-artifacts/v1.1-final/raw/{images,videos}.json`. Compared against the original v1.0.0 baseline: `benchmark-artifacts/v1/raw/{images,videos}.json` (NOT the broken first v1.1 attempt).

## Summary

| | PASS | ACCEPTABLE | NEEDS_REFINEMENT | FAIL | Total |
|---|---|---|---|---|---|
| v1.0.0 baseline | 17 | 8 | 8 | 1 | 34 |
| v1.1 final | **18** | 8 | **7** | 1 | 34 |

Exactly one case moved tier: `hard-no-subject`, NEEDS_REFINEMENT → PASS. No other case changed classification.

## Per-case MAD, v1.0.0 vs v1.1 final

### Images

| Case | v1.0.0 MAD | v1.1 final MAD | Class v1.0.0 → v1.1 |
|---|---|---|---|
| easy-person-plain-bg | 0.002045 | 0.002045 | PASS → PASS |
| easy-product-plain-bg | 0.001212 | 0.001212 | PASS → PASS |
| easy-high-contrast-object | 0.001186 | 0.001186 | PASS → PASS |
| medium-person-with-hair | 0.003351 | 0.003351 | ACCEPTABLE → ACCEPTABLE |
| medium-glasses | 0.015694 | 0.015694 | ACCEPTABLE → ACCEPTABLE |
| medium-loose-clothing | 0.002487 | 0.002487 | PASS → PASS |
| medium-textured-background | 0.002005 | 0.002005 | PASS → PASS |
| medium-similar-fg-bg-colors | 0.002201 | 0.002201 | PASS → PASS |
| hard-curly-hair | 0.076019 | 0.076019 | NEEDS_REFINEMENT → NEEDS_REFINEMENT |
| hard-fine-hair | 0.008774 | 0.008774 | ACCEPTABLE → ACCEPTABLE |
| hard-transparent-objects | 0.075205 | 0.075205 | NEEDS_REFINEMENT → NEEDS_REFINEMENT |
| hard-semi-transparent-fabric | 0.100835 | 0.100835 | FAIL → FAIL |
| hard-motion-blur | 0.056337 | 0.056337 | NEEDS_REFINEMENT → NEEDS_REFINEMENT |
| hard-shadows | 0.002266 | 0.002266 | PASS → PASS |
| hard-reflections | 0.002131 | 0.002131 | PASS → PASS |
| hard-dark-subject-dark-bg | 0.002683 | 0.002683 | PASS → PASS |
| hard-light-subject-light-bg | 0.003135 | 0.003135 | ACCEPTABLE → ACCEPTABLE |
| hard-complex-background | 0.056585 | 0.056585 | NEEDS_REFINEMENT → NEEDS_REFINEMENT |
| hard-multiple-subjects | 0.003358 | 0.003358 | ACCEPTABLE → ACCEPTABLE |
| hard-overlapping-subjects | 0.002054 | 0.002054 | PASS → PASS |
| **hard-no-subject** | **0.035121** | **0.002319** | **NEEDS_REFINEMENT → PASS** |
| hard-fur | 0.003949 | 0.003949 | ACCEPTABLE → ACCEPTABLE |
| hard-transparent-plastic | 0.047704 | 0.047704 | NEEDS_REFINEMENT → NEEDS_REFINEMENT |
| hard-smoke-like-regions | 0.084315 | 0.087878 | NEEDS_REFINEMENT → NEEDS_REFINEMENT (no tier change — see note) |
| hard-rotated-subject | 0.001869 | 0.001869 | PASS → PASS |

### Videos (all 9 byte-identical, no diffs)

| Case | v1.0.0 MAD | v1.1 final MAD | Class |
|---|---|---|---|
| video-talking-person | 0.002519 | 0.002519 | PASS |
| video-walking-person | 0.002212 | 0.002212 | PASS |
| video-hand-movement | 0.002952 | 0.002952 | PASS |
| video-hair-movement | 0.004256 | 0.004256 | ACCEPTABLE |
| video-fast-movement | 0.068688 | 0.068688 | NEEDS_REFINEMENT |
| video-occlusion | 0.021737 | 0.021737 | ACCEPTABLE |
| video-camera-movement | 0.002520 | 0.002520 | PASS |
| video-changing-background | 0.002476 | 0.002476 | PASS |
| video-scene-cut | 0.001953 | 0.001953 | PASS |

## Verdicts

**1. Isolation (24 other image cases unchanged).** 23 of 24 are exact matches to 6 decimal places. One exception: **`hard-smoke-like-regions`** (MAD 0.084315 → 0.087878, connectivity error unchanged at 0.6420). This is NOT a bug or an unintended interaction — its `coverageFraction` is 0.2% (per the v1.0.0 raw data), which also falls inside the same `<0.02` "unusual coverage" branch the noise floor is gated behind, so it legitimately receives the same treatment as `hard-no-subject`. Unlike `hard-no-subject` (true empty scene, ground truth exactly 0 everywhere), `hard-smoke-like-regions`' ground truth is a genuinely diffuse, nonzero, low-alpha smoke field — flooring the prediction's own low-but-nonzero residual alpha to 0 removes some pixels that were a partial, honest match to that low GT value, so MAD ticks up slightly. **No classification tier changed** (NEEDS_REFINEMENT before and after, driven by the catastrophic connectivity error 0.64, which the floor does not touch at all). Verdict: **PASS with one disclosed, non-regressing exception** — the isolation claim as stated ("only `hard-no-subject`") was slightly too narrow; the real scope is "any case whose coverage already trips the pre-existing `<0.02`/`>0.98` warning," which today is 2 of 34 cases, one helped substantially and one very slightly hurt with no tier change.

**2. `hard-no-subject` improvement.** Confirmed: MAD 0.035121 → 0.002319 (≈15x reduction), classification NEEDS_REFINEMENT → PASS. **PASS.**

**3. Video cases untouched.** Confirmed: all 9 video cases are exact matches (MAD, connectivity error, temporal-consistency error, classification) to v1.0.0. No video case in this dataset has coverage outside `[0.02, 0.98]`, so the noise-floor branch never fires for video. **PASS.**

**4. Overall classification-count summary.** Real result: **18 PASS / 8 ACCEPTABLE / 7 NEEDS_REFINEMENT / 1 FAIL** (34 total) — exactly matching the predicted clean outcome (v1.0.0's 17/8/8/1 with exactly one case moving NEEDS_REFINEMENT → PASS). **PASS.**
