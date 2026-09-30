import { buildTrimap, buildFineDetailMask, DEFAULT_TRIMAP_OPTIONS, DEFAULT_FINE_DETAIL_OPTIONS, type TrimapOptions, type FineDetailOptions } from "./trimap";
import { detectHairCandidates, DEFAULT_HAIR_DETECTION_OPTIONS, type HairDetectionOptions } from "./hair-detector";
import { DEFAULT_DECONTAMINATE_OPTIONS, type DecontaminateOptions } from "../decontaminate";
import { computeQualityMetrics, computeConfidence } from "../quality-metrics";
import { rampToConfidence } from "./edge-signals";
import type { BoundingBox } from "../types";
import {
  analyzeEdgeSmoothness,
  analyzeEdgeContinuity,
  analyzeHalos,
  analyzeHolesAndIslands,
  analyzeHairPreservation,
  analyzeAlphaDiscontinuity,
  analyzeColourContamination,
  analyzeResolutionAdequacy,
  type EdgeSmoothnessResult,
  type EdgeContinuityResult,
  type HaloResult,
  type HoleIslandAnalysis,
  type HairPreservationResult,
  type AlphaDiscontinuityResult,
  type ContaminationResult,
  type ResolutionAdequacyResult,
} from "./matte-quality-signals";

/**
 * MATTE QUALITY ENGINE — Phase 7. Evaluates an already-produced alpha matte
 * across 12 concrete, independently-measured dimensions (see
 * matte-quality-signals.ts) and reduces them to the MatteQualityReport the
 * brief specifies. This module does not itself fix anything — see
 * `recommendedActions` below for how its findings are meant to trigger work
 * elsewhere in the pipeline (Phase 2 refinement, Phase 3 hair refinement,
 * Phase 6 manual/local refinement, or a different model via router.ts).
 *
 * Two explicit instructions from the brief, enforced structurally here, not
 * just by convention:
 *   - "Do not fabricate scores. Scores must come from actual measurable
 *     analysis." — every field on MatteQualityReport traces to a real
 *     computation in matte-quality-signals.ts (or Phase 1's
 *     quality-metrics.ts); `details` exposes every one of those raw
 *     sub-results so the derivation is auditable, not just asserted.
 *   - "If confidence is low, mark the result as needing review." —
 *     `needsReview` is a hard boolean, not a suggestion buried in prose, and
 *     `warnings`/`recommendedActions` always include a human-review entry
 *     when it's true.
 *
 * IMPORTANT — score polarity (the brief's own field names mix both, so this
 * is called out explicitly rather than left implicit): `overallQuality`,
 * `confidence`, `edgeQuality`, and `hairQuality` are GOODNESS scores — 1 is
 * good. `leakageScore`, `haloScore`, `contaminationScore`, and
 * `fragmentationScore` are SEVERITY scores — 1 is bad. Mixing these up when
 * consuming the report would silently invert every threshold check.
 *
 * PRODUCTION READINESS (H6): confirmed via repo-wide import search that
 * `pipeline/remove-background.ts` (the real production pipeline) does NOT
 * call this engine — it only uses the simpler Phase-1 quality-metrics.ts
 * (a single `confidence` float, no per-defect warnings, no
 * `problemRegions`). This engine's rich, specific defect analysis
 * (halo/hole/hair/contamination detection with `needsReview` and
 * `recommendedActions`) is only reachable via model-router.ts and
 * video/temporal-quality-engine.ts, neither of which is on the production
 * path either. Do not describe this engine's output as something end users
 * currently see.
 */

export const enum RecommendedAction {
  /** Re-run alpha refinement (Phase 2's refineAlphaMatte, possibly with adjusted parameters) or colour decontamination (Phase 4) over the whole matte. */
  AdditionalRefinement = "additional-refinement",
  /** Worth retrying via a different model in router.ts's fallback chain — this result's own quality/confidence is too low to trust as final. */
  AlternativeModel = "alternative-model",
  /** A specific, boundable problem exists — route `problemRegions` into Phase 3's HairRefinementEngine.refineRegion or Phase 6's ManualRefinementEngine rather than reprocessing the whole image. */
  LocalRefinement = "local-refinement",
  /** Confidence or quality is low enough that a person should look at this before it ships. */
  HumanReview = "human-review",
}

