import { describe, it, expect } from "vitest";
import {
  boundingBoxOfPixels,
  analyzeEdgeSmoothness,
  analyzeEdgeContinuity,
  analyzeHalos,
  analyzeHolesAndIslands,
  analyzeHairPreservation,
  analyzeAlphaDiscontinuity,
  analyzeColourContamination,
  analyzeResolutionAdequacy,
} from "./matte-quality-signals";
import { buildTrimap, DEFAULT_TRIMAP_OPTIONS, TrimapLabel } from "./trimap";

const WIDTH = 30;
const HEIGHT = 30;

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

describe("boundingBoxOfPixels", () => {
  it("computes the tight box around a pixel-index list", () => {
    const width = 10;
    const pixels = [12, 15, 32]; // (2,1),(5,1),(2,3)
    const box = boundingBoxOfPixels(pixels, width);
    expect(box).toEqual({ x: 2, y: 1, width: 4, height: 3 });
  });
});

describe("analyzeEdgeSmoothness", () => {
  it("scores a smooth linear ramp higher than a noisy, jittered one", () => {
    const rgba = makeFlatRgba(128);
    const smooth = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) smooth[y * WIDTH + x] = Math.min(1, Math.max(0, (x - 5) / 20));
    const smoothTrimap = buildTrimap(smooth, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const smoothResult = analyzeEdgeSmoothness(smooth, smoothTrimap, WIDTH, HEIGHT);

    const noisy = smooth.slice();
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      noisy[i] = Math.min(1, Math.max(0, noisy[i] + ((x + y) % 2 === 0 ? 0.3 : -0.3)));
    }
    const noisyTrimap = buildTrimap(noisy, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const noisyResult = analyzeEdgeSmoothness(noisy, noisyTrimap, WIDTH, HEIGHT);

    expect(smoothResult.score).toBeGreaterThan(noisyResult.score);
    expect(smoothResult.sampleCount).toBeGreaterThan(0);
  });

  it("reports sampleCount 0 (and a score of 1, not a fabricated judgment) when there is no unknown band at all", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const result = analyzeEdgeSmoothness(alpha, trimap, WIDTH, HEIGHT);
    expect(result.sampleCount).toBe(0);
    expect(result.score).toBe(1);
  });
});

describe("analyzeEdgeContinuity", () => {
  it("scores a single contiguous boundary higher than one broken into many fragments", () => {
    const continuous = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 15; x < WIDTH; x++) continuous[y * WIDTH + x] = 0.5;
    const continuousTrimap = buildTrimap(continuous, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const continuousResult = analyzeEdgeContinuity(continuousTrimap, WIDTH, HEIGHT);

    const fragmented = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y += 2) fragmented[y * WIDTH + 15] = 0.5; // every other row only -> many 1px fragments
    const fragmentedTrimap = buildTrimap(fragmented, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const fragmentedResult = analyzeEdgeContinuity(fragmentedTrimap, WIDTH, HEIGHT);

    expect(continuousResult.score).toBeGreaterThan(fragmentedResult.score);
    expect(fragmentedResult.componentCount).toBeGreaterThan(continuousResult.componentCount);
  });

  it("falls back to trimap-boundary adjacency for a purely binary alpha with no UNKNOWN pixels", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 15; x < WIDTH; x++) alpha[y * WIDTH + x] = 1;
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    expect(Array.from(trimap).some((t) => t === TrimapLabel.Unknown)).toBe(false);
    const result = analyzeEdgeContinuity(trimap, WIDTH, HEIGHT);
    expect(result.score).toBeGreaterThan(0.5); // one clean vertical boundary line
  });
});

describe("analyzeHalos", () => {
  it("flags a pixel whose closed-form estimate implausibly overshoots outside [0,255]", () => {
    const rgba = makeFlatRgba(240); // bright background
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const target = 15 * WIDTH + 15;
    alpha[target] = 0.15; // mostly background per alpha
    rgba[target * 4] = 5; // but implausibly dark — inconsistent with that little foreground fraction
    rgba[target * 4 + 1] = 5;
    rgba[target * 4 + 2] = 5;
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const result = analyzeHalos(rgba, alpha, trimap, WIDTH, HEIGHT);
    expect(result.suspectPixelCount).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeGreaterThan(0);
  });

  it("does not flag a well-conditioned, physically plausible semi-transparent edge", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const fg: [number, number, number] = [30, 20, 15];
    const a = 0.5;
    const rgba = makeFlatRgba(0);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
    }
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const target = 15 * WIDTH + 15;
    alpha[target] = a;
    rgba[target * 4] = Math.round(a * fg[0] + (1 - a) * bg[0]);
    rgba[target * 4 + 1] = Math.round(a * fg[1] + (1 - a) * bg[1]);
    rgba[target * 4 + 2] = Math.round(a * fg[2] + (1 - a) * bg[2]);
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const result = analyzeHalos(rgba, alpha, trimap, WIDTH, HEIGHT);
    expect(result.suspectPixelCount).toBe(0);
  });
});

