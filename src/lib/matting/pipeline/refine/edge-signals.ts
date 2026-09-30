import { boxBlur } from "../guided-filter";
import { TrimapLabel } from "./trimap";

/**
 * Classical (no model) signal primitives shared by classical-edge-classifier.ts.
 * Separated from the classifier itself so each signal is independently
 * testable, and so a future classifier can reuse whichever of these are
 * still useful without inheriting the classical classifier's specific
 * scoring/decision logic.
 */

/** Sobel gradient magnitude of the alpha field itself (native 0..1 alpha units, not rescaled) — the direct HARD_EDGE (steep) vs SOFT_EDGE/TRANSLUCENT (shallow) discriminator. Border pixels are 0, same convention as trimap.ts's buildFineDetailMask. */
export function computeAlphaGradientMagnitude(alpha: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const nw = alpha[i - width - 1];
      const n = alpha[i - width];
      const ne = alpha[i - width + 1];
      const w = alpha[i - 1];
      const e = alpha[i + 1];
      const sw = alpha[i + width - 1];
      const s = alpha[i + width];
      const se = alpha[i + width + 1];
      const gx = -nw - 2 * w - sw + ne + 2 * e + se;
      const gy = -nw - 2 * n - ne + sw + 2 * s + se;
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** Local 0..1 density of a binary mask over a `(2*radius+1)`-square window — the shared "is this a sparse, isolated signal or a dense, area-filling one" primitive behind HAIR-vs-FUR and a wide-vs-narrow transition band (motion blur / soft edge vs hard edge). */
export function computeLocalDensity(mask: Uint8Array, width: number, height: number, radius: number): Float32Array {
  const asFloat = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) asFloat[i] = mask[i];
  return boxBlur(asFloat, width, height, radius);
}

/**
 * Local image-gradient anisotropy via a classical structure tensor (a real,
 * well-established technique — not specific to any one model — used for
 * coherent-orientation detection in optical flow and texture analysis):
 * 0 = the local gradient is isotropic (no dominant direction, e.g. flat
 * texture or a corner), 1 = the local gradient is strongly aligned along a
 * single direction. A directionally-smeared motion-blur streak reads as
 * high anisotropy over a WIDE neighborhood; ordinary edges are directional
 * too but over a much narrower one — classical-edge-classifier.ts combines
 * this with band-width, not anisotropy alone, for that reason.
 */
export function computeStructureTensorAnisotropy(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const n = width * height;
  const luminance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    luminance[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }

  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const nw = luminance[i - width - 1];
      const nn = luminance[i - width];
      const ne = luminance[i - width + 1];
      const w = luminance[i - 1];
      const e = luminance[i + 1];
      const sw = luminance[i + width - 1];
      const s = luminance[i + width];
      const se = luminance[i + width + 1];
      gx[i] = -nw - 2 * w - sw + ne + 2 * e + se;
      gy[i] = -nw - 2 * nn - ne + sw + 2 * s + se;
    }
  }

  const ixx = new Float32Array(n);
  const iyy = new Float32Array(n);
  const ixy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ixx[i] = gx[i] * gx[i];
    iyy[i] = gy[i] * gy[i];
    ixy[i] = gx[i] * gy[i];
  }

  const sxx = boxBlur(ixx, width, height, radius);
  const syy = boxBlur(iyy, width, height, radius);
  const sxy = boxBlur(ixy, width, height, radius);

  const anisotropy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const trace = sxx[i] + syy[i];
    if (trace <= 1e-6) continue; // no gradient energy at all here — leave at 0 rather than divide by ~0
    const diff = sxx[i] - syy[i];
    const discriminant = Math.sqrt(diff * diff + 4 * sxy[i] * sxy[i]);
    const lambda1 = (trace + discriminant) / 2;
    const lambda2 = (trace - discriminant) / 2;
    anisotropy[i] = (lambda1 - lambda2) / (lambda1 + lambda2 + 1e-6);
  }
  return anisotropy;
}

export interface Chromaticity {
  /** R / (R+G+B), epsilon-guarded. */
  rNorm: Float32Array;
  /** G / (R+G+B), epsilon-guarded. */
  gNorm: Float32Array;
  /** Standard-weighted luminance, 0-255 scale. */
  luminance: Float32Array;
}

