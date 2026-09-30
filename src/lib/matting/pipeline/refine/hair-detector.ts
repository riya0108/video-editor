import { boxBlur } from "../guided-filter";
import { TrimapLabel } from "./trimap";

/**
 * HAIR / FINE-DETAIL CANDIDATE DETECTION — Phase 3 ("HAIR AND FINE DETAIL
 * REFINEMENT"). Flags pixels likely to be hair, fur, thin clothing edges,
 * loose strands, semi-transparent edges, or other small high-frequency
 * structure, so the rest of the hair-refinement pipeline (see
 * fine-detail-refiner.ts, hair-refinement.ts) can target them specifically
 * instead of processing the whole image uniformly.
 *
 * `buildFineDetailMask` in trimap.ts already does a coarser version of this
 * (single-channel luminance Sobel energy) for Phase 2's hole/island cleanup.
 * This module is deliberately more sensitive, and — critically — combines
 * TWO independent cues rather than one:
 *
 * 1. Multi-channel color gradient energy (not just luminance) — catches
 *    structure visible in hue/saturation even when luminance is nearly flat.
 * 2. Local alpha variance — catches structure already present in the matte
 *    itself, independent of how much contrast the source image has at all.
 *
 * The second cue is what makes "dark hair on a dark background" and "light
 * hair on a light background" tractable: when the source image genuinely
 * has little to no usable color contrast at a strand, there is no honest way
 * to invent contrast that isn't there (a classical filter can't hallucinate
 * signal), but a matting model's raw alpha very often still carries a faint
 * trace of the strand structure it detected even under low image contrast —
 * and that's a real, measurable signal this detector can pick up on. Where
 * *neither* cue shows any signal at all, there is genuinely nothing to
 * detect, and this module correctly reports low confidence rather than
 * fabricating a candidate.
 */

export interface HairDetectionOptions {
  /** Raw multi-channel Sobel gradient magnitude (0-255 scale, same units as trimap.ts's luminance-only version) at or above which the color cue reaches full (1.0) confidence. */
  colorEnergyThreshold: number;
  /** Window radius (pixels) used to estimate local alpha standard deviation. */
  alphaVarianceRadius: number;
  /** Local alpha standard deviation (0-1 scale) at or above which the alpha cue reaches full (1.0) confidence. */
  alphaVarianceThreshold: number;
  /** Combined confidence (max of the two cues, 0-1) at or above which a pixel is flagged as a hard candidate in `candidateMask`. */
  confidenceThreshold: number;
}

export const DEFAULT_HAIR_DETECTION_OPTIONS: HairDetectionOptions = {
  colorEnergyThreshold: 30,
  alphaVarianceRadius: 2,
  alphaVarianceThreshold: 0.05,
  confidenceThreshold: 0.5,
};

export interface HairDetectionResult {
  /** 0..1 per-pixel confidence — a genuine measurement (see module doc comment), never a fabricated or default-filled value. */
  confidence: Float32Array;
  /** `confidence >= options.confidenceThreshold`, as a 0/1 mask. */
  candidateMask: Uint8Array;
}

/** Per-channel Sobel gradient magnitude, taking the max across R/G/B at each pixel — more sensitive than a luminance-only measurement (trimap.ts's buildFineDetailMask) to structure that's visible in one channel/hue but washes out in luminance. Border pixels are left at 0, same convention as trimap.ts. */
function computeColorGradientEnergy(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const energy = new Float32Array(width * height);

  const sobelAt = (channel: number, i: number): number => {
    const o = channel;
    const nw = rgba[(i - width - 1) * 4 + o];
    const n = rgba[(i - width) * 4 + o];
    const ne = rgba[(i - width + 1) * 4 + o];
    const w = rgba[(i - 1) * 4 + o];
    const e = rgba[(i + 1) * 4 + o];
    const sw = rgba[(i + width - 1) * 4 + o];
    const s = rgba[(i + width) * 4 + o];
    const se = rgba[(i + width + 1) * 4 + o];
    const gx = -nw - 2 * w - sw + ne + 2 * e + se;
    const gy = -nw - 2 * n - ne + sw + 2 * s + se;
    return Math.sqrt(gx * gx + gy * gy);
  };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const r = sobelAt(0, i);
      const g = sobelAt(1, i);
      const b = sobelAt(2, i);
      energy[i] = Math.max(r, g, b);
    }
  }

  return energy;
}

