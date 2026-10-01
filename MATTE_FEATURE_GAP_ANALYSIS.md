# Matte Feature Gap Analysis

Audit-only document. Compares the current matting subsystem (`src/lib/matting/**`, `RemoveBackgroundTool.tsx`, `RefineMattePanel.tsx`) against 25 capabilities found in professional background-removal/matting workflows. **Nothing was implemented or changed as part of this audit.**

Evidence is drawn from reading the current source tree directly plus the repo's own benchmark/post-mortem documents: `MATTE_V1_BENCHMARK_REPORT.md` (34-case baseline), `MATTE_V1.1_FINAL_VERIFICATION.md` / `MATTE_V1.1_BENCHMARK_COMPARISON.md` (the v1.1 fix cycle), `MATTE_V1.1_FIXES.md` (what shipped vs. was reverted, and why), and `MATTE_PRODUCTION_READINESS_REPORT.md`.

A recurring pattern across this audit: a feature is frequently **built, unit-tested, and genuinely correct in isolation — but never called by the production pipeline (`remove-background.ts`) or exposed in the real UI.** That distinction is called out explicitly wherever it applies, and is the reason so many items below are PARTIAL rather than a clean IMPLEMENTED/MISSING split.

---

## Summary table

| # | Capability | Verdict |
|---|---|---|
| 1 | Subject detection | PARTIAL |
| 2 | Initial segmentation | IMPLEMENTED |
| 3 | Alpha matting | PARTIAL |
| 4 | Edge refinement | IMPLEMENTED |
| 5 | Anti-aliasing | IMPLEMENTED |
| 6 | Feather | PARTIAL |
| 7 | Smooth | IMPLEMENTED |
| 8 | Contrast | PARTIAL |
| 9 | Shift edge | PARTIAL |
| 10 | Hair refinement | PARTIAL |
| 11 | Fine-detail preservation | PARTIAL |
| 12 | Colour decontamination | IMPLEMENTED |
| 13 | Manual foreground refinement | IMPLEMENTED |
| 14 | Manual background refinement | IMPLEMENTED |
| 15 | Local edge refinement | IMPLEMENTED |
| 16 | Non-destructive masking | IMPLEMENTED |
| 17 | Preview backgrounds | IMPLEMENTED |
| 18 | Transparent export | IMPLEMENTED |
| 19 | Video temporal consistency | PARTIAL |
| 20 | Motion blur handling | MISSING |
| 21 | Occlusion handling | PARTIAL |
| 22 | Low-confidence detection | PARTIAL |
| 23 | Undo/redo | IMPLEMENTED |
| 24 | Local recomputation | PARTIAL |
| 25 | Quality diagnostics | PARTIAL |

**13 IMPLEMENTED · 11 PARTIAL · 1 MISSING · 0 UNKNOWN**

---

## 1. Subject detection — PARTIAL

The *interface* for subject-aware routing is fully built — `SubjectKind`, `media-analysis.ts`'s `analyzeMedia()`, and `router.ts`'s model-scoring logic all accept and consume a subject hint. But nothing ever produces a real one: `media-analysis.ts`'s own doc comment states "this app doesn't pretend to detect the subject on its own yet," and `analyzeMedia()` always returns `subjectHint: "unknown"` unless a caller explicitly supplies one — which no production caller does (`registry.ts`). **There is no actual pixel-based subject classifier anywhere in the codebase.** Routing logic that would benefit from a real hint is sitting idle.

## 2. Initial segmentation — IMPLEMENTED

Solid and production-wired. `remove-background.ts` tries each ranked model's `inferImage()` in order; two of the four registered adapters are real, functional, and ship with bundled weights (`U2NetAdapter`, `SelfieSegmenterAdapter` — `registry.ts`). This is the one foundational category with no caveats.

## 3. Alpha matting — PARTIAL (headline structural gap)

Of the 4 registered models, only `RvmAdapter` is tagged `modelClass: "matting"` — and it's a deliberate non-functional placeholder (GPL-3.0 licensing issue; `load()` always throws; `rvm.ts`'s own comment: "do not 'complete' this adapter"). `ModNetAdapter`/`BackgroundMattingV2Adapter` are also matting-class but were never registered — no bundled weight files exist for either. `RmbgAdapter` is segmentation-class and additionally excluded by default (`commercialUse: false`, and no production call site ever sets `allowNonCommercial: true`, including the benchmark runner itself).

**Net effect: every real request, and the entire 34-case benchmark suite, is served exclusively by segmentation-class models.** There is no genuine learned soft-alpha matting network anywhere in the reachable path — "alpha matting" in this app means trimap + post-hoc smoothing over a near-binary segmentation mask, not a trained soft-alpha model. `MATTE_V1.1_FIXES.md` independently reaches the same conclusion: "U²-Net's binary segmentation has no soft-alpha concept," identified as the root cause of two of the five diagnosed v1.0.0 failure modes.