/** Normalized-chromaticity + luminance decomposition — the classical "shadows preserve chromaticity, reduce luminance" cue (well established in shadow-detection literature) needs the two separated, not a single RGB distance. */
export function computeChromaticity(rgba: Uint8ClampedArray, width: number, height: number): Chromaticity {
  const n = width * height;
  const rNorm = new Float32Array(n);
  const gNorm = new Float32Array(n);
  const luminance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const sum = r + g + b + 1e-3;
    rNorm[i] = r / sum;
    gNorm[i] = g / sum;
    luminance[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { rNorm, gNorm, luminance };
}

/** Euclidean distance in (rNorm, gNorm) chromaticity space — small means "same hue, different brightness", which is exactly the shadow/reflection signature this module's two chromaticity-comparison cues are built on. */
export function chromaticityDistance(rNorm1: number, gNorm1: number, rNorm2: number, gNorm2: number): number {
  const dr = rNorm1 - rNorm2;
  const dg = gNorm1 - gNorm2;
  return Math.sqrt(dr * dr + dg * dg);
}

/**
 * Expanding-ring search for the average colour of nearby CONFIDENT
 * FOREGROUND pixels (trimap === Foreground) — the REFLECTION cue's
 * equivalent of decontaminate.ts's estimateLocalBackground, just targeting
 * the opposite trimap label. Returns null (never a guess) if none is found
 * within `maxRadius`.
 */
export function estimateNearbyForegroundColor(
  rgba: Uint8ClampedArray,
  trimap: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  maxRadius: number,
): [number, number, number] | null {
  for (let r = 1; r <= maxRadius; r++) {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;
    for (let dy = -r; dy <= r; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const ni = ny * width + nx;
        if (trimap[ni] !== TrimapLabel.Foreground) continue;
        const o = ni * 4;
        sumR += rgba[o];
        sumG += rgba[o + 1];
        sumB += rgba[o + 2];
        count++;
      }
    }
    if (count > 0) return [sumR / count, sumG / count, sumB / count];
  }
  return null;
}

/**
 * (local max - local min) of `alpha` over a `(2*radius+1)`-square window —
 * distinguishes a genuine TRANSLUCENT plateau from the midpoint of a
 * SOFT_EDGE ramp. Both read as "low LOCAL gradient" at any single pixel
 * (that's what makes a transition "soft" at all), but a true plateau stays
 * near the same mid-value across a WIDER window too, while a ramp's midpoint
 * has already drifted meaningfully toward one extreme or the other by the
 * time the window is a few pixels wider — so its range over that same
 * window is much larger. Not separable (unlike guided-filter.ts's boxBlur)
 * since min/max, unlike sums, aren't linear — a plain windowed scan is
 * simple and fast enough at the resolutions this classifier runs at.
 */
export function computeLocalAlphaRange(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 1;
      let max = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          const v = alpha[ny * width + nx];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      out[y * width + x] = max - min;
    }
  }
  return out;
}

/**
 * How often the sign of alpha's first difference flips within a
 * `(2*radius+1)` window, scanned horizontally and vertically through the
 * pixel, normalized to 0..1 — the genuine "hair strand alternation"
 * signature (up/down/up/down as the scan crosses strand after strand), as
 * opposed to a monotonic ramp or hard step, which only ever changes
 * direction zero or one time no matter how wide the window is.
 *
 * This matters because plain variance (hair-detector.ts's alpha-variance
 * cue) *cannot* tell these apart — a single clean 0-to-1 step has just as
 * much local spread of values as an oscillating strand pattern does. Found
 * while building classical-edge-classifier.ts's HARD_EDGE test: without
 * this check, hair-detector.ts's own confidence would flag every hard edge
 * as hair-like too, since it was only ever designed (Phase 3) to ask "is
 * there real structure here", not "is that structure a single step or many
 * alternations" — a distinction Phase 3 never needed but Phase 5's
 * classification does.
 *
 * Deliberately a *forward* difference (alpha[x+1]-alpha[x]), not a central
 * one (alpha[x+1]-alpha[x-1]): a central difference spans 2 pixels and goes
 * numerically blind to a period-2 alternating pattern for exactly the same
 * reason a 3-wide Sobel kernel does (see trimap.test.ts's makeNoisyRgba
 * comment from Phase 2 for the general phenomenon) — its two sample points
 * land on the *same* phase of the oscillation one full period apart. A
 * forward difference samples every adjacent pair and has no such blind spot.
 */
export function computeAlphaOscillationDensity(alpha: Float32Array, width: number, height: number, radius: number): Float32Array {
  const n = width * height;
  const diffX = new Float32Array(n);
  const diffY = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      diffX[i] = x < width - 1 ? alpha[i + 1] - alpha[i] : 0;
      diffY[i] = y < height - 1 ? alpha[i + width] - alpha[i] : 0;
    }
  }

  const EPS = 1e-4;
  const isOppositeSign = (a: number, b: number) => (a > EPS && b < -EPS) || (a < -EPS && b > EPS);

  const out = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let flips = 0;
      let samples = 0;
      for (let dx = -radius; dx < radius; dx++) {
        const x0 = Math.min(width - 1, Math.max(0, x + dx));
        const x1 = Math.min(width - 1, Math.max(0, x + dx + 1));
        if (x0 === x1) continue;
        samples++;
        if (isOppositeSign(diffX[y * width + x0], diffX[y * width + x1])) flips++;
      }
      for (let dy = -radius; dy < radius; dy++) {
        const y0 = Math.min(height - 1, Math.max(0, y + dy));
        const y1 = Math.min(height - 1, Math.max(0, y + dy + 1));
        if (y0 === y1) continue;
        samples++;
        if (isOppositeSign(diffY[y0 * width + x], diffY[y1 * width + x])) flips++;
      }
      out[y * width + x] = samples > 0 ? flips / samples : 0;
    }
  }
  return out;
}

/** Linear ramp from 0 to 1, saturating at `threshold` — same convention as hair-detector.ts's rampToConfidence. */
export function rampToConfidence(value: number, threshold: number): number {
  if (threshold <= 0) return value > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, value / threshold));
}
