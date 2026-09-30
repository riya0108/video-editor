import { TrimapLabel } from "./trimap";
import { detectHairCandidates, DEFAULT_HAIR_DETECTION_OPTIONS, type HairDetectionOptions } from "./hair-detector";
import { estimateLocalBackground } from "../decontaminate";
import type { EdgeClassifier, EdgeClassifierInput, EdgeClassificationMap } from "./edge-classifier";
import { EdgeCategory } from "./edge-category";
import {
  computeAlphaGradientMagnitude,
  computeLocalDensity,
  computeStructureTensorAnisotropy,
  computeChromaticity,
  computeLocalAlphaRange,
  computeAlphaOscillationDensity,
  chromaticityDistance,
  estimateNearbyForegroundColor,
  rampToConfidence,
} from "./edge-signals";

/**
 * ClassicalEdgeClassifier — the default (and, today, only) EdgeClassifier.
 * Built entirely from classical, model-free signals (edge-signals.ts) plus
 * Phase 3's existing hair/fur cue (hair-detector.ts) — no new model, no
 * licensing concern, matching "do not make this system dependent on one ML
 * model". Every category's score is an independent, documented combination
 * of measured signals; none are fabricated defaults.
 *
 * Honesty note: HARD_EDGE, SOFT_EDGE, HAIR, FUR, and TRANSLUCENT rest on
 * fairly direct, well-behaved signals (alpha gradient, hair/fur cue,
 * plateau range). MOTION_BLUR, SHADOW, and REFLECTION are inherently harder
 * to tell apart from a single still alpha+colour frame with classical
 * heuristics alone — a genuine limitation, not something this module papers
 * over. Each of those three is deliberately built to fail toward
 * UNCERTAIN rather than a confident wrong answer when its specific evidence
 * (chromaticity match, directional coherence) isn't clearly present, and
 * REFLECTION additionally applies its own extra caution multiplier — see
 * `reflectionCautionFactor` below, the concrete form of "REFLECTION -> treat
 * cautiously".
 */
export interface ClassicalEdgeClassifierOptions {
  /** Alpha-Sobel gradient magnitude (native 0..1-alpha units) at/above which a transition counts as a HARD_EDGE. */
  hardEdgeGradientThreshold: number;
  /** Hair/fur cue confidence (see hair-detector.ts) at/above which a pixel counts as part of the analyzed region even outside the trimap's UNKNOWN band — mirrors Phase 3's own "real hair is often confidently opaque" precedent. */
  hairRoiThreshold: number;
  /** Window radius for measuring HAIR (sparse) vs FUR (dense) local candidate density. */
  hairDensityRadius: number;
  /** Window radius for the alternation/oscillation check that separates real hair/fur texture from a plain monotonic edge (see computeAlphaOscillationDensity). */
  oscillationRadius: number;
  /** Oscillation density at/above which a pixel's hair-detector confidence is trusted at full strength for classification purposes; below it, confidence is scaled down proportionally (a monotonic edge scores 0 here and is fully discounted). */
  oscillationThreshold: number;
  /** Window radius for the TRANSLUCENT plateau range check (computeLocalAlphaRange). */
  translucentRangeRadius: number;
  /** Max (local max - local min) alpha over that window to still count as a flat plateau rather than a moving ramp. */
  translucentRangeThreshold: number;
  /** Half-width of the "how close to alpha 0.5" peak used by the TRANSLUCENT/midrange signal. */
  translucentMidWidth: number;
  /** Window radius for the structure-tensor anisotropy measurement (MOTION_BLUR). */
  anisotropyRadius: number;
  /** Window radius for measuring how WIDE the local unknown-band transition is (MOTION_BLUR needs "directional AND wide", not directional alone — an ordinary edge is directional too, over a much narrower band). */
  motionBlurBandWidthRadius: number;
  /** Ring-search radius for the background/foreground colour estimates the SHADOW/REFLECTION chromaticity cues need. */
  chromaSearchRadius: number;
  /** Chromaticity-space distance below which a pixel counts as "same hue" as the compared background/foreground estimate. */
  chromaSimilarityThreshold: number;
  /** Luminance drop (0-1 fraction of 255) relative to the local background estimate at/above which SHADOW's "darkened, same hue" signal reaches full confidence. */
  shadowLuminanceDropThreshold: number;
  /** Luminance drop relative to the nearby foreground estimate at/above which REFLECTION's "dimmer echo" signal reaches full confidence. */
  reflectionLuminanceDropThreshold: number;
  /** REFLECTION's own raw score is multiplied by this — "treat cautiously" as a hard ceiling on how confidently this classifier will ever call something a reflection. */
  reflectionCautionFactor: number;
  /** The winning category's score must clear this to be reported as-is; below it, the pixel is reported as UNCERTAIN instead (at that same, honestly-low confidence). */
  minConfidence: number;
  /** Options forwarded to hair-detector.ts's detectHairCandidates. */
  hair: HairDetectionOptions;
}

