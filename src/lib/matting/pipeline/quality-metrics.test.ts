import { describe, it, expect } from "vitest";
import { computeQualityMetrics, computeConfidence } from "./quality-metrics";

describe("computeQualityMetrics", () => {
  it("reports zero coverage for an all-background alpha map", () => {
    const width = 8;
    const height = 8;
    const alpha = new Float32Array(width * height).fill(0);
    const metrics = computeQualityMetrics(alpha, width, height);
    expect(metrics.coverageFraction).toBe(0);
    expect(metrics.edgeGradientEnergy).toBe(0); // no gradient anywhere in a flat field
    expect(metrics.softEdgeFraction).toBe(0); // no boundary pixels exist to be soft or hard
  });

  it("reports full coverage for an all-foreground alpha map", () => {
    const width = 8;
    const height = 8;
    const alpha = new Float32Array(width * height).fill(1);
    const metrics = computeQualityMetrics(alpha, width, height);
    expect(metrics.coverageFraction).toBe(1);
  });

  it("reports ~50% coverage for a half-and-half split, with a real measured edge gradient", () => {
    const width = 10;
    const height = 10;
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) alpha[y * width + x] = x < width / 2 ? 1 : 0;
    }
    const metrics = computeQualityMetrics(alpha, width, height);
    expect(metrics.coverageFraction).toBeCloseTo(0.5, 1);
    expect(metrics.edgeGradientEnergy).toBeGreaterThan(0);
  });

  it("distinguishes a hard-thresholded edge (low softEdgeFraction) from a genuinely soft one (high softEdgeFraction)", () => {
    const width = 10;
    const height = 4;

    const hardAlpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) hardAlpha[y * width + x] = x < 5 ? 1 : 0;
    }

    const softAlpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) softAlpha[y * width + x] = x / (width - 1); // full 0-1 ramp
    }

    const hardMetrics = computeQualityMetrics(hardAlpha, width, height);
    const softMetrics = computeQualityMetrics(softAlpha, width, height);

    expect(softMetrics.softEdgeFraction).toBeGreaterThan(hardMetrics.softEdgeFraction);
    expect(hardMetrics.softEdgeFraction).toBe(0); // the only transition is a single hard 1->0 step
  });

  it("returns all-zero metrics for a zero-area image rather than dividing by zero", () => {
    const metrics = computeQualityMetrics(new Float32Array(0), 0, 0);
    expect(metrics).toEqual({ coverageFraction: 0, softEdgeFraction: 0, edgeGradientEnergy: 0, alphaHistogramBimodality: 0 });
  });
});

describe("computeConfidence", () => {
  it("is high when the alpha histogram is fully bimodal (every pixel decisively 0 or 1) and coverage is plausible", () => {
    const confidence = computeConfidence({
      coverageFraction: 0.4,
      softEdgeFraction: 0,
      edgeGradientEnergy: 1,
      alphaHistogramBimodality: 1,
    });
    expect(confidence).toBeCloseTo(1, 5);
  });

  it("is penalized when coverage is implausibly extreme, even with a bimodal histogram", () => {
    const plausible = computeConfidence({ coverageFraction: 0.4, softEdgeFraction: 0, edgeGradientEnergy: 1, alphaHistogramBimodality: 0.8 });
    const implausible = computeConfidence({ coverageFraction: 0.001, softEdgeFraction: 0, edgeGradientEnergy: 1, alphaHistogramBimodality: 0.8 });
    expect(implausible).toBeLessThan(plausible);
  });

  it("stays within [0,1]", () => {
    const confidence = computeConfidence({ coverageFraction: 0.5, softEdgeFraction: 0, edgeGradientEnergy: 0, alphaHistogramBimodality: 1 });
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});
