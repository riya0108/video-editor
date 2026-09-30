/**
 * Bilinear-resamples a continuous alpha map from the model's native output
 * resolution to any target resolution (typically the source image's). Pure
 * function, no DOM dependency — same bilinear math as
 * src/lib/media/bg-removal-canvas.ts's applyMaskForeground (kept as a
 * separate, standalone implementation here rather than refactoring that
 * file, per this phase's "additive, don't touch existing working code"
 * approach), factored out so it can be unit-tested and reused as its own
 * pipeline stage.
 */
export function resizeAlphaBilinear(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return src.slice();
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    return new Float32Array(Math.max(0, dstWidth) * Math.max(0, dstHeight));
  }

  const dst = new Float32Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;

  for (let y = 0; y < dstHeight; y++) {
    const sy = Math.min(srcHeight - 1, y * scaleY);
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < dstWidth; x++) {
      const sx = Math.min(srcWidth - 1, x * scaleX);
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const fx = sx - x0;

      const v00 = src[y0 * srcWidth + x0];
      const v10 = src[y0 * srcWidth + x1];
      const v01 = src[y1 * srcWidth + x0];
      const v11 = src[y1 * srcWidth + x1];

      const top = v00 + (v10 - v00) * fx;
      const bottom = v01 + (v11 - v01) * fx;
      dst[y * dstWidth + x] = top + (bottom - top) * fy;
    }
  }

  return dst;
}
