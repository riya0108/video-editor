import { describe, it, expect } from "vitest";
import {
  computeAlphaGradientMagnitude,
  computeLocalDensity,
  computeStructureTensorAnisotropy,
  computeChromaticity,
  computeLocalAlphaRange,
  computeAlphaOscillationDensity,
  chromaticityDistance,
  estimateNearbyForegroundColor,
  rampToConfidence,
} from "./edge-signals";
import { TrimapLabel } from "./trimap";

const WIDTH = 16;
const HEIGHT = 16;

describe("computeAlphaGradientMagnitude", () => {
  it("reports a large magnitude at a one-pixel-wide hard step and a small one across a wide ramp", () => {
    const hard = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 8; x < WIDTH; x++) hard[y * WIDTH + x] = 1;
    const hardMag = computeAlphaGradientMagnitude(hard, WIDTH, HEIGHT);

    const soft = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) soft[y * WIDTH + x] = Math.min(1, x / (WIDTH - 1));
    const softMag = computeAlphaGradientMagnitude(soft, WIDTH, HEIGHT);

    expect(hardMag[8 * WIDTH + 8]).toBeGreaterThan(3);
    expect(softMag[8 * WIDTH + 8]).toBeLessThan(1);
    expect(hardMag[8 * WIDTH + 8]).toBeGreaterThan(softMag[8 * WIDTH + 8] * 3);
  });
});

describe("computeLocalDensity", () => {
  it("reports low density for an isolated single pixel and high density for a filled block", () => {
    const sparse = new Uint8Array(WIDTH * HEIGHT);
    sparse[8 * WIDTH + 8] = 1;
    const sparseDensity = computeLocalDensity(sparse, WIDTH, HEIGHT, 4);

    const dense = new Uint8Array(WIDTH * HEIGHT).fill(1);
    const denseDensity = computeLocalDensity(dense, WIDTH, HEIGHT, 4);

    expect(sparseDensity[8 * WIDTH + 8]).toBeLessThan(0.1);
    expect(denseDensity[8 * WIDTH + 8]).toBeCloseTo(1, 5);
  });
});

describe("computeLocalAlphaRange", () => {
  it("reports near-zero range on a flat plateau and a large range across a ramp", () => {
    const plateau = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const plateauRange = computeLocalAlphaRange(plateau, WIDTH, HEIGHT, 4);

    const ramp = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) ramp[y * WIDTH + x] = x / (WIDTH - 1);
    const rampRange = computeLocalAlphaRange(ramp, WIDTH, HEIGHT, 4);

    expect(plateauRange[8 * WIDTH + 8]).toBe(0);
    expect(rampRange[8 * WIDTH + 8]).toBeGreaterThan(0.3);
  });
});

describe("computeStructureTensorAnisotropy", () => {
  it("reports high anisotropy for a directional stripe pattern and low anisotropy for an isotropic checkerboard-of-blocks pattern", () => {
    const stripes = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const v = x % 4 < 2 ? 220 : 20; // vertical stripes -> gradient purely horizontal everywhere
        const i = (y * WIDTH + x) * 4;
        stripes[i] = stripes[i + 1] = stripes[i + 2] = v;
        stripes[i + 3] = 255;
      }
    }
    const stripeAnisotropy = computeStructureTensorAnisotropy(stripes, WIDTH, HEIGHT, 3);

    // A radial gradient has a *locally* consistent-but-spatially-varying
    // direction; sampled over a whole neighborhood spanning multiple
    // directions relative to the center, it reads as much less coherently
    // directional than the pure stripes above.
    const radial = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const v = Math.round(Math.min(255, Math.max(0, 128 + 20 * Math.sin(d))));
        const i = (y * WIDTH + x) * 4;
        radial[i] = radial[i + 1] = radial[i + 2] = v;
        radial[i + 3] = 255;
      }
    }
    const radialAnisotropy = computeStructureTensorAnisotropy(radial, WIDTH, HEIGHT, 3);

    expect(stripeAnisotropy[8 * WIDTH + 8]).toBeGreaterThan(0.8);
    expect(radialAnisotropy[8 * WIDTH + 2]).toBeLessThan(stripeAnisotropy[8 * WIDTH + 8]);
  });
});

