import { describe, it, expect } from "vitest";
import { sad, mse, mad, gradientError, connectivityError, temporalConsistencyError, computeImageMetrics } from "./metrics";

describe("sad / mse / mad", () => {
  it("are all zero for an identical prediction", () => {
    const a = new Float32Array([0, 0.5, 1, 0.25]);
    const b = new Float32Array([0, 0.5, 1, 0.25]);
    expect(sad(a, b)).toBe(0);
    expect(mse(a, b)).toBe(0);
    expect(mad(a, b)).toBe(0);
  });

  it("computes the expected values for a known difference", () => {
    const pred = new Float32Array([1, 1, 1, 1]);
    const gt = new Float32Array([0, 0, 0, 0]);
    expect(sad(pred, gt)).toBe(4);
    expect(mad(pred, gt)).toBe(1);
    expect(mse(pred, gt)).toBe(1);
  });

  it("mad is sad divided by pixel count, not the same number", () => {
    const pred = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]);
    const gt = new Float32Array(8).fill(0);
    expect(sad(pred, gt)).toBe(4);
    expect(mad(pred, gt)).toBe(0.5);
  });
});

describe("gradientError", () => {
  it("is zero for an identical prediction", () => {
    const width = 4;
    const height = 4;
    const alpha = new Float32Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (i % width) / width;
    expect(gradientError(alpha, alpha, width, height)).toBe(0);
  });

  it("is nonzero when an edge is shifted by one pixel", () => {
    const width = 8;
    const height = 8;
    const gt = new Float32Array(width * height);
    const pred = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        gt[y * width + x] = x < 4 ? 1 : 0;
        pred[y * width + x] = x < 5 ? 1 : 0; // edge shifted right by one column
      }
    }
    expect(gradientError(pred, gt, width, height)).toBeGreaterThan(0);
  });
});

describe("connectivityError", () => {
  const width = 10;
  const height = 10;

  function solidSquare(x0: number, y0: number, size: number): Float32Array {
    const out = new Float32Array(width * height);
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) out[y * width + x] = 1;
    }
    return out;
  }

  it("is zero when prediction exactly matches ground truth's connected region", () => {
    const gt = solidSquare(2, 2, 4);
    expect(connectivityError(gt, gt, width, height)).toBe(0);
  });

  it("is 1 when the prediction misses the ground-truth region entirely", () => {
    const gt = solidSquare(2, 2, 4);
    const pred = new Float32Array(width * height); // all zero
    expect(connectivityError(pred, gt, width, height)).toBe(1);
  });

  it("penalizes a prediction that is split into a disconnected piece relative to ground truth's main blob", () => {
    const gt = solidSquare(1, 1, 6); // one solid 6x6 block
    // Prediction: same footprint but with a one-pixel-wide gap punched through the middle,
    // splitting it into two disconnected halves.
    const pred = solidSquare(1, 1, 6).slice();
    for (let y = 1; y < 7; y++) pred[y * width + 4] = 0;
    const error = connectivityError(pred, gt, width, height);
    expect(error).toBeGreaterThan(0);
    expect(error).toBeLessThan(1);
  });
});

describe("temporalConsistencyError", () => {
  it("is zero when prediction and ground truth change identically frame to frame", () => {
    const gt = [new Float32Array([0, 0]), new Float32Array([1, 1]), new Float32Array([0.5, 0.5])];
    const pred = gt.map((f) => f.slice());
    expect(temporalConsistencyError(pred, gt)).toBe(0);
  });

  it("is zero for a single frame (nothing to compare)", () => {
    expect(temporalConsistencyError([new Float32Array([0.5])], [new Float32Array([0.5])])).toBe(0);
  });

  it("flags flicker: prediction changes between frames while ground truth is static", () => {
    const gt = [new Float32Array([0.5, 0.5]), new Float32Array([0.5, 0.5]), new Float32Array([0.5, 0.5])];
    const pred = [new Float32Array([0.5, 0.5]), new Float32Array([0.9, 0.1]), new Float32Array([0.5, 0.5])];
    expect(temporalConsistencyError(pred, gt)).toBeGreaterThan(0);
  });

  it("flags over-smoothing: ground truth changes but prediction stays static", () => {
    const gt = [new Float32Array([0, 0]), new Float32Array([1, 1]), new Float32Array([0, 0])];
    const pred = [new Float32Array([0.4, 0.4]), new Float32Array([0.4, 0.4]), new Float32Array([0.4, 0.4])];
    expect(temporalConsistencyError(pred, gt)).toBeGreaterThan(0);
  });

  it("throws on mismatched frame counts rather than silently comparing the wrong frames", () => {
    expect(() => temporalConsistencyError([new Float32Array([0])], [new Float32Array([0]), new Float32Array([1])])).toThrow();
  });
});

describe("computeImageMetrics", () => {
  it("bundles all five still-image metrics and matches the individually-computed values", () => {
    const width = 6;
    const height = 6;
    const gt = new Float32Array(width * height);
    const pred = new Float32Array(width * height);
    for (let i = 0; i < gt.length; i++) {
      gt[i] = i % 3 === 0 ? 1 : 0;
      pred[i] = i % 4 === 0 ? 1 : 0;
    }
    const result = computeImageMetrics(pred, gt, width, height);
    expect(result.sad).toBe(sad(pred, gt));
    expect(result.mse).toBe(mse(pred, gt));
    expect(result.mad).toBe(mad(pred, gt));
    expect(result.gradientError).toBe(gradientError(pred, gt, width, height));
    expect(result.connectivityError).toBe(connectivityError(pred, gt, width, height));
  });

  it("throws when prediction and ground truth are different sizes", () => {
    expect(() => computeImageMetrics(new Float32Array(4), new Float32Array(6), 2, 2)).toThrow();
  });
});
