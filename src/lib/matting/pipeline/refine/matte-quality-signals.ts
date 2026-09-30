import { boxBlur } from "../guided-filter";
import { decontaminate, estimateLocalBackground, DEFAULT_DECONTAMINATE_OPTIONS, type DecontaminateOptions } from "../decontaminate";
import type { BoundingBox } from "../types";
import { TrimapLabel } from "./trimap";
import { labelConnectedComponents, type ConnectedComponents } from "./connected-components";
import { computeAlphaGradientMagnitude, rampToConfidence } from "./edge-signals";

/**
 * MATTE QUALITY ENGINE — Phase 7. Individual, independently-testable
 * measurement primitives. Every function here computes its result directly
 * from the actual alpha/rgba data passed in — none returns a placeholder,
 * an assumed-good default, or a value not traceable to a real computation
 * ("do not fabricate scores"). matte-quality-engine.ts combines these into
 * the MatteQualityReport; this file has no opinion about reports, warnings,
 * or recommended actions — just measurements.
 */

/** Bounding box (in the shared BoundingBox shape, so a caller can feed it straight to computeBoundingBox-consuming code) around a connected component's own pixel list. */
export function boundingBoxOfPixels(pixels: number[], width: number): BoundingBox {
  let minX = width;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (const i of pixels) {
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface EdgeSmoothnessResult {
  /** 0 (very jagged/noisy) .. 1 (smooth). */
  score: number;
  /** How many unknown-band pixels this was measured over — 0 means there was no soft transition band to evaluate at all (a purely binary alpha), not that the edge is "perfectly smooth". */
  sampleCount: number;
}

/**
 * Measures jaggedness as the residual between the alpha in the UNKNOWN band
 * and a lightly-smoothed copy of itself — a genuinely smooth transition
 * survives a light blur almost unchanged; a jagged/staircased one doesn't.
 */
export function analyzeEdgeSmoothness(alpha: Float32Array, trimap: Uint8Array, width: number, height: number, blurRadius = 1): EdgeSmoothnessResult {
  const smoothed = boxBlur(alpha, width, height, blurRadius);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (trimap[i] !== TrimapLabel.Unknown) continue;
    sum += Math.abs(alpha[i] - smoothed[i]);
    count++;
  }
  if (count === 0) return { score: 1, sampleCount: 0 };
  const avgResidual = sum / count;
  return { score: 1 - rampToConfidence(avgResidual, 0.08), sampleCount: count };
}

export interface EdgeContinuityResult {
  /** 0 (fragmented into many disconnected pieces) .. 1 (one continuous boundary). */
  score: number;
  componentCount: number;
}

/** Labels the UNKNOWN band (or, when there isn't one — a purely binary alpha — the set of pixels directly adjacent to a trimap label change) into connected components; continuity is how much the single largest component dominates the total. */
export function analyzeEdgeContinuity(trimap: Uint8Array, width: number, height: number): EdgeContinuityResult {
  let mask = new Uint8Array(trimap.length);
  let any = false;
  for (let i = 0; i < trimap.length; i++) {
    if (trimap[i] === TrimapLabel.Unknown) {
      mask[i] = 1;
      any = true;
    }
  }
  if (!any) {
    // No soft band at all — fall back to boundary adjacency (see trimap-boundary reasoning in classical-edge-classifier.ts).
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = trimap[i];
        const differs =
          (x > 0 && trimap[i - 1] !== t) ||
          (x < width - 1 && trimap[i + 1] !== t) ||
          (y > 0 && trimap[i - width] !== t) ||
          (y < height - 1 && trimap[i + width] !== t);
        if (differs) {
          mask[i] = 1;
          any = true;
        }
      }
    }
  }
  if (!any) return { score: 1, componentCount: 0 }; // no boundary anywhere at all (e.g. a blank frame)

  const components = labelConnectedComponents(mask, width, height);
  const total = mask.reduce((s, v) => s + v, 0);
  const largest = Math.max(0, ...components.sizes);
  return { score: total > 0 ? largest / total : 1, componentCount: components.sizes.length };
}

