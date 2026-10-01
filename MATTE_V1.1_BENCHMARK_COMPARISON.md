# Matte v1.1 fixes — benchmark comparison against v1.0.0

Generated against the same 34-case permanent synthetic dataset as `MATTE_V1_BENCHMARK_REPORT.md`, same classification thresholds, same method (chrome-devtools-mcp against `localhost:4322/tools/video/matte-quality-benchmark`, dynamically importing the real production modules — no source file was modified to produce this report). Raw data: `benchmark-artifacts/v1.1/raw/{images,videos}.json`.

## Headline result: net regression, not a net improvement

| Classification | v1.0.0 | v1.1 | Δ |
|---|---|---|---|
| PASS | 17 | 13 | **-4** |
| ACCEPTABLE | 8 | 12 | **+4** |
| NEEDS_REFINEMENT | 8 | 8 | 0 |
| FAIL | 1 | 1 | 0 |

**6 cases regressed to a worse classification. Zero cases improved to a better classification.** The one intended-to-improve case (`hard-curly-hair`) did not measurably improve. Two of the five fixes (hard-edge warning, fragmentation warning) are shown below to be either inert or miscalibrated against the primary case they were built for.

## Regressions (PASS/ACCEPTABLE → worse), all real, none adjusted

| Case | v1.0.0 | v1.1 | MAD before → after | Conn. err before → after |
|---|---|---|---|---|
| `medium-loose-clothing` | PASS | ACCEPTABLE | 0.0025 → 0.0030 | 0.0000 → 0.0000 |
| `hard-shadows` | PASS | ACCEPTABLE | 0.0023 → 0.0028 | 0.0000 → 0.0000 |
| `hard-reflections` | PASS | ACCEPTABLE | 0.0021 → 0.0027 | 0.0000 → 0.0000 |
| `hard-dark-subject-dark-bg` | PASS | ACCEPTABLE | 0.0027 → 0.0032 | 0.0039 → 0.0043 |
| `hard-fur` | ACCEPTABLE | NEEDS_REFINEMENT | 0.0039 → 0.0045 | **0.0146 → 0.1901 (13x)** |
| `video-hand-movement` | PASS | ACCEPTABLE | 0.0030 → 0.0035 | — |

