import { guidedFilterAlpha } from "./guided-filter";

export interface EdgeRefineOptions {
  /** Alpha values strictly between these two thresholds are considered "on the boundary" and eligible for the focused refinement pass below; values outside it (confidently foreground or background already) are left untouched. */
  loThreshold: number;
  hiThreshold: number;
  /** Smaller than the broad alpha-refinement pass's own radius — this pass is meant to sharpen the boundary, not re-smooth the whole image. */
  radius: number;
  eps: number;
}

export const DEFAULT_EDGE_REFINE_OPTIONS: EdgeRefineOptions = {
  loThreshold: 0.05,
  hiThreshold: 0.95,
  radius: 2,
  eps: 1e-4,
};

/**
 * EDGE REFINEMENT stage — distinct from the broader ALPHA REFINEMENT pass
 * (guided-filter.ts): runs a second, smaller-radius guided filter and blends
 * it in ONLY at pixels already sitting in the soft boundary band, leaving
 * pixels the model was already confident about (near 0 or near 1)
 * completely unchanged. This is what keeps refinement targeted at edges
 * (hair, motion blur, fabric) instead of re-processing the whole frame a
 * second time. See MATTE_IMPLEMENTATION_PLAN.md section 7-8.
 */
export function refineEdgeBand(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: EdgeRefineOptions = DEFAULT_EDGE_REFINE_OPTIONS,
): Float32Array {
  const fine = guidedFilterAlpha(alpha, rgba, width, height, options.radius, options.eps);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const v = alpha[i];
    out[i] = v > options.loThreshold && v < options.hiThreshold ? fine[i] : v;
  }
  return out;
}