export interface HaloResult {
  /** 0 (no halo evidence) .. 1 (pervasive halo evidence). */
  score: number;
  suspectPixelCount: number;
  regions: BoundingBox[];
}

/**
 * Reuses the exact overshoot math behind Phase 4's dark/white-halo
 * safeguard (decontamination-engine.ts), but as a read-only measurement:
 * for each UNKNOWN-band pixel, estimate the local background and compute
 * the raw (unclamped) closed-form foreground estimate. A large overshoot
 * beyond [0,255] means the linear blend model implies an implausible
 * colour at that pixel — exactly the signature a dark/white halo leaves.
 */
export function analyzeHalos(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  trimap: Uint8Array,
  width: number,
  height: number,
  options: DecontaminateOptions = DEFAULT_DECONTAMINATE_OPTIONS,
  overshootThreshold = 80,
): HaloResult {
  const suspectMask = new Uint8Array(width * height);
  let sampleCount = 0;
  let suspectCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (trimap[i] !== TrimapLabel.Unknown) continue;
      const a = alpha[i];
      if (a <= options.loThreshold || a >= options.hiThreshold) continue;
      sampleCount++;

      const bg = estimateLocalBackground(rgba, alpha, x, y, width, height, options.loThreshold, options.searchRadius);
      if (!bg) continue;

      const o = i * 4;
      let overshoot = 0;
      for (let c = 0; c < 3; c++) {
        const raw = (rgba[o + c] - (1 - a) * bg[c]) / a;
        overshoot = Math.max(overshoot, Math.max(0, -raw), Math.max(0, raw - 255));
      }
      if (overshoot > overshootThreshold) {
        suspectMask[i] = 1;
        suspectCount++;
      }
    }
  }

  const regions: BoundingBox[] = [];
  if (suspectCount > 0) {
    const components = labelConnectedComponents(suspectMask, width, height);
    for (const pixels of components.pixelsByLabel) {
      if (pixels.length >= 2) regions.push(boundingBoxOfPixels(pixels, width));
    }
  }

  return { score: sampleCount > 0 ? suspectCount / sampleCount : 0, suspectPixelCount: suspectCount, regions };
}

export interface HoleIslandAnalysis {
  foregroundArea: number;
  largestForegroundComponentArea: number;
  holesCount: number;
  holesArea: number;
  holeRegions: BoundingBox[];
  /** Disconnected foreground islands NOT substantially overlapping the fine-detail mask — i.e. plausible foreground loss, with genuine hair/fur wisps already excluded. */
  lossIslandsCount: number;
  lossIslandsArea: number;
  lossIslandRegions: BoundingBox[];
}

/**
 * Labels enclosed background components within the foreground (holes —
 * background leakage / small-hole artifacts) and disconnected foreground
 * components (islands). An island substantially covered by `fineDetailMask`
 * (see hair-detector.ts / trimap.ts) is treated as plausible genuine detail
 * (a hair wisp), not loss — same exclusion principle Phase 2's cleanup.ts
 * uses for automatic cleanup, applied here for *measurement* instead.
 */