export interface MatteQualityDetails {
  edgeSmoothness: EdgeSmoothnessResult;
  edgeContinuity: EdgeContinuityResult;
  halo: HaloResult;
  holesAndIslands: HoleIslandAnalysis;
  hairPreservation: HairPreservationResult;
  alphaDiscontinuity: AlphaDiscontinuityResult;
  contamination: ContaminationResult;
  resolutionAdequacy: ResolutionAdequacyResult;
}

export interface MatteQualityReport {
  /** 0 (unusable) .. 1 (excellent) — GOODNESS. A documented mean of every other goodness component below (see MatteQualityEngine.analyze's implementation) — not an opaque or independently-tuned number. */
  overallQuality: number;
  /** 0..1 — GOODNESS. How much this specific result should be trusted at all, independent of how "good" it looks — see needsReview. */
  confidence: number;
  /** 0..1 — GOODNESS. Combines edge smoothness, edge continuity, and the absence of alpha discontinuities (spikes). */
  edgeQuality: number;
  /** 0..1 — GOODNESS. How well fine hair/fur detail (where present) kept continuous, non-binarized alpha. See `details.hairPreservation.noHairDetected` before reading a 1.0 here as praise — it may just mean there was no hair to evaluate. */
  hairQuality: number;
  /** 0..1 — SEVERITY. Enclosed background pockets (holes) within the foreground, relative to foreground area. */
  leakageScore: number;
  /** 0..1 — SEVERITY. Fraction of the uncertain edge band showing the closed-form colour-overshoot signature of a dark/white halo (same math as Phase 4's safeguard, used here as a read-only measurement). */
  haloScore: number;
  /** 0..1 — SEVERITY. How much of the uncertain edge band shows background-colour-bleed evidence (reuses Phase 1's decontaminate.ts as a read-only analysis, not a correction). */
  contaminationScore: number;
  /** 0..1 — SEVERITY. Foreground area that sits in small disconnected fragments unrelated to genuine hair/fur, relative to total foreground area. */
  fragmentationScore: number;
  /** Human-readable, specific findings — only emitted when a metric actually crosses a "worth mentioning" threshold, never generic boilerplate. */
  warnings: string[];
  /** De-duplicated, in a fixed priority order (AdditionalRefinement, LocalRefinement, AlternativeModel, HumanReview) — see each RecommendedAction variant's doc comment for what triggers it. */
  recommendedActions: RecommendedAction[];
  /** Hard flag — true whenever `confidence` (or, defensively, `overallQuality`) falls below this engine's review threshold. Always true when recommendedActions includes HumanReview, and vice versa. */
  needsReview: boolean;
  /** Bounding boxes of specific problems found (holes, loss islands, halo clusters) — feed these directly into Phase 3's refineRegion or Phase 6's ManualRefinementEngine for LocalRefinement instead of reprocessing the whole image. */
  problemRegions: BoundingBox[];
  /** Every raw sub-measurement this report was derived from — see the module doc comment's "do not fabricate scores" note. */
  details: MatteQualityDetails;
}

export interface MatteQualityOptions {
  trimap: TrimapOptions;
  fineDetail: FineDetailOptions;
  hair: HairDetectionOptions;
  decontaminate: DecontaminateOptions;
  /** Fraction of the uncertain edge band showing halo-overshoot evidence at/above which the halo is worth a warning/recommended action. */
  haloWarningThreshold: number;
  /** Fraction of foreground area occupied by holes at/above which leakage is worth a warning/recommended action. */
  leakageWarningThreshold: number;
  /** Fraction of foreground area occupied by non-hair fragments at/above which fragmentation is worth a warning/recommended action. */
  fragmentationWarningThreshold: number;
  /** GOODNESS score (hairQuality) at/below which hair loss is worth a warning/recommended action, when hair was actually detected. */
  hairQualityWarningThreshold: number;
  /** confidence at/below which the report is marked needsReview. */
  confidenceReviewThreshold: number;
  /** overallQuality at/below which the report is marked needsReview even if confidence alone didn't trigger it. */
  overallQualityReviewThreshold: number;
  /** Shortest-side pixel count at/below which resolution is "clearly inadequate" — see analyzeResolutionAdequacy. Calibrated for real photos (a few hundred px), not tiny test fixtures — a caller analyzing deliberately small images (e.g. thumbnails, or this module's own unit tests) should override these rather than get an automatic, resolution-driven confidence penalty that has nothing to do with the matte itself. */
  resolutionLowThreshold: number;
  /** Shortest-side pixel count at/above which resolution is "comfortably adequate" for a subject with no fine detail. */
  resolutionHighThreshold: number;
  /** Same, but for a subject where fine hair/fur detail was actually detected — preserving it needs more resolution than a plain silhouette does. */
  resolutionHighThresholdWithFineDetail: number;
}

