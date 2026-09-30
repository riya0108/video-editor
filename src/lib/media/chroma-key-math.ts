/**
 * PRODUCTION READINESS (H4): the per-pixel color-distance/keying math used by
 * both `keyChromaForeground` (bg-removal-canvas.ts — the Remove Background
 * tool's default green-screen mode) and `drawChromaKeyed`
 * (chroma-key-canvas.ts — the main Video Editor's live chroma-key preview)
 * had zero unit test coverage; both inlined this same formula directly
 * inside a canvas-getImageData loop, which can't be unit-tested without a
 * DOM. Pulled out here as pure, DOM-free functions so the actual numerically
 * risky math — reachable by every non-AI (chroma-key) user, the tool's
 * default mode — has real regression coverage. Both call sites now call
 * these instead of inlining the formula, with no change in behavior.
 */

/**
 * Distance from (r,g,b) to the key color, normalized to roughly 0-1
 * (0 = exact match, ~1 = maximally different, e.g. pure black vs. pure
 * white), then mapped through the similarity/blend thresholds into a
 * foreground alpha: <= similarity is fully keyed out (alpha 0), fully past
 * similarity+blend is fully opaque (alpha 1), and the band between ramps
 * linearly — the same shape as ffmpeg's `colorkey` filter.
 */
export function chromaKeyAlpha(
  r: number,
  g: number,
  b: number,
  keyR: number,
  keyG: number,
  keyB: number,
  similarity: number,
  blend: number,
): number {
  const dr = r - keyR;
  const dg = g - keyG;
  const db = b - keyB;
  const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.6729559300637; // sqrt(255^2*3)
  const safeBlend = Math.max(blend, 0.0001);
  return Math.min(1, Math.max(0, (dist - similarity) / safeBlend));
}

/**
 * Bilinear-samples a (typically lower-resolution) confidence mask at a
 * source-image pixel coordinate, so mask edges stay soft/anti-aliased
 * instead of blocky when upscaled to the source's resolution.
 */
export function bilinearSampleMask(maskData: Float32Array, maskWidth: number, maskHeight: number, x: number, y: number): number {
  const mx = Math.min(maskWidth - 1, x);
  const my = Math.min(maskHeight - 1, y);
  const mx0 = Math.floor(mx);
  const my0 = Math.floor(my);
  const mx1 = Math.min(maskWidth - 1, mx0 + 1);
  const my1 = Math.min(maskHeight - 1, my0 + 1);
  const fx = mx - mx0;
  const fy = my - my0;

  const v00 = maskData[my0 * maskWidth + mx0];
  const v10 = maskData[my0 * maskWidth + mx1];
  const v01 = maskData[my1 * maskWidth + mx0];
  const v11 = maskData[my1 * maskWidth + mx1];
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}