export function analyzeHolesAndIslands(
  alpha: Float32Array,
  fineDetailMask: Uint8Array | null,
  width: number,
  height: number,
  binarizeThreshold = 0.5,
  fineDetailOverlapThreshold = 0.2,
): HoleIslandAnalysis {
  const n = width * height;
  const foregroundMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) foregroundMask[i] = alpha[i] > binarizeThreshold ? 1 : 0;
  const foregroundArea = foregroundMask.reduce((s, v) => s + v, 0);

  const backgroundMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) backgroundMask[i] = 1 - foregroundMask[i];
  const backgroundComponents = labelConnectedComponents(backgroundMask, width, height);

  let holesCount = 0;
  let holesArea = 0;
  const holeRegions: BoundingBox[] = [];
  for (let label = 0; label < backgroundComponents.sizes.length; label++) {
    if (backgroundComponents.touchesBorder[label]) continue;
    holesCount++;
    holesArea += backgroundComponents.sizes[label];
    holeRegions.push(boundingBoxOfPixels(backgroundComponents.pixelsByLabel[label], width));
  }

  const foregroundComponents: ConnectedComponents = labelConnectedComponents(foregroundMask, width, height);
  let largestForegroundComponentArea = 0;
  for (const size of foregroundComponents.sizes) largestForegroundComponentArea = Math.max(largestForegroundComponentArea, size);

  let lossIslandsCount = 0;
  let lossIslandsArea = 0;
  const lossIslandRegions: BoundingBox[] = [];
  for (let label = 0; label < foregroundComponents.sizes.length; label++) {
    const size = foregroundComponents.sizes[label];
    if (size === largestForegroundComponentArea) continue; // the main mass itself, not a fragment of it
    const pixels = foregroundComponents.pixelsByLabel[label];
    let detailCount = 0;
    if (fineDetailMask) for (const i of pixels) if (fineDetailMask[i]) detailCount++;
    const detailFraction = pixels.length > 0 ? detailCount / pixels.length : 0;
    if (detailFraction >= fineDetailOverlapThreshold) continue; // plausible genuine hair/fur wisp, not loss
    lossIslandsCount++;
    lossIslandsArea += size;
    lossIslandRegions.push(boundingBoxOfPixels(pixels, width));
  }

  return {
    foregroundArea,
    largestForegroundComponentArea,
    holesCount,
    holesArea,
    holeRegions,
    lossIslandsCount,
    lossIslandsArea,
    lossIslandRegions,
  };
}

export interface HairPreservationResult {
  /** 0 (hair signal present but crushed to near-binary) .. 1 (graded, continuous alpha preserved where hair was detected). 1 is also reported when there's no hair signal at all — see the caveat below. */
  score: number;
  candidatePixelCount: number;
  /** True only when `candidatePixelCount` is 0 — a perfect score here means "nothing to evaluate", not "hair was preserved perfectly". Callers should check this before treating a 1.0 as praise. */
  noHairDetected: boolean;
}

/**
 * Among pixels the hair detector flagged as candidates (hair-detector.ts),
 * what fraction still carry graded (non-binary) alpha — a matte that
 * crushed real strand structure to hard 0/1 values lost it, even if the
 * *detector* still sees texture in the source image.
 *
 * Caveat, honestly noted rather than hidden: hair-detector.ts's
 * alpha-variance cue is sensitive enough that an ordinary soft edge's own
 * local variance can clear its default threshold too, without the
 * oscillation gating classical-edge-classifier.ts (Phase 5) applies to
 * suppress that specific false positive. This mostly doesn't distort the
 * *score* here in practice — an ordinary well-behaved soft edge is already
 * graded, so it still reports as "preserved" — but it does mean
 * `candidatePixelCount` can include some non-hair edge pixels, not only
 * genuine strand detail.
 */
export function analyzeHairPreservation(alpha: Float32Array, hairCandidateMask: Uint8Array): HairPreservationResult {
  let candidateCount = 0;
  let gradedCount = 0;
  for (let i = 0; i < hairCandidateMask.length; i++) {
    if (!hairCandidateMask[i]) continue;
    candidateCount++;
    if (alpha[i] > 0.04 && alpha[i] < 0.96) gradedCount++;
  }
  if (candidateCount === 0) return { score: 1, candidatePixelCount: 0, noHairDetected: true };
  return { score: gradedCount / candidateCount, candidatePixelCount: candidateCount, noHairDetected: false };
}

export interface AlphaDiscontinuityResult {
  /** 0 (many isolated value spikes) .. 1 (no salt-and-pepper discontinuities found). */
  score: number;
  spikeCount: number;
}