export const DEFAULT_CLASSICAL_EDGE_CLASSIFIER_OPTIONS: ClassicalEdgeClassifierOptions = {
  hardEdgeGradientThreshold: 1.2,
  hairRoiThreshold: 0.3,
  // A single strand's own alpha-variance/colour-gradient cue naturally
  // "bleeds" outward a few pixels from the actual strand column (the
  // detector's own window radii do that by design — see hair-detector.ts).
  // Found empirically (debug script, not guessed): at radius 4 a single
  // isolated strand already reads as ~56% locally dense — over the halfway
  // point that separates HAIR from FUR below — misclassifying it as FUR.
  // Radius 6 keeps a single strand's own bleed a clear minority (~38%) of
  // the window while still reading a genuinely dense, area-filling texture
  // as ~100%.
  hairDensityRadius: 6,
  oscillationRadius: 2,
  oscillationThreshold: 0.15,
  translucentRangeRadius: 4,
  translucentRangeThreshold: 0.25,
  translucentMidWidth: 0.4,
  anisotropyRadius: 3,
  motionBlurBandWidthRadius: 3,
  chromaSearchRadius: 4,
  chromaSimilarityThreshold: 0.06,
  shadowLuminanceDropThreshold: 0.15,
  reflectionLuminanceDropThreshold: 0.12,
  reflectionCautionFactor: 0.7,
  minConfidence: 0.3,
  hair: DEFAULT_HAIR_DETECTION_OPTIONS,
};

export class ClassicalEdgeClassifier implements EdgeClassifier {
  readonly name = "classical-v1";
  private readonly options: ClassicalEdgeClassifierOptions;

  constructor(overrides: Partial<ClassicalEdgeClassifierOptions> = {}) {
    this.options = { ...DEFAULT_CLASSICAL_EDGE_CLASSIFIER_OPTIONS, ...overrides, hair: { ...DEFAULT_HAIR_DETECTION_OPTIONS, ...overrides.hair } };
  }

