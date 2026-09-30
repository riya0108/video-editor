/**
 * MANUAL MATTE REFINEMENT — Phase 6. Brush footprint math: pure, DOM-free
 * geometry that turns a stroke (a path of points plus size/hardness) into a
 * per-pixel 0..1 coverage map. Deliberately allocates only a bounding-box-
 * sized buffer, not a full-image one — this is the concrete mechanism
 * behind "do not require the entire image to be recomputed after every
 * brush stroke": a stroke's cost scales with the stroke's own extent, never
 * with image resolution.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BrushStampOptions {
  /** Brush radius, in image pixels. */
  size: number;
  /**
   * 0 (fully soft — falls off linearly from full strength at the center to
   * zero at the radius) to 1 (hard-edged — full strength everywhere inside
   * the radius, a step to zero outside it). Values between interpolate a
   * flat-top plateau: the pixel is at full strength out to
   * `size * hardness`, then ramps linearly to zero at `size`.
   */
  hardness: number;
}

export interface StrokeCoverage {
  /** width*height coverage values (0..1), row-major, LOCAL to this bounding box — not the full image. */
  coverage: Float32Array;
  /** Bounding box in image coordinates, inclusive, already clamped to the image bounds. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Per-point falloff at Euclidean distance `d` from the stamp center — see BrushStampOptions.hardness's doc comment for the shape. */
function stampFalloff(d: number, size: number, hardness: number): number {
  if (d >= size) return 0;
  const plateau = size * Math.min(1, Math.max(0, hardness));
  if (d <= plateau) return 1;
  if (size <= plateau) return 1; // hardness effectively 1 — no ramp region
  return 1 - (d - plateau) / (size - plateau);
}

/**
 * Rasterizes a stroke (path of points, all sharing one size/hardness) into a
 * LOCAL coverage buffer covering just the stroke's own bounding box (plus
 * the brush radius) intersected with the image bounds. Coverage at each
 * pixel is the MAX falloff over every point on the path — the standard
 * "no self-darkening" behavior for a single continuous stroke (separate
 * strokes still stack, since each is applied to the underlying layer via
 * ManualRefinementEngine.applyStroke, not merged into one coverage pass).
 * Returns null for an empty path or a stroke that falls entirely outside
 * the image.
 */
export function computeStrokeCoverage(path: Point[], imageWidth: number, imageHeight: number, options: BrushStampOptions): StrokeCoverage | null {
  if (path.length === 0 || options.size <= 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x - options.size);
    minY = Math.min(minY, p.y - options.size);
    maxX = Math.max(maxX, p.x + options.size);
    maxY = Math.max(maxY, p.y + options.size);
  }

  const clampedMinX = Math.max(0, Math.floor(minX));
  const clampedMinY = Math.max(0, Math.floor(minY));
  const clampedMaxX = Math.min(imageWidth - 1, Math.ceil(maxX));
  const clampedMaxY = Math.min(imageHeight - 1, Math.ceil(maxY));
  if (clampedMaxX < clampedMinX || clampedMaxY < clampedMinY) return null; // entirely off-canvas

  const boxWidth = clampedMaxX - clampedMinX + 1;
  const boxHeight = clampedMaxY - clampedMinY + 1;
  const coverage = new Float32Array(boxWidth * boxHeight);

  for (let y = 0; y < boxHeight; y++) {
    const imgY = clampedMinY + y;
    for (let x = 0; x < boxWidth; x++) {
      const imgX = clampedMinX + x;
      let best = 0;
      for (const p of path) {
        const d = Math.hypot(imgX - p.x, imgY - p.y);
        const v = stampFalloff(d, options.size, options.hardness);
        if (v > best) best = v;
      }
      coverage[y * boxWidth + x] = best;
    }
  }

  return { coverage, minX: clampedMinX, minY: clampedMinY, maxX: clampedMaxX, maxY: clampedMaxY, width: boxWidth, height: boxHeight };
}
