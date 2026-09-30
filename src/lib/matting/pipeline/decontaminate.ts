/**
 * COLOUR DECONTAMINATION stage. A semi-transparent alpha pixel's observed
 * RGB is a blend of the true foreground color and whatever background
 * showed through — compositing it as-is onto a *new* background produces a
 * visible fringe (the classic green-screen "green fringe on hair" problem;
 * ffmpeg's `despill` filter already solves this for the chroma-key path
 * elsewhere in this app — see src/lib/ffmpeg/bg-removal-command.ts). This is
 * the AI-matte equivalent: classical closed-form unmixing, no model, no
 * licensing concern. See MATTE_IMPLEMENTATION_PLAN.md section 9.
 *
 * Also does double duty as an alpha-consistency check (see suppressDistance
 * below) — a real defect found via live testing against U²-Net, not a
 * hypothetical: a segmentation-class model (see types.ts's ModelClass doc
 * comment — this is exactly the "don't trust a segmentation model's output
 * as a finished matte" warning made concrete) can assign a low but nonzero
 * "maybe foreground" confidence to a band of pixels that are, in reality,
 * 100% background with no real foreground blended in at all — confirmed by
 * inspecting a real model run directly, not assumed. Unmixing such a pixel
 * can only ever reproduce the background color as "foreground" (there is no
 * other signal to recover), which then renders as a faint but visible
 * background-colored fringe once composited. Suppressing alpha at exactly
 * the pixels where this happens is a principled fix, not cosmetic
 * papering-over: it only fires when the unmixing math itself proves there's
 * no real foreground signal to preserve.
 */

export interface DecontaminateOptions {
  /** Alpha at or below this is treated as "definitely background" — a candidate source for local background color estimation, and skipped as a decontamination target itself. */
  loThreshold: number;
  /** Alpha at or above this is treated as "definitely foreground" — skipped as a decontamination target (nothing to unmix). */
  hiThreshold: number;
  /** How far out (in pixels) to search for a nearby background-colored pixel before giving up on that pixel. Kept small deliberately: this is an O(width*height*searchRadius^2) scan in the worst case, and this phase does not implement a smarter/precomputed background field — see the "known limitations" note above. */
  searchRadius: number;
  /** Euclidean RGB distance (0-441.67) below which the unmixed "foreground" color is considered indistinguishable from the local background — i.e. there was no real foreground signal at this pixel, so its alpha is suppressed to 0 rather than left as a faint background-colored fringe. */
  suppressDistance: number;
}

export const DEFAULT_DECONTAMINATE_OPTIONS: DecontaminateOptions = {
  loThreshold: 0.02,
  hiThreshold: 0.98,
  searchRadius: 4,
  suppressDistance: 30,
};

export interface DecontaminateResult {
  /** Same length/layout as the input rgba. Pixels outside the [loThreshold, hiThreshold] band, any in-band pixel with no nearby background sample found, and any suppressed pixel (see `alpha` below) are copied through unchanged. */
  rgba: Uint8ClampedArray;
  /**
   * Same length/layout as the input alpha — identical to it, except at
   * pixels where unmixing proved there was no real foreground signal (see
   * the module doc comment), which are set to 0 here. Callers should use
   * THIS alpha, not the one they passed in, for everything downstream
   * (quality metrics, bounding box, final compositing).
   */
  alpha: Float32Array;
  /** How many pixels had their color actually rewritten — surfaced so a caller can honestly report "nothing to decontaminate" rather than silently no-op. */
  pixelsDecontaminated: number;
  /** How many pixels had their alpha suppressed to 0 per the consistency check above. */
  pixelsSuppressed: number;
}

/**
 * Expanding-ring search for a nearby pixel the current alpha map considers
 * background (<=loThreshold), starting at radius 1 up to `maxRadius`.
 * Returns null (not a fabricated guess) if none is found — that pixel is
 * then left un-decontaminated by the caller. Exported so other modules that
 * need the same background estimate (e.g. refine/decontamination-engine.ts's
 * Phase 4 halo/saturation safeguards, which need the raw pre-clamp estimate
 * this function's caller derives it from) don't have to duplicate the
 * ring-search algorithm.
 */
export function estimateLocalBackground(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  x: number,
  y: number,
  width: number,
  height: number,
  loThreshold: number,
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
        // Only the current ring, not the whole filled square, so each
        // radius only pays for its own new pixels rather than rescanning
        // everything from radius 1.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const ni = ny * width + nx;
        if (alpha[ni] > loThreshold) continue;
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

export function decontaminate(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
  options: DecontaminateOptions = DEFAULT_DECONTAMINATE_OPTIONS,
): DecontaminateResult {
  const outRgba = Uint8ClampedArray.from(rgba);
  const outAlpha = Float32Array.from(alpha);
  let pixelsDecontaminated = 0;
  let pixelsSuppressed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = alpha[i];
      if (a <= options.loThreshold || a >= options.hiThreshold) continue;

      const bg = estimateLocalBackground(rgba, alpha, x, y, width, height, options.loThreshold, options.searchRadius);
      if (!bg) continue; // no nearby background sample — leave as observed rather than guess

      const o = i * 4;
      const estimated: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const observed = rgba[o + c];
        const estimatedForeground = (observed - (1 - a) * bg[c]) / a;
        estimated[c] = Math.min(255, Math.max(0, Math.round(estimatedForeground)));
      }

      const dr = estimated[0] - bg[0];
      const dg = estimated[1] - bg[1];
      const db = estimated[2] - bg[2];
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);

      if (distance < options.suppressDistance) {
        outAlpha[i] = 0;
        pixelsSuppressed++;
        continue;
      }

      outRgba[o] = estimated[0];
      outRgba[o + 1] = estimated[1];
      outRgba[o + 2] = estimated[2];
      pixelsDecontaminated++;
    }
  }

  return { rgba: outRgba, alpha: outAlpha, pixelsDecontaminated, pixelsSuppressed };
}