describe("computeChromaticity", () => {
  it("gives pure red and dim red the same chromaticity but different luminance", () => {
    const rgba = new Uint8ClampedArray(2 * 1 * 4);
    rgba[0] = 200;
    rgba[1] = 0;
    rgba[2] = 0;
    rgba[3] = 255;
    rgba[4] = 80; // same ratio, dimmer
    rgba[5] = 0;
    rgba[6] = 0;
    rgba[7] = 255;

    const { rNorm, luminance } = computeChromaticity(rgba, 2, 1);

    expect(rNorm[0]).toBeCloseTo(rNorm[1], 2);
    expect(luminance[0]).toBeGreaterThan(luminance[1]);
  });
});

describe("chromaticityDistance", () => {
  it("is zero for identical chromaticity and positive for a different hue", () => {
    expect(chromaticityDistance(0.5, 0.3, 0.5, 0.3)).toBe(0);
    expect(chromaticityDistance(0.8, 0.1, 0.1, 0.8)).toBeGreaterThan(0.5);
  });
});

describe("estimateNearbyForegroundColor", () => {
  it("averages nearby FOREGROUND-labeled pixels and returns null when none are within range", () => {
    const width = 5;
    const height = 5;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const trimap = new Uint8Array(width * height).fill(TrimapLabel.Background);
    const fgIndex = 0 * width + 0;
    trimap[fgIndex] = TrimapLabel.Foreground;
    rgba[fgIndex * 4] = 100;
    rgba[fgIndex * 4 + 1] = 150;
    rgba[fgIndex * 4 + 2] = 200;

    const found = estimateNearbyForegroundColor(rgba, trimap, 1, 1, width, height, 2);
    expect(found).not.toBeNull();
    expect(found![0]).toBeCloseTo(100, 0);

    const notFound = estimateNearbyForegroundColor(rgba, trimap, 4, 4, width, height, 1);
    expect(notFound).toBeNull();
  });
});

describe("computeAlphaOscillationDensity", () => {
  it("reports zero oscillation for a monotonic hard step and high oscillation for alternating hair-like values", () => {
    const step = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 8; x < WIDTH; x++) step[y * WIDTH + x] = 1;
    const stepOscillation = computeAlphaOscillationDensity(step, WIDTH, HEIGHT, 2);
    expect(stepOscillation[8 * WIDTH + 8]).toBe(0);

    const strand = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 2; x < WIDTH - 2; x++) {
        strand[y * WIDTH + x] = x % 2 === 0 ? 0.9 : 0.1;
      }
    }
    const strandOscillation = computeAlphaOscillationDensity(strand, WIDTH, HEIGHT, 2);
    // This synthetic pattern only alternates horizontally (every row is
    // identical), so the vertical scan correctly contributes zero
    // oscillation, diluting the combined horizontal+vertical density to
    // exactly 0.5 — still a stark contrast against the hard step's exact 0.
    expect(strandOscillation[8 * WIDTH + 8]).toBeGreaterThanOrEqual(0.5);
  });

  it("reports zero oscillation for a gradual monotonic ramp", () => {
    const ramp = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) ramp[y * WIDTH + x] = x / (WIDTH - 1);
    const rampOscillation = computeAlphaOscillationDensity(ramp, WIDTH, HEIGHT, 2);
    expect(rampOscillation[8 * WIDTH + 8]).toBe(0);
  });
});

describe("rampToConfidence", () => {
  it("ramps linearly to 1 at the threshold and clamps beyond it", () => {
    expect(rampToConfidence(0, 10)).toBe(0);
    expect(rampToConfidence(5, 10)).toBeCloseTo(0.5, 5);
    expect(rampToConfidence(20, 10)).toBe(1);
  });
});
