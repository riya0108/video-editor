import { guidedFilterAlpha, boxBlur } from "../guided-filter";
import { TrimapLabel } from "./trimap";

/**
 * EDGE-AWARE SMOOTHING, FEATHER, and ANTI-ALIASING. All three are blur-
 * family operations, and all three are restricted to the UNKNOWN trimap
 * band via blendWhereUnknown below — interior foreground/background pixels
 * are copied through untouched. This is the concrete mechanism behind "do
 * not apply global blur to the entire alpha; refinement must be edge-aware":
 * there is no code path in this module that blurs a pixel the trimap has
 * already confidently classified.
 */

/** Copies `modified` into `original` only where the trimap says UNKNOWN — every other pixel keeps its exact original value (not even re-quantized), so the blur-family operations below can never touch interior foreground/background. */
function blendWhereUnknown(original: Float32Array, modified: Float32Array, trimap: Uint8Array): Float32Array {
  const out = new Float32Array(original.length);
  for (let i = 0; i < original.length; i++) {
    out[i] = trimap[i] === TrimapLabel.Unknown ? modified[i] : original[i];
  }
  return out;
}

export interface SmoothOptions {
  radius: number;
  eps: number;
}

/** General-purpose edge-aware smoothing — the guided filter (see guided-filter.ts), restricted to the unknown band. */
export function smoothAlpha(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  trimap: Uint8Array,
  options: SmoothOptions,
): Float32Array {
  if (options.radius <= 0) return alpha.slice();
  const smoothed = guidedFilterAlpha(alpha, rgba, width, height, options.radius, options.eps);
  return blendWhereUnknown(alpha, smoothed, trimap);
}

/** Widens the transition band with a plain (non-guided) box blur, restricted to the unknown band — the classic "feather" control. Larger radius = softer/wider edge. 0 = no-op. */
export function featherAlpha(alpha: Float32Array, width: number, height: number, trimap: Uint8Array, radius: number): Float32Array {
  if (radius <= 0) return alpha.slice();
  const blurred = boxBlur(alpha, width, height, radius);
  return blendWhereUnknown(alpha, blurred, trimap);
}

/** A very light box blur restricted to the unknown band, meant to smooth out residual staircase/quantization artifacts from upsampling or earlier refinement passes — not a general smoothing tool (see smoothAlpha for that). */
export function antiAliasAlpha(alpha: Float32Array, width: number, height: number, trimap: Uint8Array, radius = 1): Float32Array {
  if (radius <= 0) return alpha.slice();
  const blurred = boxBlur(alpha, width, height, radius);
  return blendWhereUnknown(alpha, blurred, trimap);
}
