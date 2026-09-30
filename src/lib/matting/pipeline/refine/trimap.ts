/**
 * Trimap + region classification — the foundation every other Phase 2
 * refinement operation builds on. Splits the alpha map into the three
 * classic matting regions (background/unknown/foreground), plus a
 * "fine-detail" flag within the unknown band, so refinement can be targeted
 * ("the unknown region should receive higher-quality refinement") instead
 * of applied uniformly across the whole image.
 */

export const enum TrimapLabel {
  Background = 0,
  Unknown = 1,
  Foreground = 2,
}

export interface TrimapOptions {
  /** Alpha at or below this is classified interior background. */
  backgroundThreshold: number;
  /** Alpha at or above this is classified interior foreground. */
  foregroundThreshold: number;
}

export const DEFAULT_TRIMAP_OPTIONS: TrimapOptions = {
  backgroundThreshold: 0.1,
  foregroundThreshold: 0.9,
};

/** Classifies every pixel as interior BACKGROUND, interior FOREGROUND, or UNKNOWN (the transition band). */
export function buildTrimap(
  alpha: Float32Array,
  width: number,
  height: number,
  options: TrimapOptions = DEFAULT_TRIMAP_OPTIONS,
): Uint8Array {
  const trimap = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    trimap[i] =
      a <= options.backgroundThreshold ? TrimapLabel.Background : a >= options.foregroundThreshold ? TrimapLabel.Foreground : TrimapLabel.Unknown;
  }
  return trimap;
}

export interface FineDetailOptions {
  /** Sobel gradient magnitude (on 0-255 luminance) above which an unknown-band pixel is classified as fine-detail (hair, fur, thin complex structure) rather than a plain soft edge. */
  energyThreshold: number;
}

export const DEFAULT_FINE_DETAIL_OPTIONS: FineDetailOptions = {
  energyThreshold: 40,
};

/**
 * Flags pixels that sit on high local image detail (a real Sobel-edge-
 * energy measurement on the source image's luminance, not a guess) — hair
 * strands, fur, complex thin structure. Downstream operations (see
 * cleanup.ts's small-island preservation) use this to avoid treating
 * genuine fine structure the same as noise.
 *
 * Deliberately NOT restricted by trimap label (unlike the blur-family
 * operations in smoothing-ops.ts): real hair/fur is very often confidently
 * *opaque* — trimap-classified FOREGROUND, not UNKNOWN — while still being
 * thin and disconnected in the alpha map (a single strand can be its own
 * tiny connected component). Fine-detail classification is about the
 * source image's own texture at that location, independent of how
 * confident the model's alpha was there.
 */
export function buildFineDetailMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: FineDetailOptions = DEFAULT_FINE_DETAIL_OPTIONS,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    luminance[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;

      const nw = luminance[i - width - 1];
      const n = luminance[i - width];
      const ne = luminance[i - width + 1];
      const w = luminance[i - 1];
      const e = luminance[i + 1];
      const sw = luminance[i + width - 1];
      const s = luminance[i + width];
      const se = luminance[i + width + 1];

      const gx = -nw - 2 * w - sw + ne + 2 * e + se;
      const gy = -nw - 2 * n - ne + sw + 2 * s + se;
      const energy = Math.sqrt(gx * gx + gy * gy);

      mask[i] = energy > options.energyThreshold ? 1 : 0;
    }
  }

  return mask;
}