Every other case shows the same small, consistent MAD increase (+0.0004 to +0.0006) across **every single image case regardless of category** — easy, medium, hard, hair, transparency, all of it. That uniformity points at `FEATHER_RADIUS=2` (applied to literally every case's Unknown band) as the dominant cause, not the hair engine specifically — feathering a synthetic dataset whose ground truth is mostly near-binary by construction trades a small amount of accuracy everywhere for softness that mostly isn't needed. `hard-fur`'s 13x connectivity blowup is the one clearly attributable to something else — see below.

**No FAIL got worse.** `hard-semi-transparent-fabric` stayed FAIL (0.1008 → 0.1001 — moved in the right direction but by essentially nothing, still over the 0.10 line).

## Why: the hair-refinement gate fires on literally every image, not just hair

Directly measured (calling `detectHairCandidates` the same way the gate does, against 5 real cases at real 480×480 dataset resolution):

| Case | sourceSharpness | candidate pixels | gate (`>0 && >=20`) fires? |
|---|---|---|---|
| `hard-curly-hair` | 16.6 | 17,445 | yes |
| `hard-fine-hair` | 11.9 | 15,255 | yes |
| `hard-fur` | 6.5 | 12,356 | yes |
| `easy-person-plain-bg` | 7.4 | 6,206 | **yes** |
| `medium-loose-clothing` | 8.9 | 7,361 | **yes** |

`HAIR_CANDIDATE_MIN_PIXELS=20` was sized against the 64×64 adversarial test fixtures (where a plain edge produced 256-400 candidates) and is off by roughly 2-3 orders of magnitude at the dataset's real 480×480 scale — a plain product-shot silhouette produces 6,000+ candidate pixels just from its ordinary boundary. **The gate is not selective at all in practice; `HairRefinementEngine` now runs on every image.** That's consistent with the across-the-board MAD drift above, and explains why `hard-curly-hair` (the actual target case) shows no real change (0.0760 → 0.0764) — it's getting the exact same treatment as everything else, not extra targeted help. `hard-fur`'s connectivity explosion (0.0146 → 0.1901) is the clearest evidence of real harm: fine-detail refinement fragmenting what was previously one coherent fur region.

## The "hard/binary edge" warning (Fix 1b) never fires — and the feather fix undermines its own detector

It fired on **0 of 25 image cases**, including the FAIL case it was built for:

| Case | softEdgeFraction | edgeGradientEnergy | Threshold |
|---|---|---|---|
| `hard-semi-transparent-fabric` (FAIL) | 0.336 | 0.249 | need <0.15 and >0.3 |
| `hard-transparent-objects` | 0.449 | 0.208 | |
| `hard-transparent-plastic` | 0.459 | 0.220 | |
| `easy-person-plain-bg` (PASS) | 0.477 | 0.235 | |
| `medium-loose-clothing` (PASS) | 0.507 | 0.251 | |

The transparency-class case and an ordinary PASS case are now **nearly indistinguishable** on both metrics. This is a direct, mechanical side effect of Fix 1a: feathering the Unknown band on every case pushes `softEdgeFraction` up broadly (there's now a wider soft transition everywhere, real transparency or not), which erases exactly the "almost entirely hard-thresholded" signature Fix 1b was designed to detect. **The two halves of Fix 1 work against each other** — as implemented, 1a's blanket feather masks 1b's detector.

## The "blurry" warning (Fix 5) fires on 20 of 25 image cases (80%)

Including `easy-person-plain-bg`, `easy-product-plain-bg`, `easy-high-contrast-object` — the three cleanest, sharpest cases in the whole dataset. `SOURCE_BLUR_SHARPNESS_MAX=8` is far too high for `computeSourceSharpness`'s actual scale (a mean over the WHOLE frame including large flat interior regions, unlike `edgeGradientEnergy`'s boundary-only mean) — as implemented, this warning is closer to noise than signal.

## The fragmentation warning (Fix 2a) fires on the wrong cases, not its target case

It did **not** fire on `hard-smoke-like-regions` (the case it was designed for) — `connectivityError` there is still 0.6405 (essentially unchanged from v1.0.0's 0.6420), but the new noise-floor fix (2b) already suppressed most of the diffuse smoke signal down to a near-empty result (coverage 0.12%) before the component count was ever measured, so too few components survive to cross `FRAGMENTED_COMPONENT_COUNT_MIN=5`. Instead, the warning fires on `medium-person-with-hair` (7 regions) and `hard-fine-hair` (26 regions) — two cases whose classification is ACCEPTABLE, not fragmented failures; ordinary hair edge softness alone crosses this threshold.

Separately, 2a and 2b measure genuinely different things: `connectivityError` (GT-alignment of the largest region) stayed catastrophic for `hard-smoke-like-regions` while the matte's own internal fragmentation (what 2a counts) dropped — meaning the prediction became a small, oddly-placed blob rather than a scattered speckle field. This is a real behavior change, but "confidently wrong in one place" isn't obviously better than "scattered but present," and for a genuine smoke/mist subject this floor may now be deleting real signal a user wanted.

## Video results

| Case | v1.0.0 MAD | v1.1 MAD | v1.0.0 temporal err | v1.1 temporal err | Classification change |
|---|---|---|---|---|---|
| `video-fast-movement` | 0.0687 | 0.0683 | 0.0200 | **0.0200 (unchanged)** | none (stays NEEDS_REFINEMENT) |
| `video-scene-cut` | 0.0020 | 0.0024 | 0.0002 | 0.0002 | none (stays PASS — not smeared) |
| `video-hand-movement` | 0.0030 | 0.0035 | — | — | **PASS → ACCEPTABLE** |
| `video-hair-movement` | 0.0043 | 0.0050 | 0.0006 | 0.0007 | none (stays ACCEPTABLE) |

**The temporal-smoothing fix (Fix 4) produced zero measurable improvement on the exact case it targeted.** `video-fast-movement`'s `temporalConsistencyError` is bit-for-bit unchanged (0.0200 both runs). The likely mechanism: the motion-weighted blend deliberately drops its smoothing weight toward 0 as local RGB motion increases (by design, to avoid smearing real movement) — but "fast movement" is, by definition, exactly the high-local-motion condition, so the blend weight collapses to near-zero precisely where this fix needed to act. The formula can't distinguish "real fast subject motion" from "flicker artifact co-located with real fast motion" — both look like high local motion to it. `video-scene-cut` correctly stayed unsmeared (the one thing this fix reliably achieves), and `video-hair-movement` picked up 8 fragmentation warnings (one per frame, same false-positive pattern as the image case above).

## Processing time

No case shows a clear, attributable slowdown — all 25 image cases actually got FASTER in this run (up to -916ms on `hard-dark-subject-dark-bg`), which is browser JIT/cache warm-up noise between runs dominating any real added cost from the new passes, not a signal either way. Timing is not a useful verification axis with this measurement method; a controlled back-to-back A/B on the same warm session would be needed to isolate the real per-pass cost.

## Bottom line

Of the 5 fixes: the no-subject noise floor (2b) is the one clear, unambiguous win (`hard-no-subject` NEEDS_REFINEMENT → PASS, MAD 0.0351 → 0.0021). Every other fix, as currently calibrated, is either inert (hard-edge warning, temporal smoothing) or net-negative (hair-refinement gate, feather, fragmentation warning firing on the wrong cases) against this benchmark. The overall PASS count dropped from 17 to 13 with zero offsetting improvements.