export const DEFAULT_MATTE_QUALITY_OPTIONS: MatteQualityOptions = {
  trimap: DEFAULT_TRIMAP_OPTIONS,
  fineDetail: DEFAULT_FINE_DETAIL_OPTIONS,
  hair: DEFAULT_HAIR_DETECTION_OPTIONS,
  decontaminate: DEFAULT_DECONTAMINATE_OPTIONS,
  haloWarningThreshold: 0.1,
  leakageWarningThreshold: 0.03,
  fragmentationWarningThreshold: 0.03,
  hairQualityWarningThreshold: 0.6,
  confidenceReviewThreshold: 0.4,
  overallQualityReviewThreshold: 0.35,
  resolutionLowThreshold: 180,
  resolutionHighThreshold: 720,
  resolutionHighThresholdWithFineDetail: 1080,
};

export class MatteQualityEngine {
  private readonly options: MatteQualityOptions;

  constructor(overrides: Partial<MatteQualityOptions> = {}) {
    this.options = {
      ...DEFAULT_MATTE_QUALITY_OPTIONS,
      ...overrides,
      trimap: { ...DEFAULT_TRIMAP_OPTIONS, ...overrides.trimap },
      fineDetail: { ...DEFAULT_FINE_DETAIL_OPTIONS, ...overrides.fineDetail },
      hair: { ...DEFAULT_HAIR_DETECTION_OPTIONS, ...overrides.hair },
      decontaminate: { ...DEFAULT_DECONTAMINATE_OPTIONS, ...overrides.decontaminate },
    };
  }