/** Local standard deviation of `alpha` over a `(2*radius+1)`-square window, via boxBlur's separable sliding-window sums (E[x^2] - E[x]^2). Floating-point rounding can push the variance a hair below 0 for a perfectly flat window — clamped before the sqrt so that never produces NaN. */
function computeLocalAlphaStdDev(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return new Float32Array(alpha.length);
  const mean = boxBlur(alpha, width, height, radius);
  const alphaSq = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) alphaSq[i] = alpha[i] * alpha[i];
  const meanSq = boxBlur(alphaSq, width, height, radius);

  const stddev = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const variance = Math.max(0, meanSq[i] - mean[i] * mean[i]);
    stddev[i] = Math.sqrt(variance);
  }
  return stddev;
}

/** Linear ramp from 0 to 1, saturating at `threshold` — `value >= threshold` reaches full confidence rather than requiring an arbitrary multiple of it. */
function rampToConfidence(value: number, threshold: number): number {
  if (threshold <= 0) return value > 0 ? 1 : 0;
  return Math.min(1, value / threshold);
}

/**
 * Detects hair/fur/thin-structure candidates by combining the color-gradient
 * and alpha-variance cues with a max (either cue alone is sufficient
 * evidence — see module doc comment for why both are needed independently).
 * Deliberately NOT restricted by trimap label, for the same reason
 * documented on trimap.ts's buildFineDetailMask: real hair is very often
 * confidently opaque (trimap FOREGROUND) while still being thin and
 * disconnected, and restricting detection to the unknown band would miss it.
 */
export function detectHairCandidates(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: HairDetectionOptions = DEFAULT_HAIR_DETECTION_OPTIONS,
): HairDetectionResult {
  const colorEnergy = computeColorGradientEnergy(rgba, width, height);
  const alphaStdDev = computeLocalAlphaStdDev(alpha, width, height, options.alphaVarianceRadius);

  const confidence = new Float32Array(alpha.length);
  const candidateMask = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const colorSignal = rampToConfidence(colorEnergy[i], options.colorEnergyThreshold);
    const alphaSignal = rampToConfidence(alphaStdDev[i], options.alphaVarianceThreshold);
    const c = Math.max(colorSignal, alphaSignal);
    confidence[i] = c;
    candidateMask[i] = c >= options.confidenceThreshold ? 1 : 0;
  }

  return { confidence, candidateMask };
}

/** Separable binary dilation (0/1 max-filter) — same replicate-edge convention as guided-filter.ts's boxBlur and shape-ops.ts's morphology. Exported for reuse by hair-refinement.ts's local-refinement context margin. */
export function dilateBinaryMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();

  const temp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let best = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.min(width - 1, Math.max(0, x + dx));
        if (mask[row + nx]) {
          best = 1;
          break;
        }
      }
      temp[row + x] = best;
    }
  }

  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let best = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        if (temp[ny * width + x]) {
          best = 1;
          break;
        }
      }
      out[y * width + x] = best;
    }
  }

  return out;
}

export interface ExpandUnknownOptions {
  /** How far (pixels) to grow the unknown band around each detected candidate. */
  radius: number;
}

export const DEFAULT_EXPAND_UNKNOWN_OPTIONS: ExpandUnknownOptions = {
  radius: 2,
};

/**
 * "Expand the unknown region around them": dilates `candidateMask` and
 * promotes every pixel it now covers to TrimapLabel.Unknown, regardless of
 * what the base trimap classified it as. This is what lets a hair strand
 * the base trimap confidently called FOREGROUND (or BACKGROUND, for a
 * strand the model barely detected) receive the unknown-band-only local
 * refinement pass in fine-detail-refiner.ts, instead of being skipped as
 * "already confident" the way Phase 2's uniform smoothing would.
 */
export function expandUnknownAroundCandidates(
  trimap: Uint8Array,
  candidateMask: Uint8Array,
  width: number,
  height: number,
  options: ExpandUnknownOptions = DEFAULT_EXPAND_UNKNOWN_OPTIONS,
): Uint8Array {
  const grown = dilateBinaryMask(candidateMask, width, height, options.radius);
  const out = trimap.slice();
  for (let i = 0; i < out.length; i++) {
    if (grown[i]) out[i] = TrimapLabel.Unknown;
  }
  return out;
}
