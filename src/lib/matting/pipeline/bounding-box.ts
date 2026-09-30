import type { BoundingBox } from "./types";

/** Tight box around every pixel with alpha above `threshold`, in source-image pixel coordinates. Returns null (not a zero-size box, which would be a fabricated "something was found" claim) when nothing clears the threshold. */
export function computeBoundingBox(alpha: Float32Array, width: number, height: number, threshold = 0.05): BoundingBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
