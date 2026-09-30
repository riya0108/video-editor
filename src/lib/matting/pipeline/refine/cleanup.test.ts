import { describe, it, expect } from "vitest";
import { cleanupHolesAndIslands, DEFAULT_CLEANUP_OPTIONS } from "./cleanup";

const WIDTH = 9;
const HEIGHT = 9;

/** A solid 7x7 foreground square (indices 1..7) centered in a 9x9 canvas of background. */
function makeSolidSquare(): Float32Array {
  const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
  for (let y = 1; y <= 7; y++) {
    for (let x = 1; x <= 7; x++) alpha[y * WIDTH + x] = 1;
  }
  return alpha;
}

describe("cleanupHolesAndIslands — small-hole cleanup", () => {
  it("fills a small enclosed hole inside the foreground", () => {
    const alpha = makeSolidSquare();
    alpha[4 * WIDTH + 4] = 0; // one background pixel enclosed in the middle of the square

    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, DEFAULT_CLEANUP_OPTIONS);

    expect(result.holesFilled).toBe(1);
    expect(result.alpha[4 * WIDTH + 4]).toBe(1);
  });

  it("does not fill the real exterior background, even though it's also alpha 0", () => {
    const alpha = makeSolidSquare(); // no hole this time, just the square + real surrounding background
    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, DEFAULT_CLEANUP_OPTIONS);
    expect(result.holesFilled).toBe(0);
    expect(result.alpha[0]).toBe(0); // corner of the real background, untouched
  });

  it("does not fill a hole larger than maxHoleSize", () => {
    const alpha = makeSolidSquare();
    // A 3x3 enclosed hole (9 pixels) in the middle.
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) alpha[y * WIDTH + x] = 0;
    }
    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, { ...DEFAULT_CLEANUP_OPTIONS, maxHoleSize: 4 });
    expect(result.holesFilled).toBe(0);
    expect(result.alpha[4 * WIDTH + 4]).toBe(0); // left as-is, too big to be a "small" hole
  });
});

describe("cleanupHolesAndIslands — small-island cleanup", () => {
  it("suppresses a small disconnected foreground speck", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    alpha[0] = 1; // a lone speck, disconnected from everything

    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, DEFAULT_CLEANUP_OPTIONS);

    expect(result.islandsRemoved).toBe(1);
    expect(result.alpha[0]).toBe(0);
  });

  it("leaves the main foreground mass alone (it's above maxIslandSize)", () => {
    const alpha = makeSolidSquare(); // 49 pixels, well above the default maxIslandSize
    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, DEFAULT_CLEANUP_OPTIONS);
    expect(result.islandsRemoved).toBe(0);
    expect(result.alpha[4 * WIDTH + 4]).toBe(1); // center of the square, untouched
  });

  it("does NOT suppress a small island when fine-detail preservation applies", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    alpha[0] = 1; // same lone speck as the earlier test

    const fineDetailMask = new Uint8Array(WIDTH * HEIGHT);
    fineDetailMask[0] = 1; // flagged as genuine fine detail (e.g. an isolated hair wisp)

    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, fineDetailMask, DEFAULT_CLEANUP_OPTIONS);

    expect(result.islandsRemoved).toBe(0);
    expect(result.islandsPreserved).toBe(1);
    expect(result.alpha[0]).toBe(1); // preserved exactly as it was
  });

  it("still suppresses an island whose fine-detail overlap is below the threshold", () => {
    // A 4-pixel island where only 1 pixel (25%) is flagged fine-detail —
    // below the default 20%... wait, exactly at 25% > 20% would preserve;
    // use a bigger island so 1 pixel is clearly under threshold instead.
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const islandPixels = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]; // 10-pixel island (row0 cols0-7, row1 cols0-1), all disconnected from the real background via being foreground
    for (const i of islandPixels) alpha[i] = 1;
    const fineDetailMask = new Uint8Array(WIDTH * HEIGHT);
    fineDetailMask[0] = 1; // 1 of 10 pixels = 10%, below the 20% default threshold

    const result = cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, fineDetailMask, { ...DEFAULT_CLEANUP_OPTIONS, maxIslandSize: 12 });

    expect(result.islandsRemoved).toBe(1);
    expect(result.islandsPreserved).toBe(0);
  });
});

describe("cleanupHolesAndIslands — non-destructive", () => {
  it("returns a new array, never mutates the input", () => {
    const alpha = makeSolidSquare();
    alpha[4 * WIDTH + 4] = 0;
    const original = alpha.slice();
    cleanupHolesAndIslands(alpha, WIDTH, HEIGHT, null, DEFAULT_CLEANUP_OPTIONS);
    expect(Array.from(alpha)).toEqual(Array.from(original));
  });
});
