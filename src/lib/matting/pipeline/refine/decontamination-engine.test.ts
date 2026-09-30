import { describe, it, expect } from "vitest";
import { ColourDecontaminationEngine, DEFAULT_DECONTAMINATION_OPTIONS, rgbSaturation } from "./decontamination-engine";
import { TrimapLabel } from "./trimap";

/**
 * ColourDecontaminationEngine — before/after regression tests, Phase 4
 * ("FOREGROUND COLOUR DECONTAMINATION"). Each scene is built the same way
 * decontaminate.test.ts's are: a known true foreground colour and known
 * background colour, physically blended per the standard compositing
 * equation to produce the "before" (observed, contaminated) pixel — so
 * "after" can be checked against both the observed value (did it actually
 * move?) and the known truth (did it move the right *way*?).
 */

const WIDTH = 8;
const HEIGHT = 8;
const TARGET = { x: 4, y: 4 }; // surrounded on all sides by background, same convention as decontaminate.test.ts

function buildScene(
  bg: [number, number, number],
  targetObserved: [number, number, number],
  targetAlpha: number,
): { rgba: Uint8ClampedArray; alpha: Float32Array } {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const alpha = new Float32Array(WIDTH * HEIGHT);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
    alpha[i] = 0;
  }
  const ti = TARGET.y * WIDTH + TARGET.x;
  rgba[ti * 4] = targetObserved[0];
  rgba[ti * 4 + 1] = targetObserved[1];
  rgba[ti * 4 + 2] = targetObserved[2];
  alpha[ti] = targetAlpha;
  return { rgba, alpha };
}

