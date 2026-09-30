import { describe, it, expect } from "vitest";
import { imageDataToNormalizedTensor, normalizePrediction } from "./u2net";

/**
 * PRODUCTION READINESS (C2): before this file, NOTHING tested a real model
 * adapter's actual numerical preprocessing/postprocessing — only its static
 * `capabilities` metadata (capabilities.test.ts). A wrong normalization
 * constant, a swapped channel, or a wrong planar-layout stride would have
 * silently shipped a corrupted matte with the full 408-test suite still
 * green. These tests hand-compute expected values independently of the
 * production code's own constants, so a regression in either the math OR
 * the constants themselves would be caught.
 *
 * Scope note: `inferImage`'s resize-canvas step and real `session.run()`
 * wiring are DOM/ONNX-dependent and are NOT covered here (same constraint
 * as the rest of this codebase — no jsdom+canvas installed); those remain
 * verified via live browser testing, per established project convention.
 * What's covered here is the numerically risky, DOM-free transform math
 * that sits on either side of that call — exactly what was previously
 * untested.
 */

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

describe("imageDataToNormalizedTensor", () => {
  it("produces the correct shape: [1, 3, size, size], planar (CHW) layout", () => {
    const size = 2;
    const data = new Uint8ClampedArray(size * size * 4).fill(128);
    const tensor = imageDataToNormalizedTensor(data, size);
    expect(tensor.dims).toEqual([1, 3, size, size]);
    expect(tensor.type).toBe("float32");
    expect((tensor.data as Float32Array).length).toBe(3 * size * size);
  });

  it("normalizes each channel with the documented ImageNet mean/std, per channel, not mixed up", () => {
    const size = 1;
    // A single pixel: R=255, G=0, B=128, A=255 (alpha ignored).
    const data = new Uint8ClampedArray([255, 0, 128, 255]);
    const tensor = imageDataToNormalizedTensor(data, size);
    const out = tensor.data as Float32Array;

    const expectedR = (255 / 255 - MEAN[0]) / STD[0];
    const expectedG = (0 / 255 - MEAN[1]) / STD[1];
    const expectedB = (128 / 255 - MEAN[2]) / STD[2];

    // Planar layout: R plane first, then G, then B — NOT interleaved RGBRGB.
    expect(out[0]).toBeCloseTo(expectedR, 6);
    expect(out[1]).toBeCloseTo(expectedG, 6);
    expect(out[2]).toBeCloseTo(expectedB, 6);
  });

  it("places each pixel at the correct planar offset for a multi-pixel image (catches a wrong stride/axis order)", () => {
    const size = 2; // 4 pixels: TL, TR, BL, BR in row-major RGBA order
    const data = new Uint8ClampedArray([
      10, 20, 30, 255, // pixel 0 (top-left)
      40, 50, 60, 255, // pixel 1 (top-right)
      70, 80, 90, 255, // pixel 2 (bottom-left)
      100, 110, 120, 255, // pixel 3 (bottom-right)
    ]);
    const tensor = imageDataToNormalizedTensor(data, size);
    const out = tensor.data as Float32Array;
    const plane = size * size;

    // Red channel plane (indices 0..3) should be pixels' R values, in order.
    const expectedRedPlane = [10, 40, 70, 100].map((v) => (v / 255 - MEAN[0]) / STD[0]);
    for (let i = 0; i < plane; i++) expect(out[i]).toBeCloseTo(expectedRedPlane[i], 6);

    // Blue channel plane (indices 2*plane..2*plane+3) should be pixels' B values.
    const expectedBluePlane = [30, 60, 90, 120].map((v) => (v / 255 - MEAN[2]) / STD[2]);
    for (let i = 0; i < plane; i++) expect(out[2 * plane + i]).toBeCloseTo(expectedBluePlane[i], 6);
  });
});

describe("normalizePrediction", () => {
  it("min-max normalizes to exactly [0, 1] when the input has real variance", () => {
    const input = new Float32Array([2, 4, 6, 8, 10]);
    const out = normalizePrediction(input);
    expect(out[0]).toBeCloseTo(0, 6); // min -> 0
    expect(out[4]).toBeCloseTo(1, 6); // max -> 1
    expect(out[2]).toBeCloseTo(0.5, 6); // midpoint -> 0.5
  });

  it("does not divide by zero when every value is identical — falls back to a stable, non-NaN output", () => {
    const input = new Float32Array([5, 5, 5, 5]);
    const out = normalizePrediction(input);
    for (const v of out) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeCloseTo(0, 6);
    }
  });

  it("correctly handles negative raw saliency values (real network output before sigmoid/normalization)", () => {
    const input = new Float32Array([-3, -1, 0, 2, 5]);
    const out = normalizePrediction(input);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[4]).toBeCloseTo(1, 6);
    // -1 is 2/8 of the way from -3 to 5
    expect(out[1]).toBeCloseTo(2 / 8, 6);
  });

  it("preserves array length and never returns a value outside [0, 1]", () => {
    const input = new Float32Array([100, -100, 0, 50, -50, 25]);
    const out = normalizePrediction(input);
    expect(out.length).toBe(input.length);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
