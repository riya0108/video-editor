import { describe, it, expect } from "vitest";
import { refineEdgeBand, DEFAULT_EDGE_REFINE_OPTIONS } from "./edge-refine";

function makeRgbaWithVerticalEdge(width: number, height: number, splitX: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gray = x < splitX ? 30 : 220;
      rgba[i] = gray;
      rgba[i + 1] = gray;
      rgba[i + 2] = gray;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("refineEdgeBand", () => {
  it("leaves confidently-decided pixels (outside the boundary band) exactly unchanged", () => {
    const width = 12;
    const height = 8;
    const splitX = 6;
    const rgba = makeRgbaWithVerticalEdge(width, height, splitX);
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Hard interior/exterior, with a noisy boundary column right at the split.
        if (x < splitX - 1) alpha[y * width + x] = 0.02;
        else if (x > splitX) alpha[y * width + x] = 0.98;
        else alpha[y * width + x] = 0.5 + (y % 2 === 0 ? 0.1 : -0.1); // in the [0.05,0.95] band
      }
    }

    const out = refineEdgeBand(alpha, rgba, width, height, DEFAULT_EDGE_REFINE_OPTIONS);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x < splitX - 1 || x > splitX) {
          expect(out[i]).toBe(alpha[i]); // untouched, exactly
        }
      }
    }
  });

  it("keeps refined values continuous (0-1), not snapped to binary", () => {
    const width = 10;
    const height = 6;
    const rgba = makeRgbaWithVerticalEdge(width, height, 5);
    const alpha = new Float32Array(width * height).fill(0.5); // everything in-band
    const out = refineEdgeBand(alpha, rgba, width, height);
    let sawMidValue = false;
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > 0.05 && v < 0.95) sawMidValue = true;
    }
    expect(sawMidValue).toBe(true);
  });
});