  analyze(alpha: Float32Array, rgba: Uint8ClampedArray, width: number, height: number, trimap?: Uint8Array): MatteQualityReport {
    const o = this.options;
    const t = trimap ?? buildTrimap(alpha, width, height, o.trimap);

    const fineDetailMask = buildFineDetailMask(rgba, width, height, o.fineDetail);
    const { candidateMask: hairCandidateMask } = detectHairCandidates(alpha, rgba, width, height, o.hair);

    const edgeSmoothness = analyzeEdgeSmoothness(alpha, t, width, height);
    const edgeContinuity = analyzeEdgeContinuity(t, width, height);
    const halo = analyzeHalos(rgba, alpha, t, width, height, o.decontaminate);
    const holesAndIslands = analyzeHolesAndIslands(alpha, fineDetailMask, width, height);
    const hairPreservation = analyzeHairPreservation(alpha, hairCandidateMask);
    const alphaDiscontinuity = analyzeAlphaDiscontinuity(alpha, t, width, height);
    const contamination = analyzeColourContamination(rgba, alpha, width, height, o.decontaminate);

    let hairCandidateCount = 0;
    for (const v of hairCandidateMask) if (v) hairCandidateCount++;
    const fineDetailPresent = hairCandidateCount / (width * height) > 0.005;
    const resolutionAdequacy = analyzeResolutionAdequacy(
      width,
      height,
      fineDetailPresent,
      o.resolutionLowThreshold,
      o.resolutionHighThreshold,
      o.resolutionHighThresholdWithFineDetail,
    );

    const details: MatteQualityDetails = {
      edgeSmoothness,
      edgeContinuity,
      halo,
      holesAndIslands,
      hairPreservation,
      alphaDiscontinuity,
      contamination,
      resolutionAdequacy,
    };

    const edgeQuality = (edgeSmoothness.score + edgeContinuity.score + alphaDiscontinuity.score) / 3;
    const hairQuality = hairPreservation.score;

    const foregroundArea = Math.max(1, holesAndIslands.foregroundArea);
    const leakageScore = rampToConfidence(holesAndIslands.holesArea / foregroundArea, 0.05);
    const haloScore = halo.score;
    const contaminationScore = contamination.score;
    const fragmentationScore = rampToConfidence(holesAndIslands.lossIslandsArea / foregroundArea, 0.05);

    const baseQualityMetrics = computeQualityMetrics(alpha, width, height);
    const baseConfidence = computeConfidence(baseQualityMetrics);
    const avgSeverity = (leakageScore + haloScore + contaminationScore + fragmentationScore) / 4;

    const overallQuality = Math.min(
      1,
      Math.max(
        0,
        (edgeQuality + hairQuality + (1 - leakageScore) + (1 - haloScore) + (1 - contaminationScore) + (1 - fragmentationScore) + resolutionAdequacy.score) /
          7,
      ),
    );

    // Documented, explainable combination — not an independently-tuned
    // "confidence model": start from Phase 1's histogram-bimodality-based
    // confidence, then derate it by how much real evidence of problems this
    // engine found (avgSeverity) and by whether the image even has enough
    // resolution to trust fine-detail claims.
    const confidence = Math.min(1, Math.max(0, baseConfidence * (1 - 0.5 * avgSeverity) * (0.5 + 0.5 * resolutionAdequacy.score)));

    const warnings: string[] = [];
    const actions = new Set<RecommendedAction>();
    const problemRegions: BoundingBox[] = [
      ...holesAndIslands.holeRegions,
      ...holesAndIslands.lossIslandRegions,
      ...halo.regions,
    ];

    if (holesAndIslands.holesCount > 0 && leakageScore >= o.leakageWarningThreshold) {
      warnings.push(
        `Detected ${holesAndIslands.holesCount} enclosed hole(s) covering ${(holesAndIslands.holesArea / foregroundArea * 100).toFixed(1)}% of the foreground area — possible background leakage.`,
      );
      actions.add(RecommendedAction.LocalRefinement);
    }
    if (holesAndIslands.lossIslandsCount > 0 && fragmentationScore >= o.fragmentationWarningThreshold) {
      warnings.push(
        `Foreground is fragmented into ${holesAndIslands.lossIslandsCount} disconnected piece(s) beyond the main subject, unrelated to detected hair/fur — possible foreground loss.`,
      );
      actions.add(RecommendedAction.LocalRefinement);
    }
    if (haloScore >= o.haloWarningThreshold) {
      warnings.push(`${halo.suspectPixelCount} pixel(s) along the edge show a colour-overshoot signature consistent with a dark/white halo.`);
      actions.add(RecommendedAction.AdditionalRefinement);
    }
    if (contaminationScore >= 0.15) {
      warnings.push("Background colour contamination detected along the matte edge.");
      actions.add(RecommendedAction.AdditionalRefinement);
    }
    if (!hairPreservation.noHairDetected && hairQuality <= o.hairQualityWarningThreshold) {
      warnings.push(`Fine hair/fur detail was detected but ${((1 - hairQuality) * 100).toFixed(0)}% of it has been crushed to near-binary alpha.`);
      actions.add(RecommendedAction.LocalRefinement);
    }
    if (edgeContinuity.componentCount > 1 && edgeContinuity.score < 0.5) {
      warnings.push(`Matte edge is fragmented into ${edgeContinuity.componentCount} disconnected segments (continuity score ${edgeContinuity.score.toFixed(2)}).`);
    }
    if (alphaDiscontinuity.spikeCount > 0) {
      warnings.push(`${alphaDiscontinuity.spikeCount} isolated alpha discontinuit${alphaDiscontinuity.spikeCount === 1 ? "y" : "ies"} detected outside the transition band.`);
    }
    if (resolutionAdequacy.score < 0.5) {
      warnings.push(
        resolutionAdequacy.fineDetailPresent
          ? `Source resolution (${resolutionAdequacy.minDimension}px shortest side) may be inadequate to preserve the fine hair/fur detail present in this image.`
          : `Source resolution (${resolutionAdequacy.minDimension}px shortest side) is low.`,
      );
    }
    if (overallQuality < o.overallQualityReviewThreshold || confidence < o.confidenceReviewThreshold) {
      actions.add(RecommendedAction.AlternativeModel);
    }

    const needsReview = confidence <= o.confidenceReviewThreshold || overallQuality <= o.overallQualityReviewThreshold;
    if (needsReview) {
      actions.add(RecommendedAction.HumanReview);
      warnings.push(`Confidence (${confidence.toFixed(2)}) or overall quality (${overallQuality.toFixed(2)}) is low — this result needs review before use.`);
    }

    const priorityOrder = [RecommendedAction.AdditionalRefinement, RecommendedAction.LocalRefinement, RecommendedAction.AlternativeModel, RecommendedAction.HumanReview];
    const recommendedActions = priorityOrder.filter((a) => actions.has(a));

    return {
      overallQuality,
      confidence,
      edgeQuality,
      hairQuality,
      leakageScore,
      haloScore,
      contaminationScore,
      fragmentationScore,
      warnings,
      recommendedActions,
      needsReview,
      problemRegions,
      details,
    };
  }
}