## 4. Edge refinement — IMPLEMENTED

Production-wired and unconditional. `refine/pipeline.ts`'s `refineAlphaMatte()` — called from `remove-background.ts` — runs trimap construction → fine-detail masking → cleanup → smoothing → local edge-band refinement on every request.

## 5. Anti-aliasing — IMPLEMENTED

`antiAliasAlpha()` runs unconditionally inside `refineAlphaMatte()`. No caveats.

## 6. Feather — PARTIAL

A global `featherAlpha()` exists and is wired as an optional step in the refine pipeline — but it defaults to `radius: 0` (a no-op), and `remove-background.ts` never overrides it. It has no caller, no UI control, and no effect on any production output. A *separate*, genuinely-used per-brush feather slider (0–20) exists in the manual-refinement UI (`RefineMattePanel.tsx`) — real, but local/manual-only, not the global automatic pass a professional tool's "feather" setting usually means.

## 7. Smooth — IMPLEMENTED

`smoothAlpha()` runs unconditionally and is actively tuned — `remove-background.ts` picks its radius by model class (segmentation vs. matting), based on a measured halo-pixel reduction (21,984 → 12,672 pixels on the tuning case). The one capability in this section that's not just wired but measurably calibrated.

## 8. Contrast — PARTIAL

`applyAlphaContrast()` exists and is wired as an optional pipeline step, same pattern as feather: default `amount: 0`, never overridden by any production caller or UI control. Engine-only.

## 9. Shift edge — PARTIAL

Both halves of what a professional tool calls "shift edge" exist: `shiftEdgeAlpha()` (additive bias remap) and `contractExpandAlpha()` (choke/grow). Both are wired as optional steps in `refine/pipeline.ts`. Both default to no-op and are never overridden by any production caller or exposed UI control. Engine-only, fully untested by any real user path.

## 10. Hair refinement — PARTIAL

`HairRefinementEngine` is explicitly documented as not wired into the default pipeline — reachable only via a manual "Enhance fine hair detail" button in `RefineMattePanel.tsx`, which discards any prior manual edits when clicked (not composable with other manual work). This is not merely a wiring gap: an attempt to auto-wire it into production was tried and reverted (`MATTE_V1.1_FIXES.md`) after measurement showed it provided **zero benefit on its own target case** (`hard-curly-hair` MAD 0.0760 → 0.0764, marginally worse) while **spiking `hard-fur`'s connectivity error 13x** (0.0146 → 0.1901) and regressing several previously-PASS cases. The underlying algorithmic problem — hair-type inconsistency across curly/voluminous vs. fine/straight hair — remains genuinely unsolved, not just unexposed.

## 11. Fine-detail preservation — PARTIAL

`buildFineDetailMask()` runs unconditionally in production and feeds island-preservation during cleanup — a real, always-on baseline protection. But the deeper, more capable `fine-detail-refiner.ts` local-refinement pass only runs inside `HairRefinementEngine`, i.e. the same manual-button-only gap as #10.

## 12. Colour decontamination — IMPLEMENTED

`pipeline/decontaminate.ts` (closed-form unmixing with confidence-based suppression) runs unconditionally in production — a real, principled fix rather than a cosmetic one. A second, richer `ColourDecontaminationEngine` exists for manual use ("Reduce background color spill" button) with the same discard-prior-edits caveat as hair refinement, but the automatic baseline is solid.

## 13. Manual foreground refinement — IMPLEMENTED

"Add" brush → `BrushMode.Foreground` pushes touched pixels toward opaque, wired end-to-end: `RefineMattePanel.tsx` → `useMatteRefinement.paintStroke` → `ManualRefinementEngine.applyStroke`. *Scope caveat (applies to 13–18, 23, 24 below): this entire manual-refinement UI only renders when `mode === "ai" && kind === "image"` in `RemoveBackgroundTool.tsx`. Video and chroma-key mode skip straight to export — none of it is reachable there.*

## 14. Manual background refinement — IMPLEMENTED

"Remove" brush → `BrushMode.Background`, same wiring and same scope caveat as #13.

## 15. Local edge refinement — IMPLEMENTED

The "Refine edge" advanced brush runs a real guided-filter pass scoped strictly to the stroke's bounding box (+3px padding) — genuinely local, not a full-image reprocess.

## 16. Non-destructive masking — IMPLEMENTED

