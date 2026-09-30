import { describe, it, expect } from "vitest";
import { chromaKeyAlpha, bilinearSampleMask } from "./chroma-key-math";

/**
 * PRODUCTION READINESS (H4): the chroma-key/AI-cutout compositing math — the
 * Remove Background tool's DEFAULT mode for video, and the main Video
 * Editor's live chroma-key preview — had zero test coverage before this
 * file. Pulled the per-pixel math out of its canvas call sites (see
 * chroma-key-math.ts's own doc comment) specifically to make this possible.
 */

describe("chromaKeyAlpha", () => {
  const GREEN: [number, number, number] = [0, 255, 0];

  it("returns 0 (fully keyed out) for an exact match to the key color", () => {
    expect(chromaKeyAlpha(...GREEN, ...GREEN, 0.4, 0.1)).toBe(0);
  });

  it("returns 1 (fully opaque) for a color far from the key color", () => {
    // Pure red vs. pure green key — maximally different on 2 of 3 channels.
    expect(chromaKeyAlpha(255, 0, 0, ...GREEN, 0.1, 0.1)).toBe(1);
  });

  it("ramps linearly through the uncertain band between similarity and similarity+blend", () => {
    // Pick a gray whose distance from green sits inside a wide blend band.
    const similarity = 0.1;
    const blend = 0.5;
    const midGray = 130; // roughly mid-distance from green for a neutral gray
    const alpha = chromaKeyAlpha(midGray, midGray, midGray, ...GREEN, similarity, blend);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });

  it("never divides by zero when blend is 0 — clamps to a tiny minimum instead", () => {
    const alpha = chromaKeyAlpha(255, 0, 0, ...GREEN, 0.1, 0);
    expect(Number.isFinite(alpha)).toBe(true);
    expect(alpha).toBe(1);
  });

  it("always stays within [0, 1] regardless of input extremity", () => {
    const alpha1 = chromaKeyAlpha(-1000, -1000, -1000, ...GREEN, 0, 0.01);
    const alpha2 = chromaKeyAlpha(9999, 9999, 9999, ...GREEN, 0.9, 0.01);
    expect(alpha1).toBeGreaterThanOrEqual(0);
    expect(alpha1).toBeLessThanOrEqual(1);
    expect(alpha2).toBeGreaterThanOrEqual(0);
    expect(alpha2).toBeLessThanOrEqual(1);
  });

  it("a higher similarity threshold keys out a wider range of near-key colors", () => {
    // A color moderately close to green.
    const nearGreen: [number, number, number] = [40, 200, 40];
    const lowSimilarity = chromaKeyAlpha(...nearGreen, ...GREEN, 0.05, 0.05);
    const highSimilarity = chromaKeyAlpha(...nearGreen, ...GREEN, 0.3, 0.05);
    expect(highSimilarity).toBeLessThanOrEqual(lowSimilarity);
  });
});

describe("bilinearSampleMask", () => {
  it("returns the exact value at integer grid points", () => {
    // 2x2 mask.
    const mask = new Float32Array([0, 1, 1, 0]);
    expect(bilinearSampleMask(mask, 2, 2, 0, 0)).toBeCloseTo(0, 6);
    expect(bilinearSampleMask(mask, 2, 2, 1, 0)).toBeCloseTo(1, 6);
    expect(bilinearSampleMask(mask, 2, 2, 0, 1)).toBeCloseTo(1, 6);
    expect(bilinearSampleMask(mask, 2, 2, 1, 1)).toBeCloseTo(0, 6);
  });

  it("interpolates linearly at the midpoint between four known corners", () => {
    const mask = new Float32Array([0, 1, 1, 0]); // TL=0, TR=1, BL=1, BR=0
    // Center of the 2x2 grid: average of all four corners = 0.5.
    expect(bilinearSampleMask(mask, 2, 2, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it("interpolates correctly along a simple horizontal gradient", () => {
    const mask = new Float32Array([0, 10]); // 2x1 mask
    expect(bilinearSampleMask(mask, 2, 1, 0, 0)).toBeCloseTo(0, 6);
    expect(bilinearSampleMask(mask, 2, 1, 1, 0)).toBeCloseTo(10, 6);
    expect(bilinearSampleMask(mask, 2, 1, 0.25, 0)).toBeCloseTo(2.5, 6);
  });

  it("clamps sample coordinates at or beyond the mask's edge instead of reading out of bounds", () => {
    const mask = new Float32Array([1, 2, 3, 4]); // 2x2
    expect(() => bilinearSampleMask(mask, 2, 2, 5, 5)).not.toThrow();
    const v = bilinearSampleMask(mask, 2, 2, 5, 5);
    expect(v).toBeCloseTo(4, 6); // clamps to the bottom-right corner value
  });
});
