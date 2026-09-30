import type { BoundingBox } from "../pipeline/types";
import { TrimapLabel, buildTrimap, DEFAULT_TRIMAP_OPTIONS } from "../pipeline/refine/trimap";
import { labelConnectedComponents } from "../pipeline/refine/connected-components";
import { boundingBoxOfPixels } from "../pipeline/refine/matte-quality-signals";
import { rampToConfidence } from "../pipeline/refine/edge-signals";

/**
 * TEMPORAL QUALITY ANALYSIS — Phase 10. Individual, independently-testable
 * frame-to-frame measurement primitives. Every function computes its result
 * from two (or three, where genuine lookahead is unavoidable — see
 * temporal holes below) actual frames' real data — none returns a
 * placeholder or assumed-good default, mirroring Phase 7's matte-quality-
 * signals.ts "do not fabricate scores" discipline, now across time instead
 * of within one frame.
 *
 * Reuses Phase 7's connected-components/bounding-box primitives directly.
 * Hole and boundary MASKS (not just aggregate counts) are needed here to
 * compare frame-to-frame pixel-for-pixel — Phase 7's own
 * analyzeHolesAndIslands/analyzeEdgeContinuity only return aggregates, so
 * computeHoleMask/computeBoundaryMask below mirror their exact logic
 * independently rather than changing that module's public API for this
 * phase's sake.
 */

/** Binarized foreground (alpha > 0.5). */
export function computeForegroundMask(alpha: Float32Array, threshold = 0.5): Uint8Array {
  const mask = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) mask[i] = alpha[i] > threshold ? 1 : 0;
  return mask;
}

/** Mirrors matte-quality-signals.ts's analyzeHolesAndIslands hole detection exactly, but returns the per-pixel mask instead of aggregate stats — needed here to compare hole *location* frame to frame, not just hole count. */
export function computeHoleMask(alpha: Float32Array, width: number, height: number, binarizeThreshold = 0.5): Uint8Array {
  const foreground = computeForegroundMask(alpha, binarizeThreshold);
  const background = new Uint8Array(foreground.length);
  for (let i = 0; i < foreground.length; i++) background[i] = 1 - foreground[i];
  const components = labelConnectedComponents(background, width, height);
  const holeMask = new Uint8Array(foreground.length);
  for (let label = 0; label < components.sizes.length; label++) {
    if (components.touchesBorder[label]) continue;
    for (const i of components.pixelsByLabel[label]) holeMask[i] = 1;
  }
  return holeMask;
}

/** Mirrors classical-edge-classifier.ts's/matte-quality-signals.ts's trimap-boundary-adjacency fallback — a pixel is "on the boundary" if it's classified UNKNOWN or sits next to a pixel with a different trimap label. Returns the mask (not just a continuity score) so it can be diffed frame to frame for edge jitter. */
export function computeBoundaryMask(trimap: Uint8Array, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(trimap.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (trimap[i] === TrimapLabel.Unknown) {
        mask[i] = 1;
        continue;
      }
      const t = trimap[i];
      const differs =
        (x > 0 && trimap[i - 1] !== t) ||
        (x < width - 1 && trimap[i + 1] !== t) ||
        (y > 0 && trimap[i - width] !== t) ||
        (y < height - 1 && trimap[i + width] !== t);
      mask[i] = differs ? 1 : 0;
    }
  }
  return mask;
}

/** Convenience: trimap via Phase 2's buildTrimap, default thresholds — every signal function below takes the trimap/masks it needs directly so callers (the engine) can compute them once per frame and reuse across metrics. */
export function computeTrimap(alpha: Float32Array, width: number, height: number): Uint8Array {
  return buildTrimap(alpha, width, height, DEFAULT_TRIMAP_OPTIONS);
}

/** Per-pixel 0..1 local image motion between two frames — same mean-absolute-RGB-delta measurement Phase 9's TemporalMattingEngine uses, recomputed independently here since Phase 10 analyzes a frame sequence standalone (it doesn't assume Phase 9 produced it). */
export function computeMotionMask(rgba: Uint8ClampedArray, previousRgba: Uint8ClampedArray, threshold = 18): Float32Array {
  const n = rgba.length / 4;
  const motion = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const delta = (Math.abs(rgba[o] - previousRgba[o]) + Math.abs(rgba[o + 1] - previousRgba[o + 1]) + Math.abs(rgba[o + 2] - previousRgba[o + 2])) / 3;
    motion[i] = Math.min(1, delta / threshold);
  }
  return motion;
}