`ManualRefinementEngine`'s `baseAlpha` is defensively copied on construction and never mutated by any method; edits live in a sparse overlay composited on read (`getEffectiveAlpha()`); `getBaseAlpha()` always returns the untouched AI output; a `Restore` brush mode discards the override exactly, with no approximation loss.

## 17. Preview backgrounds — IMPLEMENTED

9 preview modes (Checkerboard/Black/White/Original/Gray/High-Contrast Diagnostic/Matte-Only/Alpha Visualization and more) via `MattePreviewEngine.render()` — 4 always visible, the rest under an "Advanced" disclosure in `RefineMattePanel.tsx`.

## 18. Transparent export — IMPLEMENTED

`compositeTransparentForeground()` bakes real per-pixel alpha into a fresh canvas without mutating the source. Confirmed live in-browser (this session and a prior one): PNG/WebP/TIFF export with real transparency, reachable from the AI/image path's export controls.

## 19. Video temporal consistency — PARTIAL

A genuinely sophisticated engine exists — `TemporalMattingEngine`: motion-aware smoothing with a blend weight derived from measured per-pixel RGB delta, scene-cut detection with automatic state reset, full streaming/chunked/resumable session orchestration (`video-matting-session.ts`). **It is completely unreachable from production** — a repo-wide import grep shows zero production callers, only its own tests and barrel file. The real video path (`pipeline/video-cutout.ts`) calls `removeBackgroundFromImage` independently per sparse-sampled frame with no cross-frame state at all; its own doc comment confirms this is intentional ("doesn't replace" the independent sampling). `matte-quality-engine.ts`'s doc comment separately confirms the gap. Benchmark evidence (`MATTE_V1_BENCHMARK_REPORT.md`): `video-fast-movement` temporalConsistencyError = **0.0200** — the only video case to cross the NEEDS_REFINEMENT gate — while `video-scene-cut` = 0.0002 (PASS, a non-issue in production precisely because nothing is smoothed across the cut in the first place). A separate, lighter-weight attempt at EMA temporal smoothing directly in the production path was tried and reverted after measuring **zero improvement** on the target case (`MATTE_V1.1_FIXES.md`).

## 20. Motion blur handling — MISSING

No special handling exists anywhere in the live pipeline for motion-blurred frames — each sampled frame receives the same per-frame inference as any other. A `MotionBlur` edge-category *classifier* exists (`classical-edge-classifier.ts`, feeding `edge-analysis-engine.ts`), but it's part of the same unwired `MatteQualityEngine` as #22/#25 below — not reachable from production. The still-image benchmark case `hard-motion-blur` scores MAD 0.0563 (NEEDS_REFINEMENT) **with an empty warnings array** (`MATTE_V1_BENCHMARK_REPORT.md`). No detection surfaced to the user, no mitigation applied — this is the one category with no redeeming "built but unwired" nuance; the capability simply does not exist end-to-end.

## 21. Occlusion handling — PARTIAL

`TemporalMattingEngine` implements a real occlusion "hold": a sudden, large, localized alpha drop on a pixel with sustained prior opacity is held back for up to 4 frames before being trusted, with dedicated unit tests. Same dead-code status as #19 — zero production reachability. A dedicated benchmark case (`video-occlusion`, an opaque bar passing in front of a stationary subject) scores MAD 0.0217 / temporalConsistencyError 0.0042 (ACCEPTABLE) under the current *unprotected* per-frame path — meaning the synthetic case happens to recover fine on its own (the subject is stationary), which is evidence the test case is lenient, not evidence the hold mechanism is unnecessary for harder real-world occlusion.

## 22. Low-confidence detection — PARTIAL

Two heuristics fire in `remove-background.ts` and genuinely surface to the user via `result.warnings`: a coverage-fraction check (`< 2%` or `> 98%`) and a confidence-threshold check (`< 0.4`). But benchmark evidence shows they're unreliable: `hard-complex-background` (MAD 0.0566) and `hard-motion-blur` (MAD 0.0563) — both NEEDS_REFINEMENT-tier, materially wrong mattes — ship with **empty warning arrays**, confirmed unchanged through the entire v1.1 fix cycle (`MATTE_V1.1_FINAL_VERIFICATION.md`). A much richer alternative, `MatteQualityEngine` (12-signal analysis, hard `needsReview` boolean, `recommendedActions`), is fully built and tested specifically to catch this class of gap — but is not wired into production; it's reachable only from two other modules (`model-router.ts`, `video/temporal-quality-engine.ts`) that are themselves unreferenced by any UI or pipeline code. Confirmed dead code, not dead-end by design.

## 23. Undo/redo — IMPLEMENTED

