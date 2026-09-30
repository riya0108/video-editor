/**
 * The only DOM-touching code in the pipeline — every function here creates a
 * brand-new canvas and only ever *reads* from the caller's `source`
 * (ctx.drawImage never mutates its source), so the original image is never
 * overwritten (requirements 1/2). Not unit-tested under Vitest (no canvas
 * implementation in this repo's plain Node test environment) — verified
 * manually in-browser instead, see the phase report's "tests performed".
 */

/** Reads `source` into a fresh RGBA buffer at exactly `width`x`height`, without ever writing back to `source` itself. */
export function drawSourceToRgba(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context is not available in this environment.");
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/** TRANSPARENT OUTPUT stage: composites decontaminated RGB + final alpha into a brand-new canvas with real per-pixel transparency — never reuses or writes into any canvas the caller passed in. */
export function compositeTransparentForeground(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const out = new Uint8ClampedArray(rgba.length);
  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    out[o] = rgba[o];
    out[o + 1] = rgba[o + 1];
    out[o + 2] = rgba[o + 2];
    out[o + 3] = Math.round(Math.min(1, Math.max(0, alpha[i])) * 255);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available in this environment.");
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
  return canvas;
}
