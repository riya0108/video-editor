import { labelConnectedComponents } from "../pipeline/refine/connected-components";

/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. Objective matting-quality metrics,
 * computed wherever ground truth is available (see dataset.ts/
 * video-dataset.ts — every case in this benchmark has exact synthetic
 * ground truth, but these functions take plain arrays so they work equally
 * against any future real-photo case that supplies one).
 *
 * Honesty note, stated once here rather than on every function: SAD/MSE/MAD
 * are the standard, unambiguous definitions. Gradient error and
 * connectivity error are named after (and inspired by) the metrics from
 * Rhemann et al., "A perceptually motivated online benchmark for image
 * matting" (2009, the alphamatting.com paper) — but this file does NOT
 * reproduce their exact formulas (Gaussian-derivative gradients at a tuned
 * sigma; multi-threshold connectivity integration). It uses simpler,
 * clearly-labeled approximations of the same idea (gradient error: Sobel
 * magnitude difference; connectivity error: single-threshold
 * connected-component overlap). Numbers from this file are therefore NOT
 * directly comparable to published alphamatting.com leaderboard numbers —
 * only to earlier runs of THIS SAME benchmark, which is exactly what Phase
 * 15 asks for ("measure improvement between versions").
 */

/** Sum of absolute per-pixel differences — the raw, unnormalized error total. */
export function sad(pred: Float32Array, gt: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pred.length; i++) sum += Math.abs(pred[i] - gt[i]);
  return sum;
}

/** Mean squared per-pixel difference. */
export function mse(pred: Float32Array, gt: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pred.length; i++) {
    const d = pred[i] - gt[i];
    sum += d * d;
  }
  return sum / pred.length;
}

/** Mean absolute per-pixel difference — SAD normalized by pixel count, distinct from SAD itself. */
export function mad(pred: Float32Array, gt: Float32Array): number {
  return sad(pred, gt) / pred.length;
}

/** 3x3 Sobel gradient magnitude at every pixel, with edge-clamped sampling. */
function sobelMagnitude(alpha: Float32Array, width: number, height: number): Float32Array {
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx = 0;
      let sy = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          const v = alpha[yy * width + xx];
          sx += v * gxKernel[k];
          sy += v * gyKernel[k];
          k++;
        }
      }
      out[y * width + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return out;
}

/** Mean squared difference between predicted and ground-truth gradient-magnitude maps — see this file's top-of-file honesty note: a simplified Sobel-based stand-in for the alphamatting.com gradient metric, not a reproduction of it. */
export function gradientError(pred: Float32Array, gt: Float32Array, width: number, height: number): number {
  const gp = sobelMagnitude(pred, width, height);
  const gg = sobelMagnitude(gt, width, height);
  let sum = 0;
  for (let i = 0; i < gp.length; i++) {
    const d = gp[i] - gg[i];
    sum += d * d;
  }
  return sum / gp.length;
}

/**
 * Fraction (0 = perfect, 1 = totally disconnected/missing) of ground
 * truth's largest foreground region that the prediction either misses
 * entirely or assigns to a DIFFERENT connected piece than its own largest
 * foreground region — i.e. real disconnection, not just an inaccurate edge.
 * See this file's top-of-file honesty note: a single-threshold,
 * single-level simplification of Rhemann et al.'s multi-level connectivity
 * metric, not a reproduction of it.
 */
export function connectivityError(pred: Float32Array, gt: Float32Array, width: number, height: number, threshold = 0.1): number {
  const predMask = new Uint8Array(pred.length);
  const gtMask = new Uint8Array(gt.length);
  for (let i = 0; i < pred.length; i++) {
    predMask[i] = pred[i] > threshold ? 1 : 0;
    gtMask[i] = gt[i] > threshold ? 1 : 0;
  }

  const gtComponents = labelConnectedComponents(gtMask, width, height);
  if (gtComponents.sizes.length === 0) return 0;
  let gtMainLabel = 0;
  for (let l = 1; l < gtComponents.sizes.length; l++) {
    if (gtComponents.sizes[l] > gtComponents.sizes[gtMainLabel]) gtMainLabel = l;
  }
  const gtMainPixels = gtComponents.pixelsByLabel[gtMainLabel];
  if (gtMainPixels.length === 0) return 0;

  const predComponents = labelConnectedComponents(predMask, width, height);
  let predMainLabel = -1;
  let predMainSize = -1;
  for (let l = 0; l < predComponents.sizes.length; l++) {
    if (predComponents.sizes[l] > predMainSize) {
      predMainSize = predComponents.sizes[l];
      predMainLabel = l;
    }
  }

  let disconnected = 0;
  for (const idx of gtMainPixels) {
    if (predMask[idx] === 0 || predComponents.labels[idx] !== predMainLabel) disconnected++;
  }
  return disconnected / gtMainPixels.length;
}

/**
 * Video only. Compares how much the PREDICTED alpha changes frame-to-frame
 * against how much the GROUND TRUTH changes frame-to-frame, and reports the
 * mean absolute difference between those two change-rates across the
 * sequence. Large values mean either flicker (prediction changes when
 * ground truth doesn't) or over-smoothing (prediction fails to track real
 * motion ground truth shows) — both are real temporal-consistency failures.
 * No optical flow / motion compensation is used — see this file's top-of-
 * file honesty note. A real scene cut (see video-dataset.ts's
 * "video-scene-cut" case) is EXPECTED to show a large value at the cut
 * frame; that is correct measurement behavior, not a flaw.
 */
export function temporalConsistencyError(predFrames: Float32Array[], gtFrames: Float32Array[]): number {
  if (predFrames.length !== gtFrames.length) throw new Error("temporalConsistencyError: frame count mismatch between prediction and ground truth.");
  if (predFrames.length < 2) return 0;
  let sum = 0;
  for (let t = 1; t < predFrames.length; t++) {
    const predDelta = mad(predFrames[t], predFrames[t - 1]);
    const gtDelta = mad(gtFrames[t], gtFrames[t - 1]);
    sum += Math.abs(predDelta - gtDelta);
  }
  return sum / (predFrames.length - 1);
}

export interface ImageMetrics {
  sad: number;
  mse: number;
  mad: number;
  gradientError: number;
  connectivityError: number;
}

/** Computes every still-image metric in one call against a matched-resolution prediction/ground-truth pair. */
export function computeImageMetrics(pred: Float32Array, gt: Float32Array, width: number, height: number): ImageMetrics {
  if (pred.length !== gt.length) throw new Error("computeImageMetrics: prediction and ground truth must be the same size.");
  return {
    sad: sad(pred, gt),
    mse: mse(pred, gt),
    mad: mad(pred, gt),
    gradientError: gradientError(pred, gt, width, height),
    connectivityError: connectivityError(pred, gt, width, height),
  };
}
