import { describe, it, expect } from "vitest";
import { computeBoundingBox } from "./bounding-box";

describe("computeBoundingBox", () => {
  it("returns null when nothing clears the threshold", () => {
    const alpha = new Float32Array(5 * 5).fill(0);
    expect(computeBoundingBox(alpha, 5, 5)).toBeNull();
  });

  it("returns a full-image box when everything is foreground", () => {
    const alpha = new Float32Array(5 * 5).fill(1);
    expect(computeBoundingBox(alpha, 5, 5)).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });

  it("tightly bounds a single foreground region", () => {
    const width = 6;
    const height = 6;
    const alpha = new Float32Array(width * height).fill(0);
    // A 2x3 block of foreground at (2,1)-(3,3).
    for (let y = 1; y <= 3; y++) {
      for (let x = 2; x <= 3; x++) alpha[y * width + x] = 1;
    }
    expect(computeBoundingBox(alpha, width, height)).toEqual({ x: 2, y: 1, width: 2, height: 3 });
  });

  it("respects a custom threshold", () => {
    const alpha = new Float32Array([0.1, 0.3, 0.6, 0.9]);
    expect(computeBoundingBox(alpha, 2, 2, 0.5)).toEqual({ x: 0, y: 1, width: 2, height: 1 });
    expect(computeBoundingBox(alpha, 2, 2, 0.05)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });
});