/**
 * Flags isolated single-pixel alpha "spikes" — a pixel whose value differs
 * sharply from ALL 8 neighbors at once — outside the UNKNOWN transition
 * band, where such a jump has no legitimate geometric explanation (a real
 * edge is expected to differ from *some* neighbors, not all of them; a
 * spike differing from every neighbor simultaneously is noise, not edge).
 */
export function analyzeAlphaDiscontinuity(alpha: Float32Array, trimap: Uint8Array, width: number, height: number, spikeThreshold = 0.25): AlphaDiscontinuityResult {
  let evaluated = 0;
  let spikes = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (trimap[i] === TrimapLabel.Unknown) continue; // genuine transitions live here — not evaluated for "discontinuity"
      evaluated++;
      const v = alpha[i];
      const neighbors = [
        alpha[i - width - 1], alpha[i - width], alpha[i - width + 1],
        alpha[i - 1], alpha[i + 1],
        alpha[i + width - 1], alpha[i + width], alpha[i + width + 1],
      ];
      const isSpike = neighbors.every((n) => Math.abs(n - v) > spikeThreshold);
      if (isSpike) spikes++;
    }
  }
  if (evaluated === 0) return { score: 1, spikeCount: 0 };
  return { score: 1 - rampToConfidence(spikes / evaluated, 0.02), spikeCount: spikes };
}

export interface ContaminationResult {
  /** 0 (no colour-contamination evidence) .. 1 (widespread). */
  score: number;
  pixelsAffected: number;
  sampleCount: number;
}

/**
 * Reuses decontaminate.ts's own closed-form unmixing purely as a read-only
 * measurement (the function is pure — it returns new arrays, never mutates
 * its input — so calling it here for analysis is safe even though this
 * engine never applies the correction itself).
 */
export function analyzeColourContamination(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
  options: DecontaminateOptions = DEFAULT_DECONTAMINATE_OPTIONS,
): ContaminationResult {
  let sampleCount = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] > options.loThreshold && alpha[i] < options.hiThreshold) sampleCount++;
  }
  if (sampleCount === 0) return { score: 0, pixelsAffected: 0, sampleCount: 0 };

  const result = decontaminate(rgba, alpha, width, height, options);
  const affected = result.pixelsDecontaminated + result.pixelsSuppressed;
  return { score: rampToConfidence(affected / sampleCount, 0.5), pixelsAffected: affected, sampleCount };
}

export interface ResolutionAdequacyResult {
  /** 0 (clearly too small) .. 1 (comfortably adequate). */
  score: number;
  minDimension: number;
  /** Whether fine-detail (hair-like) signal was present — resolution requirements are stricter when it is. */
  fineDetailPresent: boolean;
}

/**
 * Compares the shorter image dimension against two fixed thresholds — below
 * `lowThreshold` px is treated as clearly inadequate for a subject with any
 * fine detail, at/above `highThreshold` as comfortably adequate, linear
 * between. These thresholds are a documented engineering judgment call, not
 * a measured statistic — stated plainly rather than dressed up as more
 * precise than it is. When fine-detail signal is present, the whole curve
 * is shifted up (higher `highThreshold`), since preserving hair genuinely
 * needs more resolution than a plain silhouette does.
 */
export function analyzeResolutionAdequacy(
  width: number,
  height: number,
  fineDetailPresent: boolean,
  lowThreshold = 180,
  highThreshold = 720,
  highThresholdWithFineDetail = 1080,
): ResolutionAdequacyResult {
  const minDimension = Math.min(width, height);
  const effectiveHigh = fineDetailPresent ? highThresholdWithFineDetail : highThreshold;
  const score = effectiveHigh <= lowThreshold ? 1 : Math.min(1, Math.max(0, (minDimension - lowThreshold) / (effectiveHigh - lowThreshold)));
  return { score, minDimension, fineDetailPresent };
}