export function meanOf(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ---- 1. Alpha flicker ----

export interface AlphaFlickerResult {
  score: number;
  flickerPixelCount: number;
  sampleCount: number;
}

/**
 * Genuine oscillation, not a single jump: flags a LOW-image-motion pixel
 * whose alpha moved one way then reversed across three consecutive frames
 * (up-then-down or down-then-up) — the concrete signature of flicker, as
 * opposed to a real, sustained change which moves and *stays* moved.
 */
export function computeAlphaFlickerScore(
  alphaA: Float32Array,
  alphaB: Float32Array,
  alphaC: Float32Array,
  motionMask: Float32Array,
  minDelta = 0.15,
  motionGate = 0.15,
): AlphaFlickerResult {
  let sampleCount = 0;
  let flickerPixelCount = 0;
  for (let i = 0; i < alphaA.length; i++) {
    if (motionMask[i] >= motionGate) continue;
    sampleCount++;
    const d1 = alphaB[i] - alphaA[i];
    const d2 = alphaC[i] - alphaB[i];
    if (Math.abs(d1) > minDelta && Math.abs(d2) > minDelta && Math.sign(d1) !== Math.sign(d2)) flickerPixelCount++;
  }
  return { score: sampleCount > 0 ? flickerPixelCount / sampleCount : 0, flickerPixelCount, sampleCount };
}

// ---- 2. Edge jitter ----

export interface EdgeJitterResult {
  score: number;
  jitterPixelCount: number;
}

/** Symmetric difference of two frames' boundary masks, normalized by their union — the boundary moving/trembling shows up as pixels that are "on the edge" in exactly one of the two frames. */
export function computeEdgeJitterScore(previousBoundary: Uint8Array, currentBoundary: Uint8Array): EdgeJitterResult {
  let union = 0;
  let symmetricDiff = 0;
  for (let i = 0; i < previousBoundary.length; i++) {
    const p = previousBoundary[i];
    const c = currentBoundary[i];
    if (p || c) union++;
    if (p !== c) symmetricDiff++;
  }
  return { score: union > 0 ? symmetricDiff / union : 0, jitterPixelCount: symmetricDiff };
}

// ---- 3. Silhouette instability ----

export interface SilhouetteInstabilityResult {
  score: number;
  areaDeltaFraction: number;
}

/**
 * How much the foreground's total area changed, beyond what the frame's
 * OWN measured motion would plausibly explain — real motion legitimately
 * changes silhouette area (a subject turning, limbs moving); instability is
 * the EXCESS beyond a documented, generous allowance for that.
 */
export function computeSilhouetteInstabilityScore(previousArea: number, currentArea: number, meanMotion: number): SilhouetteInstabilityResult {
  const denom = Math.max(1, previousArea);
  const areaDeltaFraction = Math.abs(currentArea - previousArea) / denom;
  const expectedFromMotion = meanMotion * 0.5; // a generous, documented allowance — even at full-frame motion, up to ~50% area change is plausible before calling it unstable
  const excess = Math.max(0, areaDeltaFraction - expectedFromMotion);
  return { score: Math.min(1, excess / 0.3), areaDeltaFraction };
}

// ---- 4. Hair instability ----

export interface HairInstabilityResult {
  score: number;
  iou: number;
  noHairDetected: boolean;
}

/** 1 - IoU of two frames' hair-candidate masks (hair-detector.ts) — a stable strand structure stays roughly in the same place frame to frame; a flickering one doesn't. */
export function computeHairInstabilityScore(previousMask: Uint8Array, currentMask: Uint8Array): HairInstabilityResult {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < previousMask.length; i++) {
    const p = previousMask[i];
    const c = currentMask[i];
    if (p || c) union++;
    if (p && c) intersection++;
  }
  if (union === 0) return { score: 0, iou: 1, noHairDetected: true };
  const iou = intersection / union;
  return { score: 1 - iou, iou, noHairDetected: false };
}

// ---- 5. Sudden opacity changes ----

export interface SuddenOpacityChangeResult {
  score: number;
  count: number;
  regions: BoundingBox[];
}

/** A pixel whose alpha jumped by a lot despite near-zero measured image motion at that pixel — the same "artifact" signature Phase 9's engine flags in real time, recomputed here as its own standalone metric with actual affected regions surfaced (not just a count). */
export function computeSuddenOpacityChanges(
  previousAlpha: Float32Array,
  currentAlpha: Float32Array,
  motionMask: Float32Array,
  width: number,
  height: number,
  deltaThreshold = 0.4,
  motionGate = 0.2,
): SuddenOpacityChangeResult {
  const n = width * height;
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (motionMask[i] >= motionGate) continue;
    if (Math.abs(currentAlpha[i] - previousAlpha[i]) > deltaThreshold) {
      mask[i] = 1;
      count++;
    }
  }
  const regions: BoundingBox[] = [];
  if (count > 0) {
    const components = labelConnectedComponents(mask, width, height);
    for (const pixels of components.pixelsByLabel) if (pixels.length >= 2) regions.push(boundingBoxOfPixels(pixels, width));
  }
  return { score: rampToConfidence(count / n, 0.01), count, regions };
}

