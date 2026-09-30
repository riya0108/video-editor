import { describe, it, expect } from "vitest";
import { resizeAlphaBilinear } from "./alpha-resize";

describe("resizeAlphaBilinear", () => {
  it("returns a copy (not the same reference) when src and dst dimensions already match", () => {
    const src = new Float32Array([0, 1, 0.5, 0.25]);
    const out = resizeAlphaBilinear(src, 2, 2, 2, 2);
    expect(out).not.toBe(src);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("upsamples a 2x2 map to 4x4 and preserves the corner values exactly", () => {
    // 0 --- 1
    // |     |
    // 0 --- 1
    const src = new Float32Array([0, 1, 0, 1]);
    const out = resizeAlphaBilinear(src, 2, 2, 4, 4);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(0, 5); // top-left
    expect(out[3]).toBeCloseTo(1, 5); // top-right
  });

  it("produces continuous intermediate values, not a binary snap, across a soft gradient", () => {
    // A 1D ramp from 0 to 1 across a 5-wide row, repeated for 2 rows.
    const width = 5;
    const src = new Float32Array(width * 2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < width; x++) src[y * width + x] = x / (width - 1);
    }
    const out = resizeAlphaBilinear(src, width, 2, 10, 4);
    const middleRow = Array.from(out.slice(10, 20));
    const distinctValues = new Set(middleRow.map((v) => Math.round(v * 1000)));
    // A real bilinear ramp should produce more than just {0, 1} — this is
    // the resize stage's own contribution to "preserve soft edges, don't
    // threshold to binary" (requirements 5/6).
    expect(distinctValues.size).toBeGreaterThan(2);
    for (const v of middleRow) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("downsamples without throwing and stays within [the source's min, max]", () => {
    const src = new Float32Array(64 * 64);
    for (let i = 0; i < src.length; i++) src[i] = Math.random();
    const out = resizeAlphaBilinear(src, 64, 64, 16, 16);
    expect(out.length).toBe(256);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("handles degenerate zero-size requests without throwing", () => {
    const src = new Float32Array([1, 1, 1, 1]);
    expect(() => resizeAlphaBilinear(src, 2, 2, 0, 5)).not.toThrow();
    expect(resizeAlphaBilinear(src, 2, 2, 0, 5).length).toBe(0);
  });
});