  classify({ alpha, rgba, width, height, trimap }: EdgeClassifierInput): EdgeClassificationMap {
    const o = this.options;
    const n = width * height;

    const gradientMag = computeAlphaGradientMagnitude(alpha, width, height);
    const { confidence: rawHairConfidence, candidateMask } = detectHairCandidates(alpha, rgba, width, height, o.hair);
    const oscillation = computeAlphaOscillationDensity(alpha, width, height, o.oscillationRadius);
    // hair-detector.ts's confidence alone can't distinguish real strand
    // alternation from a single monotonic edge (both show high local alpha
    // variance) — gate it by how much the alpha actually oscillates before
    // using it for classification. See computeAlphaOscillationDensity's doc
    // comment for why this was needed.
    const hairConfidence = new Float32Array(n);
    for (let i = 0; i < n; i++) hairConfidence[i] = rawHairConfidence[i] * rampToConfidence(oscillation[i], o.oscillationThreshold);
    const hairDensity = computeLocalDensity(candidateMask, width, height, o.hairDensityRadius);
    const localRange = computeLocalAlphaRange(alpha, width, height, o.translucentRangeRadius);
    const anisotropy = computeStructureTensorAnisotropy(rgba, width, height, o.anisotropyRadius);
    const { rNorm, gNorm, luminance } = computeChromaticity(rgba, width, height);

    const unknownMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) unknownMask[i] = trimap[i] === TrimapLabel.Unknown ? 1 : 0;
    const unknownBandWidth = computeLocalDensity(unknownMask, width, height, o.motionBlurBandWidthRadius);
    // A perfectly binary alpha field (0/1, no graded transition at all) can
    // legitimately produce ZERO Unknown trimap pixels — buildTrimap's
    // thresholds are strict — even though the 0/1 boundary itself is very
    // much an edge (in fact, the clearest possible HARD_EDGE). Found via
    // this classifier's own HARD_EDGE test: without this, a pixel right at
    // such a boundary has no Unknown label AND (correctly, post-oscillation-
    // gating) no hair signal, so it fell through both ROI checks and was
    // never evaluated at all. A pixel adjacent to a *different* trimap label
    // is unambiguously part of a boundary regardless of whether an Unknown
    // pixel sits between them.
    const boundaryMask = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = trimap[i];
        const differs =
          (x > 0 && trimap[i - 1] !== t) ||
          (x < width - 1 && trimap[i + 1] !== t) ||
          (y > 0 && trimap[i - width] !== t) ||
          (y < height - 1 && trimap[i + width] !== t);
        boundaryMask[i] = differs ? 1 : 0;
      }
    }

    const labels = new Uint8Array(n);
    const confidence = new Float32Array(n);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const inRoi = unknownMask[i] === 1 || boundaryMask[i] === 1 || hairConfidence[i] >= o.hairRoiThreshold;
        if (!inRoi) {
          labels[i] = EdgeCategory.Uncertain;
          confidence[i] = 0; // not evaluated at all — see EdgeClassificationMap's doc comment
          continue;
        }

        const hardEdgeRamp = rampToConfidence(gradientMag[i], o.hardEdgeGradientThreshold);
        const notHair = 1 - hairConfidence[i];

        const hardEdgeScore = hardEdgeRamp * notHair;
        const hairScore = hairConfidence[i] * (1 - hairDensity[i]);
        const furScore = hairConfidence[i] * hairDensity[i];

        const midRangeness = 1 - Math.min(1, Math.abs(alpha[i] - 0.5) / o.translucentMidWidth);
        const flatness = 1 - rampToConfidence(localRange[i], o.translucentRangeThreshold);
        const translucentScore = midRangeness * flatness * notHair;

        const motionBlurScore = anisotropy[i] * unknownBandWidth[i] * notHair * (1 - hardEdgeRamp);

        let shadowScore = 0;
        const bg = estimateLocalBackground(rgba, alpha, x, y, width, height, 0.1, o.chromaSearchRadius);
        if (bg) {
          const bgSum = bg[0] + bg[1] + bg[2] + 1e-3;
          const bgChromaDist = chromaticityDistance(rNorm[i], gNorm[i], bg[0] / bgSum, bg[1] / bgSum);
          const chromaSimilarity = 1 - rampToConfidence(bgChromaDist, o.chromaSimilarityThreshold);
          const bgLuminance = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
          const luminanceDrop = Math.max(0, bgLuminance - luminance[i]) / 255;
          shadowScore = chromaSimilarity * rampToConfidence(luminanceDrop, o.shadowLuminanceDropThreshold) * notHair;
        }

        let reflectionScore = 0;
        const fg = estimateNearbyForegroundColor(rgba, trimap, x, y, width, height, o.chromaSearchRadius);
        if (fg) {
          const fgSum = fg[0] + fg[1] + fg[2] + 1e-3;
          const fgChromaDist = chromaticityDistance(rNorm[i], gNorm[i], fg[0] / fgSum, fg[1] / fgSum);
          const chromaSimilarity = 1 - rampToConfidence(fgChromaDist, o.chromaSimilarityThreshold);
          const fgLuminance = 0.299 * fg[0] + 0.587 * fg[1] + 0.114 * fg[2];
          const dimnessDrop = Math.max(0, fgLuminance - luminance[i]) / 255;
          reflectionScore = chromaSimilarity * rampToConfidence(dimnessDrop, o.reflectionLuminanceDropThreshold) * notHair * o.reflectionCautionFactor;
        }

        // SOFT_EDGE is deliberately computed LAST, as the residual "none of
        // the more specific categories actually apply" case among the
        // low-gradient pixels — discounted by every other category's own
        // score, not just hardEdge/hair/translucent. Found via this
        // classifier's own SHADOW test: without discounting by shadowScore
        // too, a genuinely shadow-like low-gradient region defaulted to
        // SOFT_EDGE simply because "low gradient" was the only thing
        // softEdgeScore originally checked for.
        const softEdgeScore =
          (1 - hardEdgeRamp) * notHair * (1 - translucentScore) * (1 - shadowScore) * (1 - reflectionScore) * (1 - motionBlurScore);

        const scores: [EdgeCategory, number][] = [
          [EdgeCategory.HardEdge, hardEdgeScore],
          [EdgeCategory.SoftEdge, softEdgeScore],
          [EdgeCategory.Hair, hairScore],
          [EdgeCategory.Fur, furScore],
          [EdgeCategory.Translucent, translucentScore],
          [EdgeCategory.MotionBlur, motionBlurScore],
          [EdgeCategory.Shadow, shadowScore],
          [EdgeCategory.Reflection, reflectionScore],
        ];

        let bestCategory = EdgeCategory.Uncertain;
        let bestScore = 0;
        for (const [category, score] of scores) {
          if (score > bestScore) {
            bestCategory = category;
            bestScore = score;
          }
        }

        if (bestScore < o.minConfidence) {
          labels[i] = EdgeCategory.Uncertain;
          confidence[i] = bestScore;
        } else {
          labels[i] = bestCategory;
          confidence[i] = Math.min(1, bestScore);
        }
      }
    }

    return { labels, confidence };
  }
}