// ---- 6. Mask popping ----

export interface MaskPoppingResult {
  score: number;
  poppedInArea: number;
  poppedOutArea: number;
  regions: BoundingBox[];
}

/**
 * Component-level, not pixel-level: a whole spatially-coherent chunk of the
 * foreground appearing or vanishing between frames, as opposed to gradual
 * per-pixel change. A component with little-to-no spatial overlap with any
 * component in the other frame counts as "popped" — ordinary movement of an
 * existing blob still overlaps substantially frame to frame and is not
 * flagged.
 */
export function computeMaskPoppingScore(
  previousMask: Uint8Array,
  currentMask: Uint8Array,
  width: number,
  height: number,
  totalForegroundArea: number,
  overlapThreshold = 0.3,
): MaskPoppingResult {
  const previousComponents = labelConnectedComponents(previousMask, width, height);
  const currentComponents = labelConnectedComponents(currentMask, width, height);
  const regions: BoundingBox[] = [];
  let poppedInArea = 0;
  let poppedOutArea = 0;

  for (const pixels of currentComponents.pixelsByLabel) {
    let overlap = 0;
    for (const i of pixels) if (previousMask[i]) overlap++;
    if (overlap / pixels.length < overlapThreshold) {
      poppedInArea += pixels.length;
      regions.push(boundingBoxOfPixels(pixels, width));
    }
  }
  for (const pixels of previousComponents.pixelsByLabel) {
    let overlap = 0;
    for (const i of pixels) if (currentMask[i]) overlap++;
    if (overlap / pixels.length < overlapThreshold) {
      poppedOutArea += pixels.length;
      regions.push(boundingBoxOfPixels(pixels, width));
    }
  }

  const denom = Math.max(1, totalForegroundArea);
  return { score: Math.min(1, (poppedInArea + poppedOutArea) / denom), poppedInArea, poppedOutArea, regions };
}

// ---- 7. Temporal holes ----

export interface TemporalHoleResult {
  score: number;
  transientHoleArea: number;
  regions: BoundingBox[];
}

/**
 * A hole (enclosed background pocket within the foreground — same concept
 * as Phase 7's leakage) that exists in the CURRENT frame but in NEITHER
 * neighbor is transient — it flickered open and shut within a single frame,
 * rather than being a real, sustained gap. This genuinely needs one frame
 * of lookahead (the "next" mask) — see temporal-quality-engine.ts's small
 * bounded delay buffer.
 */
export function computeTemporalHolesScore(
  previousHoleMask: Uint8Array,
  currentHoleMask: Uint8Array,
  nextHoleMask: Uint8Array,
  width: number,
  currentForegroundArea: number,
): TemporalHoleResult {
  const n = currentHoleMask.length;
  const transientMask = new Uint8Array(n);
  let transientHoleArea = 0;
  for (let i = 0; i < n; i++) {
    if (currentHoleMask[i] && !previousHoleMask[i] && !nextHoleMask[i]) {
      transientMask[i] = 1;
      transientHoleArea++;
    }
  }
  const regions: BoundingBox[] = [];
  if (transientHoleArea > 0) {
    const height = n / width;
    const components = labelConnectedComponents(transientMask, width, height);
    for (const pixels of components.pixelsByLabel) if (pixels.length >= 2) regions.push(boundingBoxOfPixels(pixels, width));
  }
  const denom = Math.max(1, currentForegroundArea);
  return { score: Math.min(1, transientHoleArea / denom / 0.02), transientHoleArea, regions };
}

// ---- 8. Temporal leakage ----

export interface TemporalLeakageResult {
  score: number;
  variance: number;
  mean: number;
}

/** Volatility (variance) of Phase 7's own leakageScore over a short rolling window — stable leakage (even if nonzero) reads as a static property of the shot; leakage that swings frame to frame is the temporally unstable case this metric targets specifically. */
export function computeTemporalLeakageVolatility(leakageScoreHistory: number[]): TemporalLeakageResult {
  if (leakageScoreHistory.length < 2) return { score: 0, variance: 0, mean: leakageScoreHistory[0] ?? 0 };
  const mean = leakageScoreHistory.reduce((a, b) => a + b, 0) / leakageScoreHistory.length;
  const variance = leakageScoreHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / leakageScoreHistory.length;
  return { score: Math.min(1, variance / 0.02), variance, mean };
}
