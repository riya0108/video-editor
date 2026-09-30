import type { QualityMetrics } from "./types";

const HISTOGRAM_BINS = 10;
/** Alpha gradient magnitude above this counts as "on a boundary" for the boundary-only metrics below — below it, two neighboring pixels are considered part of the same flat region, not an edge. */
const BOUNDARY_GRADIENT_THRESHOLD = 0.01;

/**
 * QUALITY ANALYSIS stage. Every number here is computed directly from the
 * actual alpha array passed in — there is no fixed/placeholder value and no
 * branch that returns a "looks fine" default. See MATTE_IMPLEMENTATION_PLAN.md
 * section 10 and this project's explicit "do not add fake quality metrics"
 * requirement.
 */
export function computeQualityMetrics(alpha: Float32Array, width: number, height: number): QualityMetrics {
  const total = width * height;
  if (total === 0) {
    return { coverageFraction: 0, softEdgeFraction: 0, edgeGradientEnergy: 0, alphaHistogramBimodality: 0 };
  }

  let foregroundCount = 0;
  let boundaryCount = 0;
  let softBoundaryCount = 0;
  let gradientSum = 0;
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = alpha[i];
      if (a > 0.5) foregroundCount++;

      const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(a * HISTOGRAM_BINS));
      histogram[bin]++;

      if (x < width - 1 && y < height - 1) {
        const gx = alpha[i + 1] - a;
        const gy = alpha[i + width] - a;
        const magnitude = Math.sqrt(gx * gx + gy * gy);
        if (magnitude > BOUNDARY_GRADIENT_THRESHOLD) {
          boundaryCount++;
          gradientSum += magnitude;
          if (a > 0.05 && a < 0.95) softBoundaryCount++;
        }
      }
    }
  }

  const extremeBinCount = histogram[0] + histogram[HISTOGRAM_BINS - 1];

  return {
    coverageFraction: foregroundCount / total,
    softEdgeFraction: boundaryCount > 0 ? softBoundaryCount / boundaryCount : 0,
    edgeGradientEnergy: boundaryCount > 0 ? gradientSum / boundaryCount : 0,
    alphaHistogramBimodality: extremeBinCount / total,
  };
}

/**
 * Derives a single 0-1 confidence value from the real quality metrics above
 * — documented formula, not a magic/opaque score: mostly
 * alphaHistogramBimodality (did the model commit to a clear foreground/
 * background split?), halved when coverage sits at an implausible extreme
 * (near-empty or near-full frame — usually a failed segmentation rather
 * than an unusually large or small real subject).
 */
export function computeConfidence(metrics: QualityMetrics): number {
  const impliesLikelyFailure = metrics.coverageFraction < 0.02 || metrics.coverageFraction > 0.98;
  const coveragePenalty = impliesLikelyFailure ? 0.5 : 1;
  return Math.min(1, Math.max(0, metrics.alphaHistogramBimodality * coveragePenalty));
}
