import { describe, it, expect } from "vitest";
import {
  detectHairCandidates,
  expandUnknownAroundCandidates,
  dilateBinaryMask,
  DEFAULT_HAIR_DETECTION_OPTIONS,
} from "./hair-detector";
import { TrimapLabel } from "./trimap";

const WIDTH = 20;
const HEIGHT = 20;

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

/** Alternating-value strip along a single row — a real spread of values in every window that overlaps it, regardless of source-image color contrast. */
function paintAlternatingAlphaStrip(alpha: Float32Array, width: number, y: number, x0: number, x1: number, lo: number, hi: number): void {
  for (let x = x0; x <= x1; x++) {
    alpha[y * width + x] = (x - x0) % 2 === 0 ? hi : lo;
  }
}

describe("detectHairCandidates", () => {
  it("flags dark hair on a dark background via the alpha-variance cue, even with ~zero color contrast", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 20); // uniformly dark — no color signal anywhere
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    paintAlternatingAlphaStrip(alpha, WIDTH, 10, 5, 14, 0.2, 0.8);

    const { confidence, candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    // Somewhere along the strip should be flagged.
    let flaggedOnStrip = 0;
    for (let x = 5; x <= 14; x++) if (candidateMask[10 * WIDTH + x]) flaggedOnStrip++;
    expect(flaggedOnStrip).toBeGreaterThan(0);

    // Far from the strip, on the flat background, confidence should be near zero.
    expect(confidence[2 * WIDTH + 2]).toBeLessThan(0.1);
  });

  it("flags light hair on a light background via the alpha-variance cue, even with ~zero color contrast", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 235); // uniformly light — no color signal anywhere
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    paintAlternatingAlphaStrip(alpha, WIDTH, 10, 5, 14, 0.2, 0.8);

    const { confidence, candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    let flaggedOnStrip = 0;
    for (let x = 5; x <= 14; x++) if (candidateMask[10 * WIDTH + x]) flaggedOnStrip++;
    expect(flaggedOnStrip).toBeGreaterThan(0);
    expect(confidence[2 * WIDTH + 2]).toBeLessThan(0.1);
  });

  it("flags curly (curved) hair via the color-gradient cue against a contrasting background", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 250); // near-white background
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const curvePixels: number[] = [];
    for (let x = 3; x < WIDTH - 3; x++) {
      const y = 10 + Math.round(4 * Math.sin(x / 2.5));
      const i = y * WIDTH + x;
      rgba[i * 4] = 10;
      rgba[i * 4 + 1] = 8;
      rgba[i * 4 + 2] = 6;
      alpha[i] = 1;
      curvePixels.push(i);
    }

    const { candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    let flaggedOnCurve = 0;
    for (const i of curvePixels) if (candidateMask[i]) flaggedOnCurve++;
    // High-contrast curved edge should be detected along most of its length.
    expect(flaggedOnCurve / curvePixels.length).toBeGreaterThan(0.6);

    // A flat corner far from the curve should not be flagged.
    expect(candidateMask[0]).toBe(0);
  });

  it("flags a long loose strand extending far from the main foreground mass", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 250);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // A long diagonal line running the full width — simulates a loose hair
    // strand hanging well away from the "head".
    const strandPixels: number[] = [];
    for (let x = 1; x < WIDTH - 1; x++) {
      const y = Math.min(HEIGHT - 2, 1 + Math.floor(x * 0.7));
      const i = y * WIDTH + x;
      rgba[i * 4] = 15;
      rgba[i * 4 + 1] = 12;
      rgba[i * 4 + 2] = 10;
      alpha[i] = 1;
      strandPixels.push(i);
    }

    const { candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    // The far end of the strand (away from any "head" blob, since there is
    // none in this synthetic scene) must still be detected — detection is
    // not gated on proximity to an existing confident region.
    const farEnd = strandPixels[strandPixels.length - 1];
    const nearStart = strandPixels[1];
    expect(candidateMask[farEnd] || candidateMask[strandPixels[strandPixels.length - 2]]).toBeTruthy();
    expect(candidateMask[nearStart] || candidateMask[strandPixels[2]]).toBeTruthy();
  });

  it("flags very fine (single-pixel-wide, widely spaced) strands without over-flagging the background between them", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 240);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // Spaced 6 apart so a true midpoint sits outside the default
    // alpha-variance window radius (2) of either neighboring line.
    const lineXs = [3, 9, 15];
    for (const x of lineXs) {
      for (let y = 2; y < HEIGHT - 2; y++) {
        const i = y * WIDTH + x;
        rgba[i * 4] = 5;
        rgba[i * 4 + 1] = 5;
        rgba[i * 4 + 2] = 5;
        alpha[i] = 1;
      }
    }

    const { candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    for (const x of lineXs) {
      expect(candidateMask[10 * WIDTH + x]).toBe(1);
    }
    // Midway between two lines (distance 3 from each — outside both the
    // Sobel kernel's reach and the alpha-variance window), on flat
    // background, should not be flagged.
    expect(candidateMask[10 * WIDTH + 6]).toBe(0);
  });

  it("flags hair against a high-contrast background with strong, clear confidence", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 255); // pure white
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 2; y < HEIGHT - 2; y++) {
      const i = y * WIDTH + 10;
      rgba[i * 4] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      alpha[i] = 1;
    }

    const { confidence, candidateMask } = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT);

    expect(candidateMask[10 * WIDTH + 10]).toBe(1);
    expect(confidence[10 * WIDTH + 10]).toBeGreaterThan(0.8);
  });

  it("uses the given options rather than silently falling back to defaults", () => {
    const rgba = makeFlatRgba(WIDTH, HEIGHT, 128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // A very subtle single-column strand — weak enough to miss the default
    // threshold. Sobel's 3x3 kernel excludes the center pixel itself, so the
    // gradient this creates shows up in the *neighboring* column (i - 1),
    // not at the altered pixel's own index.
    const i = 10 * WIDTH + 10;
    rgba[i * 4] = 118;
    rgba[i * 4 + 1] = 118;
    rgba[i * 4 + 2] = 118;
    const neighbor = i - 1;

    const strict = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT, DEFAULT_HAIR_DETECTION_OPTIONS);
    const lenient = detectHairCandidates(alpha, rgba, WIDTH, HEIGHT, {
      ...DEFAULT_HAIR_DETECTION_OPTIONS,
      colorEnergyThreshold: 5,
      confidenceThreshold: 0.1,
    });

    expect(lenient.confidence[neighbor]).toBeGreaterThan(strict.confidence[neighbor]);
  });
});