A real undo/redo stack (`ManualRefinementEngine.undo`/`redo`, `maxHistory = 200`) using region-scoped before/after snapshots — not just "re-upload to start over." Undo/Redo/Reset buttons are wired in `RefineMattePanel.tsx`.

## 24. Local recomputation — PARTIAL

The brush-application layer is genuinely local: `applyStroke` only snapshots/writes its own dirty region, and cost scales with stroke extent, not image size. `MattePreviewEngine.render()` even accepts an optional `region` parameter for exactly this purpose. **But the real UI path never uses it**: `useMatteRefinement.ts`'s post-edit sync calls `engine.getEffectiveAlpha()` (a full-image allocate+loop) then `previewEngine.render()` with no region argument — triggering a full-image recomposite after every single brush stroke. The capability exists and is unit-tested; production wiring discards the locality for the one thing a user actually watches update live (the preview). Alpha-layer bookkeeping and undo/redo remain local; only the visible-preview refresh is global.

## 25. Quality diagnostics — PARTIAL

Two disconnected tiers. **(a)** A comprehensive dev-only benchmark suite (`quality-benchmark/*`) computing 5 real metrics (SAD, MSE, MAD, gradient error, connectivity error) against a 34-case synthetic ground-truth dataset, reachable via `MatteQualityBenchmarkPanel.tsx` at `/tools/video/matte-quality-benchmark` — functional, but not linked from any nav/footer, developer-only in practice. **(b)** Production-facing diagnostics are limited to a single `confidence` float plus the two unreliable warning heuristics from #22. The much richer `MatteQualityEngine` (edge smoothness, halo detection, hole/island leakage, hair preservation, alpha-discontinuity spikes, colour contamination, resolution adequacy) is fully built and unit-tested but completely unreachable from any real user path — `MATTE_PRODUCTION_READINESS_REPORT.md` independently reaches the same conclusion.

---

## Five highest-impact gaps, ranked by benchmark evidence

1. **Alpha matting (#3) — no functional soft-alpha model is reachable by any real request.** Every image is served by segmentation-class models only, which have no soft-alpha concept at all. This is the root cause the repo's own benchmark report assigns to its worst-scoring failure class (semi-transparent fabric/glass, FAIL-tier MAD ≈0.10) — and it was independently proven **structurally unfixable by post-processing**: the one mitigation attempted (trimap feathering) moved that case's MAD by less than 1% (0.1008 → 0.1001) because the error lives in the subject's *interior*, not its edge, which no edge-only technique can reach. Highest impact, also the hardest to close — it needs a real bundled matting model, not a tuning pass.

2. **Low-confidence detection & quality diagnostics (#22, #25) — the app doesn't know when it's wrong, even though it already built the code to know.** `hard-complex-background` and `hard-motion-blur` are both quantifiably bad (NEEDS_REFINEMENT-tier) and both ship with zero warnings to the end user, unchanged across an entire fix cycle. The fix for this is the cheapest of the five: `MatteQualityEngine` is already built, already unit-tested, and specifically designed to catch exactly this gap — it simply isn't called from `remove-background.ts`. This is the best effort-to-impact ratio in the whole audit.

3. **Hair refinement for curly/voluminous hair (#10) — a genuinely unsolved algorithmic gap, not just a wiring gap.** Unlike most PARTIAL items above, this one was actually *attempted* in production and measurably failed: auto-wiring `HairRefinementEngine` provided zero benefit on its own target case while spiking `hard-fur`'s connectivity error 13x (0.0146 → 0.1901). Professional matting tools treat hair as a first-class case; here it remains manual-button-only, non-composable with other edits, and the one serious fix attempt is on record as having made things worse.

4. **Video temporal consistency & occlusion handling (#19, #21) — a complete, tested subsystem sitting at zero production reachability.** `video-fast-movement` is the only case in the whole 34-case suite to fail its own quality gate (temporalConsistencyError 0.0200), and there is no mitigation whatsoever in the reachable video path — each frame is matted completely independently. A full temporal-smoothing-plus-occlusion-hold engine already exists and is unit-tested, but the one lighter-weight fix actually tried in the real pipeline (EMA blending) measured **zero** improvement on the exact case it targeted, meaning the already-built heavier engine (never exercised end-to-end against real footage) is the only candidate left untried.

5. **Motion blur handling (#20) — the one category with no mitigating nuance at all.** Not "built but unwired" like most of this list — there is no detection, no classifier reaching the user, and no correction anywhere in the reachable pipeline. `hard-motion-blur` scores NEEDS_REFINEMENT (MAD 0.0563) silently. It shares a root cause with #2 (the same dead `MatteQualityEngine` would supply the missing signal) but is called out on its own because, unlike complex-background, there isn't even partial instrumentation for it today.
