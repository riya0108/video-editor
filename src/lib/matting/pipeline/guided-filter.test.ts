import { describe, it, expect } from "vitest";
import { boxBlur, guidedFilterAlpha } from "./guided-filter";

function makeFlatRgba(width: number, height: number, gray: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("boxBlur", () => {
  it("leaves a perfectly flat field unchanged", () => {
    const width = 8;
    const height = 8;
    const data = new Float32Array(width * height).fill(0.5);
    const out = boxBlur(data, width, height, 2);
    for (const v of out) expect(v).toBeCloseTo(0.5, 5);
  });

  it("radius 0 returns an equivalent copy", () => {
    const data = new Float32Array([0, 1, 0.5, 0.25]);
    const out = boxBlur(data, 2, 2, 0);
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it("smooths a single spike toward its neighbors instead of leaving it isolated", () => {
    const width = 9;
    const height = 9;
    const data = new Float32Array(width * height).fill(0);
    data[4 * width + 4] = 1; // center spike
    const out = boxBlur(data, width, height, 2);
    // The spike's own value must have dropped (it's now averaged with its
    // zero neighbors) and a previously-zero neighbor must have picked up
    // some of it — that's what "blur" means here.
    expect(out[4 * width + 4]).toBeLessThan(1);
    expect(out[4 * width + 4]).toBeGreaterThan(0);
    expect(out[4 * width + 3]).toBeGreaterThan(0);
  });
});

describe("guidedFilterAlpha", () => {
  it("keeps output in [0,1] and does not collapse a soft edge to binary when the guide image is flat", () => {
    const width = 10;
    const height = 4;
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) alpha[y * width + x] = x / (width - 1); // a soft horizontal ramp
    }
    const rgba = makeFlatRgba(width, height, 128); // no edges in the guide at all

    const out = guidedFilterAlpha(alpha, rgba, width, height, 2, 1e-2);

    let sawMidValue = false;
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > 0.05 && v < 0.95) sawMidValue = true;
    }
    // Requirement 5/6: a real soft edge must survive as continuous values,
    // not get thresholded to {0,1}.
    expect(sawMidValue).toBe(true);
  });

  it("is close to a no-op when alpha is already flat and matches a flat guide", () => {
    const width = 6;
    const height = 6;
    const alpha = new Float32Array(width * height).fill(0.7);
    const rgba = makeFlatRgba(width, height, 200);
    const out = guidedFilterAlpha(alpha, rgba, width, height, 2, 1e-2);
    for (const v of out) expect(v).toBeCloseTo(0.7, 1);
  });
});