describe("dilateBinaryMask", () => {
  it("radius 0 returns an unchanged copy", () => {
    const mask = new Uint8Array([0, 1, 0]);
    const out = dilateBinaryMask(mask, 3, 1, 0);
    expect(Array.from(out)).toEqual([0, 1, 0]);
    expect(out).not.toBe(mask);
  });

  it("grows a single pixel into its 3x3 neighborhood at radius 1", () => {
    const width = 5;
    const height = 5;
    const mask = new Uint8Array(width * height);
    mask[2 * width + 2] = 1;

    const out = dilateBinaryMask(mask, width, height, 1);

    expect(out[1 * width + 1]).toBe(1);
    expect(out[1 * width + 2]).toBe(1);
    expect(out[2 * width + 3]).toBe(1);
    expect(out[3 * width + 3]).toBe(1);
    expect(out[0 * width + 0]).toBe(0); // outside the radius-1 neighborhood
  });
});

describe("expandUnknownAroundCandidates", () => {
  it("promotes trimap pixels near a candidate to UNKNOWN, leaving distant pixels untouched", () => {
    const width = 10;
    const height = 10;
    const trimap = new Uint8Array(width * height).fill(TrimapLabel.Background);
    const candidateMask = new Uint8Array(width * height);
    candidateMask[5 * width + 5] = 1;

    const out = expandUnknownAroundCandidates(trimap, candidateMask, width, height, { radius: 2 });

    expect(out[5 * width + 5]).toBe(TrimapLabel.Unknown);
    expect(out[5 * width + 6]).toBe(TrimapLabel.Unknown); // within radius 2
    expect(out[5 * width + 8]).toBe(TrimapLabel.Background); // outside radius 2
    expect(out[0]).toBe(TrimapLabel.Background);
  });

  it("does not mutate the input trimap", () => {
    const width = 6;
    const height = 6;
    const trimap = new Uint8Array(width * height).fill(TrimapLabel.Foreground);
    const before = trimap.slice();
    const candidateMask = new Uint8Array(width * height);
    candidateMask[10] = 1;

    expandUnknownAroundCandidates(trimap, candidateMask, width, height);

    expect(Array.from(trimap)).toEqual(Array.from(before));
  });
});