function blend(fg: [number, number, number], bg: [number, number, number], a: number): [number, number, number] {
  return [Math.round(a * fg[0] + (1 - a) * bg[0]), Math.round(a * fg[1] + (1 - a) * bg[1]), Math.round(a * fg[2] + (1 - a) * bg[2])];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

describe("ColourDecontaminationEngine — before/after regression", () => {
  it("green background -> green hair fringe: removes the green spill and lands closer to the true dark-hair colour", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const trueFg: [number, number, number] = [30, 20, 15];
    const alphaValue = 0.5;
    const observed = blend(trueFg, bg, alphaValue);
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);

    const after: [number, number, number] = [result.rgba[ti * 4], result.rgba[ti * 4 + 1], result.rgba[ti * 4 + 2]];

    expect(after[1]).toBeLessThan(observed[1]); // green channel reduced
    expect(distance(after, trueFg)).toBeLessThan(distance(observed, trueFg)); // closer to the truth than before
    expect(result.pixelsCorrected).toBe(1);
    expect(result.pixelsScreenLike).toBeGreaterThanOrEqual(1); // recognized as a screen-like backdrop
  });

  it("blue background -> blue clothing edge: removes the blue spill and lands closer to the true clothing colour", () => {
    const bg: [number, number, number] = [0, 0, 255];
    const trueFg: [number, number, number] = [220, 215, 210];
    const alphaValue = 0.6;
    const observed = blend(trueFg, bg, alphaValue);
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);
    const after: [number, number, number] = [result.rgba[ti * 4], result.rgba[ti * 4 + 1], result.rgba[ti * 4 + 2]];

    expect(after[2]).toBeLessThan(observed[2]); // blue channel reduced
    expect(distance(after, trueFg)).toBeLessThan(distance(observed, trueFg));
  });

  it("bright background -> light halo: darkens a contaminated edge back toward true dark-hair colour without overshooting", () => {
    const bg: [number, number, number] = [250, 250, 250];
    const trueFg: [number, number, number] = [20, 15, 10];
    const alphaValue = 0.4;
    const observed = blend(trueFg, bg, alphaValue);
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);
    const after: [number, number, number] = [result.rgba[ti * 4], result.rgba[ti * 4 + 1], result.rgba[ti * 4 + 2]];

    for (const c of after) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
    expect(after[0]).toBeLessThan(observed[0]); // moved darker, toward the truth
    expect(distance(after, trueFg)).toBeLessThan(distance(observed, trueFg));
  });

  it("safeguard: a physically-implausible dark reading is NOT snapped to a solid black halo", () => {
    // alpha says this pixel is mostly background (0.15), so the observed
    // colour "should" be close to the bright grey backdrop — but it's
    // implausibly near-black instead (sensor noise, compression, a bad
    // alpha estimate). The naive closed-form estimate wants to swing to a
    // deeply negative (and therefore clamped-to-0) "foreground" — exactly
    // the dark-halo failure mode requirement 8 exists to prevent.
    const bg: [number, number, number] = [240, 240, 240];
    const observed: [number, number, number] = [5, 5, 5];
    const alphaValue = 0.15;
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);
    const after = result.rgba[ti * 4];

    expect(result.pixelsHaloGuarded).toBeGreaterThanOrEqual(1);
    // The naive (unguarded) estimate would clamp to 0 — a solid black halo.
    // The guard should keep the result close to what was actually observed.
    expect(after).toBeGreaterThan(2);
  });

  it("safeguard: a physically-implausible bright reading is NOT snapped to a solid white halo", () => {
    const bg: [number, number, number] = [10, 10, 10];
    const observed: [number, number, number] = [250, 250, 250];
    const alphaValue = 0.15;
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);
    const after = result.rgba[ti * 4];

    expect(result.pixelsHaloGuarded).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThan(253);
  });

  it("safeguard: a correction that would strongly desaturate a pixel is derated, not applied in full", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const observed: [number, number, number] = [50, 200, 50]; // fairly saturated green-tinted edge
    const alphaValue = 0.5;
    const { rgba, alpha } = buildScene(bg, observed, alphaValue);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);
    const after: [number, number, number] = [result.rgba[ti * 4], result.rgba[ti * 4 + 1], result.rgba[ti * 4 + 2]];

    // The raw closed-form estimate here is (100, 145, 100) — noticeably
    // less saturated than the observed (50, 200, 50). The guard should land
    // the result somewhere BETWEEN the two saturations, not all the way at
    // the fully-desaturated estimate.
    const observedSat = rgbSaturation(...observed);
    const rawEstimateSat = rgbSaturation(100, 145, 100);
    const afterSat = rgbSaturation(...after);

    expect(result.pixelsSaturationGuarded).toBeGreaterThanOrEqual(1);
    expect(afterSat).toBeGreaterThan(rawEstimateSat);
    expect(afterSat).toBeLessThan(observedSat);
  });

  it("requirement 5/6: never touches a fully-opaque, deep-interior pixel — the subject as a whole is never desaturated, only its uncertain edges", () => {
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 1] = 30;
      rgba[i * 4 + 2] = 30;
      rgba[i * 4 + 3] = 255;
    }
    const before = rgba.slice();

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);

    expect(Array.from(result.rgba)).toEqual(Array.from(before));
    expect(result.pixelsConsidered).toBe(0);
  });

  it("requirement 8: leaves colour untouched when no nearby background sample exists — never guesses", () => {
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(100);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5); // every pixel semi-transparent, none qualify as "background"

    const engine = new ColourDecontaminationEngine();
    const result = engine.process(rgba, alpha, WIDTH, HEIGHT);

    expect(Array.from(result.rgba)).toEqual(Array.from(rgba));
    expect(result.pixelsNoSignal).toBeGreaterThan(0);
    expect(result.pixelsCorrected).toBe(0);
  });

  it("never mutates its input rgba/alpha", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const observed = blend([30, 20, 15], bg, 0.5);
    const { rgba, alpha } = buildScene(bg, observed, 0.5);
    const rgbaBefore = rgba.slice();
    const alphaBefore = alpha.slice();

    new ColourDecontaminationEngine().process(rgba, alpha, WIDTH, HEIGHT);

    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
  });

  it("never writes the alpha byte (index 3 of each pixel) even at corrected pixels", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const observed = blend([30, 20, 15], bg, 0.5);
    const { rgba, alpha } = buildScene(bg, observed, 0.5);
    const ti = TARGET.y * WIDTH + TARGET.x;

    const result = new ColourDecontaminationEngine().process(rgba, alpha, WIDTH, HEIGHT);

    expect(result.rgba[ti * 4 + 3]).toBe(255);
  });

  it("does not bleed a correction into a confidently-classified neighboring pixel", () => {
    const bg: [number, number, number] = [0, 0, 255];
    const trueFg: [number, number, number] = [220, 215, 210];
    const observed = blend(trueFg, bg, 0.6);
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const alpha = new Float32Array(WIDTH * HEIGHT);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
      alpha[i] = 0;
    }
    const edgeIndex = TARGET.y * WIDTH + TARGET.x;
    rgba[edgeIndex * 4] = observed[0];
    rgba[edgeIndex * 4 + 1] = observed[1];
    rgba[edgeIndex * 4 + 2] = observed[2];
    alpha[edgeIndex] = 0.6;
    // A confidently-opaque neighbor right next to the contaminated edge.
    const neighborIndex = edgeIndex + 1;
    rgba[neighborIndex * 4] = 10;
    rgba[neighborIndex * 4 + 1] = 200;
    rgba[neighborIndex * 4 + 2] = 10;
    alpha[neighborIndex] = 1;
    const neighborBefore: [number, number, number] = [rgba[neighborIndex * 4], rgba[neighborIndex * 4 + 1], rgba[neighborIndex * 4 + 2]];

    const result = new ColourDecontaminationEngine().process(rgba, alpha, WIDTH, HEIGHT);

    expect(result.rgba[edgeIndex * 4]).not.toBe(observed[0]); // the edge itself did change
    expect([result.rgba[neighborIndex * 4], result.rgba[neighborIndex * 4 + 1], result.rgba[neighborIndex * 4 + 2]]).toEqual(neighborBefore);
  });

  describe("adjustable strength", () => {
    function correctionMagnitude(strength: number): number {
      const bg: [number, number, number] = [0, 255, 0];
      const observed = blend([30, 20, 15], bg, 0.5);
      const { rgba, alpha } = buildScene(bg, observed, 0.5);
      const ti = TARGET.y * WIDTH + TARGET.x;
      const result = new ColourDecontaminationEngine({ strength }).process(rgba, alpha, WIDTH, HEIGHT);
      return Math.abs(result.rgba[ti * 4 + 1] - observed[1]);
    }

    it("strength 0 is a global no-op", () => {
      expect(correctionMagnitude(0)).toBe(0);
    });

    it("strength scales the correction magnitude monotonically", () => {
      const half = correctionMagnitude(0.5);
      const full = correctionMagnitude(1);
      expect(half).toBeGreaterThan(0);
      expect(full).toBeGreaterThan(half);
    });
  });

  describe("trimap-based gating", () => {
    it("defers to a supplied trimap's UNKNOWN band even for a pixel the raw alpha-band gate alone would exclude", () => {
      const bg: [number, number, number] = [0, 255, 0];
      const trueFg: [number, number, number] = [30, 20, 15];
      const alphaValue = 0.98; // >= the default hiThreshold — excluded by the alpha-band gate alone
      const observed = blend(trueFg, bg, alphaValue);
      const { rgba, alpha } = buildScene(bg, observed, alphaValue);
      const ti = TARGET.y * WIDTH + TARGET.x;

      const engine = new ColourDecontaminationEngine();

      const withoutTrimap = engine.process(rgba, alpha, WIDTH, HEIGHT, null);
      expect(withoutTrimap.pixelsConsidered).toBe(0);

      const trimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Background);
      trimap[ti] = TrimapLabel.Unknown; // e.g. widened here by Phase 3's expandUnknownAroundCandidates
      const withTrimap = engine.process(rgba, alpha, WIDTH, HEIGHT, trimap);
      expect(withTrimap.pixelsConsidered).toBe(1);
    });
  });
});
