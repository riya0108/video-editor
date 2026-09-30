import { describe, it, expect } from "vitest";
import { refineFineDetail, DEFAULT_FINE_DETAIL_REFINE_OPTIONS } from "./fine-detail-refiner";
import { guidedFilterAlpha } from "../guided-filter";
import { TrimapLabel } from "./trimap";
import { DEFAULT_DECONTAMINATE_OPTIONS } from "../decontaminate";

const WIDTH = 5;
const HEIGHT = 5;
const CENTER = 2 * WIDTH + 2;

function makeGrid(fill: number): Float32Array {
  return new Float32Array(WIDTH * HEIGHT).fill(fill);
}

function makeFlatRgba(gray: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("refineFineDetail", () => {
  it("leaves pixels outside the expanded unknown band completely unchanged", () => {
    const alpha = makeGrid(1);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(128);
    // Nothing is in the unknown band.
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Foreground);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(1);

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    expect(Array.from(result.alpha)).toEqual(Array.from(alpha));
    expect(result.pixelsRefined).toBe(0);
  });

  it("never mutates its input alpha/rgba", () => {
    const alpha = makeGrid(1);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(128);
    const alphaBefore = alpha.slice();
    const rgbaBefore = rgba.slice();
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(0.5);

    refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
  });

  it("never produces out-of-range alpha (requirement: preserve natural transparency, never push to artificial solid)", () => {
    const alpha = makeGrid(1);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(128);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(0.8);

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    for (const v of result.alpha) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("preserveStrength 1 at full confidence keeps the original (decontaminated) alpha exactly, not the filtered value", () => {
    // Center pixel is the only non-opaque pixel, deep inside a fully-opaque
    // region — decontaminate finds no nearby background sample (nothing
    // <= loThreshold within its search radius) and leaves it unchanged, so
    // decon.alpha[CENTER] is guaranteed to equal the input exactly.
    const alpha = makeGrid(1);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(128);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(1);

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence, {
      ...DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
      preserveStrength: 1,
    });

    expect(result.alpha[CENTER]).toBe(0.5);
  });

  it("preserveStrength 0 uses the filtered value outright, matching a direct guidedFilterAlpha call", () => {
    const alpha = makeGrid(1);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(128);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(1);

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence, {
      ...DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
      preserveStrength: 0,
    });

    const expected = guidedFilterAlpha(alpha, rgba, WIDTH, HEIGHT, DEFAULT_FINE_DETAIL_REFINE_OPTIONS.radius, DEFAULT_FINE_DETAIL_REFINE_OPTIONS.eps);
    expect(result.alpha[CENTER]).toBeCloseTo(expected[CENTER], 5);
  });

  it("avoids excessive erosion of an isolated, fully-confident thin-hair pixel surrounded by background", () => {
    // A single strand pixel (alpha 1) with pure background (alpha 0) all
    // around it — the worst case for erosion, since a plain blur/guided
    // filter alone would pull it down toward the surrounding zeros.
    const alpha = makeGrid(0);
    alpha[CENTER] = 1;
    const rgba = makeFlatRgba(200);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(1); // maximally confident this is real hair

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    expect(result.alpha[CENTER]).toBeGreaterThan(0.5);
  });

  it("removes background colour contamination at a semi-transparent hair-edge pixel with a known background", () => {
    const bg: [number, number, number] = [0, 255, 0]; // green screen
    const trueForeground: [number, number, number] = [40, 25, 15]; // dark hair
    const alphaValue = 0.5;
    const observed: [number, number, number] = [
      Math.round(alphaValue * trueForeground[0] + (1 - alphaValue) * bg[0]),
      Math.round(alphaValue * trueForeground[1] + (1 - alphaValue) * bg[1]),
      Math.round(alphaValue * trueForeground[2] + (1 - alphaValue) * bg[2]),
    ];

    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }
    alpha[CENTER] = alphaValue;
    rgba[CENTER * 4] = observed[0];
    rgba[CENTER * 4 + 1] = observed[1];
    rgba[CENTER * 4 + 2] = observed[2];

    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Unknown);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(1);

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence, {
      ...DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
      decontaminate: DEFAULT_DECONTAMINATE_OPTIONS,
    });

    expect(result.pixelsDecontaminated).toBeGreaterThanOrEqual(1);
    // Recovered color should have moved away from the green backdrop toward the true dark foreground.
    expect(result.rgba[CENTER * 4 + 1]).toBeLessThan(observed[1]);
  });

  it("restores alpha at a high-confidence pixel that decontaminate would otherwise suppress to 0 — the dark-hair-on-dark-background / light-hair-on-light-background case", () => {
    // Flat, uniform color everywhere: the observed color at CENTER is
    // identical to the surrounding "background" color, so decontaminate's
    // own unmixing math recovers exactly the background color as the
    // "foreground" — distance 0, definitely suppressed on color evidence
    // alone. Only the hair detector's independent alpha-variance confidence
    // (simulated here directly) has any reason to think this is real hair.
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(20);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Background);
    expandedTrimap[CENTER] = TrimapLabel.Unknown;
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(0);
    confidence[CENTER] = 1;

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    expect(result.pixelsSuppressed).toBeGreaterThanOrEqual(1); // decontaminate itself did try to suppress it
    expect(result.pixelsSuppressionOverridden).toBeGreaterThanOrEqual(1); // ...but the guard reversed it
    expect(result.alpha[CENTER]).toBeGreaterThan(0.2); // real alpha survives, not zeroed
  });

  it("does not protect a low-confidence pixel from suppression — the guard only overrides genuine hair-detector evidence, not every suppression", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    alpha[CENTER] = 0.5;
    const rgba = makeFlatRgba(20);
    const expandedTrimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Background);
    expandedTrimap[CENTER] = TrimapLabel.Unknown;
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(0); // no hair evidence anywhere

    const result = refineFineDetail(alpha, rgba, WIDTH, HEIGHT, expandedTrimap, confidence);

    expect(result.pixelsSuppressed).toBeGreaterThanOrEqual(1);
    expect(result.pixelsSuppressionOverridden).toBe(0);
    expect(result.alpha[CENTER]).toBe(0);
  });
});
