import { describe, it, expect } from "vitest";
import { contractExpandAlpha, shiftEdgeAlpha } from "./shape-ops";

describe("contractExpandAlpha", () => {
  it("amount 0 is a no-op copy", () => {
    const alpha = new Float32Array([0, 0.5, 1]);
    const out = contractExpandAlpha(alpha, 3, 1, 0);
    expect(Array.from(out)).toEqual(Array.from(alpha));
    expect(out).not.toBe(alpha);
  });

  it("expand (positive amount) grows a single foreground pixel into its neighbors — a dilation", () => {
    const width = 5;
    const height = 5;
    const alpha = new Float32Array(width * height).fill(0);
    alpha[2 * width + 2] = 1; // single hot pixel at the center

    const out = contractExpandAlpha(alpha, width, height, 1);

    // The center and its 4-neighbors should all be pulled up to 1 by a radius-1 max filter.
    expect(out[2 * width + 2]).toBe(1);
    expect(out[2 * width + 1]).toBe(1);
    expect(out[2 * width + 3]).toBe(1);
    expect(out[1 * width + 2]).toBe(1);
    expect(out[3 * width + 2]).toBe(1);
    // A corner of the 3x3 neighborhood is also included by a square structuring element.
    expect(out[1 * width + 1]).toBe(1);
    // Pixels further away are untouched.
    expect(out[0 * width + 0]).toBe(0);
  });

  it("contract (negative amount) shrinks a foreground blob — an erosion", () => {
    const width = 5;
    const height = 5;
    const alpha = new Float32Array(width * height).fill(1); // fully opaque everywhere
    alpha[0] = 0; // one background pixel at the corner

    const out = contractExpandAlpha(alpha, width, height, -1);

    // Erosion pulls the corner's zero into its radius-1 neighborhood.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0); // (1,0)
    expect(out[width]).toBe(0); // (0,1)
    // Far corner, untouched by the radius-1 erosion from the opposite corner.
    expect(out[width * height - 1]).toBe(1);
  });

  it("expand and contract are inverses in direction: expand only raises values, contract only lowers them", () => {
    const width = 6;
    const height = 6;
    const alpha = new Float32Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.random();

    const expanded = contractExpandAlpha(alpha, width, height, 2);
    const contracted = contractExpandAlpha(alpha, width, height, -2);

    for (let i = 0; i < alpha.length; i++) {
      expect(expanded[i]).toBeGreaterThanOrEqual(alpha[i]);
      expect(contracted[i]).toBeLessThanOrEqual(alpha[i]);
    }
  });
});

describe("shiftEdgeAlpha", () => {
  it("bias 0 is a no-op copy", () => {
    const alpha = new Float32Array([0, 0.5, 1]);
    const out = shiftEdgeAlpha(alpha, 0);
    expect(Array.from(out)).toEqual(Array.from(alpha));
    expect(out).not.toBe(alpha);
  });

  it("positive bias grows the matte (raises every value), clamped at 1", () => {
    const out = shiftEdgeAlpha(new Float32Array([0, 0.5, 0.9]), 0.3);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
    expect(out[2]).toBe(1); // clamped
  });

  it("negative bias shrinks the matte (lowers every value), clamped at 0", () => {
    const out = shiftEdgeAlpha(new Float32Array([0.1, 0.5, 1]), -0.3);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.2, 5);
    expect(out[2]).toBeCloseTo(0.7, 5);
  });

  it("preserves the transition's width — a linear ramp stays linear, just shifted", () => {
    const ramp = new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]);
    const out = shiftEdgeAlpha(ramp, 0.1);
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeCloseTo(ramp[i] - ramp[i - 1], 5);
    }
  });
});