describe("analyzeHolesAndIslands", () => {
  it("counts an enclosed background hole and a disconnected foreground island (not overlapping fine detail)", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) alpha[y * WIDTH + x] = 1; // solid block
    for (let y = 12; y < 15; y++) for (let x = 12; x < 15; x++) alpha[y * WIDTH + x] = 0; // enclosed hole
    for (let y = 27; y < 29; y++) for (let x = 27; x < 29; x++) alpha[y * WIDTH + x] = 1; // disconnected island, far away

    const result = analyzeHolesAndIslands(alpha, null, WIDTH, HEIGHT);
    expect(result.holesCount).toBe(1);
    expect(result.holesArea).toBe(9);
    expect(result.lossIslandsCount).toBe(1);
    expect(result.lossIslandsArea).toBe(4);
  });

  it("excludes an island that substantially overlaps the fine-detail mask from being counted as loss", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) alpha[y * WIDTH + x] = 1;
    for (let y = 27; y < 29; y++) for (let x = 27; x < 29; x++) alpha[y * WIDTH + x] = 1;
    const fineDetailMask = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 27; y < 29; y++) for (let x = 27; x < 29; x++) fineDetailMask[y * WIDTH + x] = 1;

    const result = analyzeHolesAndIslands(alpha, fineDetailMask, WIDTH, HEIGHT);
    expect(result.lossIslandsCount).toBe(0);
  });
});

describe("analyzeHairPreservation", () => {
  it("scores high when hair-candidate pixels retain graded alpha, low when crushed to near-binary", () => {
    const width = 10, height = 10;
    const candidateMask = new Uint8Array(width * height);
    for (let i = 0; i < 5; i++) candidateMask[i] = 1;

    const graded = new Float32Array(width * height).fill(0);
    for (let i = 0; i < 5; i++) graded[i] = 0.5;
    const gradedResult = analyzeHairPreservation(graded, candidateMask);
    expect(gradedResult.score).toBe(1);

    const crushed = new Float32Array(width * height).fill(0);
    for (let i = 0; i < 5; i++) crushed[i] = 1;
    const crushedResult = analyzeHairPreservation(crushed, candidateMask);
    expect(crushedResult.score).toBe(0);
  });

  it("reports noHairDetected (score 1 as a vacuous truth, not praise) when there are no hair candidates", () => {
    const width = 10, height = 10;
    const result = analyzeHairPreservation(new Float32Array(width * height), new Uint8Array(width * height));
    expect(result.noHairDetected).toBe(true);
    expect(result.score).toBe(1);
  });
});

describe("analyzeAlphaDiscontinuity", () => {
  it("flags an isolated single-pixel spike surrounded by uniform alpha outside the unknown band", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);
    alpha[15 * WIDTH + 15] = 0; // a single confidently-background pixel surrounded entirely by confidently-foreground ones
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const result = analyzeAlphaDiscontinuity(alpha, trimap, WIDTH, HEIGHT);
    expect(result.spikeCount).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThan(1);
  });

  it("does not flag pixels inside the unknown transition band", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) alpha[y * WIDTH + x] = x / (WIDTH - 1);
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const result = analyzeAlphaDiscontinuity(alpha, trimap, WIDTH, HEIGHT);
    expect(result.spikeCount).toBe(0);
  });
});

describe("analyzeColourContamination", () => {
  it("scores higher when the edge band shows real background-colour-bleed evidence", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const fg: [number, number, number] = [30, 20, 15];
    const a = 0.5;
    const rgba = makeFlatRgba(0);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
    }
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 10; y < 20; y++) {
      const i = y * WIDTH + 15;
      alpha[i] = a;
      rgba[i * 4] = Math.round(a * fg[0] + (1 - a) * bg[0]);
      rgba[i * 4 + 1] = Math.round(a * fg[1] + (1 - a) * bg[1]);
      rgba[i * 4 + 2] = Math.round(a * fg[2] + (1 - a) * bg[2]);
    }

    const result = analyzeColourContamination(rgba, alpha, WIDTH, HEIGHT);
    expect(result.pixelsAffected).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0);
  });

  it("scores 0 with 0 samples when the alpha has no semi-transparent pixels at all", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);
    const result = analyzeColourContamination(rgba, alpha, WIDTH, HEIGHT);
    expect(result.sampleCount).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe("analyzeResolutionAdequacy", () => {
  it("scores a small image lower than a large one, and lower still when fine detail is present", () => {
    const small = analyzeResolutionAdequacy(100, 100, false);
    const large = analyzeResolutionAdequacy(1920, 1080, false);
    expect(large.score).toBeGreaterThan(small.score);

    const smallWithHair = analyzeResolutionAdequacy(800, 800, true);
    const smallWithoutHair = analyzeResolutionAdequacy(800, 800, false);
    expect(smallWithoutHair.score).toBeGreaterThanOrEqual(smallWithHair.score);
  });
});
