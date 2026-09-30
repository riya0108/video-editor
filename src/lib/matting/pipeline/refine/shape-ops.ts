/**
 * EDGE CONTRACTION/EXPANSION and SHIFT EDGE — two distinct ways to move an
 * alpha matte's boundary, both classical (no model, no license concern):
 *
 * - contractExpandAlpha: grayscale morphological erosion/dilation (the
 *   "choke"/"spread" tool professional keyers expose) — a local min/max
 *   filter that changes the boundary's SHAPE, not just a uniform per-pixel
 *   value shift. Radius scales with `amount`.
 * - shiftEdgeAlpha: a plain additive bias, clamped to [0,1] — moves where
 *   the 50% crossing falls along the existing transition without changing
 *   the transition's shape/width the way morphology does. Cheaper, and the
 *   right tool when only the crossing point (not the whole boundary
 *   geometry) needs to move.
 *
 * Both operate on the whole alpha map (not trimap-restricted) since moving
 * a boundary is inherently about the transition itself, not a targeted
 * cleanup — but neither is a blur: morphology preserves hard edges exactly
 * (min/max, not averaging) and shiftEdgeAlpha is a pure per-pixel remap.
 */

/** Separable 1D min/max pass — a rectangular structuring element's min/max IS exactly separable (unlike e.g. a true Euclidean-disk element), so a full 2D erosion/dilation is just this run horizontally then vertically. Edge pixels clamp to the image bounds (replicate, same convention as guided-filter.ts's boxBlur) rather than wrapping or padding with an artificial identity value. */
function morphPass(
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  pick: (a: number, b: number) => number,
): Float32Array {
  const out = new Float32Array(width * height);
  if (horizontal) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let best = data[row + x];
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          best = pick(best, data[row + nx]);
        }
        out[row + x] = best;
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let best = data[y * width + x];
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          best = pick(best, data[ny * width + x]);
        }
        out[y * width + x] = best;
      }
    }
  }
  return out;
}

function erodeAlpha(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = morphPass(alpha, width, height, radius, true, Math.min);
  return morphPass(horizontal, width, height, radius, false, Math.min);
}

function dilateAlpha(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = morphPass(alpha, width, height, radius, true, Math.max);
  return morphPass(horizontal, width, height, radius, false, Math.max);
}

/**
 * `amount` > 0 expands/dilates (grows the foreground, "spread"); < 0
 * contracts/erodes (shrinks the foreground, "choke"); 0 is a no-op (returns
 * a copy). The morphological radius is `round(|amount|)` pixels.
 */
export function contractExpandAlpha(alpha: Float32Array, width: number, height: number, amount: number): Float32Array {
  const radius = Math.round(Math.abs(amount));
  if (radius <= 0) return alpha.slice();
  return amount > 0 ? dilateAlpha(alpha, width, height, radius) : erodeAlpha(alpha, width, height, radius);
}

/**
 * Shifts every alpha value by a flat `bias` (positive grows the matte,
 * negative shrinks it), clamped to [0,1]. Unlike contractExpandAlpha this
 * doesn't reshape the transition — a linear ramp stays the same width, just
 * relocated — which is the right tool when only the boundary's position
 * (not its softness) needs adjusting.
 */
export function shiftEdgeAlpha(alpha: Float32Array, bias: number): Float32Array {
  if (bias === 0) return alpha.slice();
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    out[i] = Math.min(1, Math.max(0, alpha[i] + bias));
  }
  return out;
}
