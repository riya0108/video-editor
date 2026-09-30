import { describe, it, expect } from "vitest";
import { smoothAlpha, featherAlpha, antiAliasAlpha } from "./smoothing-ops";
import { TrimapLabel } from "./trimap";

const WIDTH = 8;
const HEIGHT = 8;

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

/** The core requirement across all three operations: "do not apply global blur to the entire alpha; refinement must be edge-aware" — verified directly by checking that every pixel the trimap did NOT mark unknown is byte-for-byte identical to the input, not just "close". */
function expectNonUnknownUntouched(original: Float32Array, result: Float32Array, trimap: Uint8Array) {
  for (let i = 0; i < original.length; i++) {
    if (trimap[i] !== TrimapLabel.Unknown) {
      expect(result[i]).toBe(original[i]);
    }
  }
}

describe("smoothAlpha", () => {
  it("never touches interior foreground/background pixels, only the unknown band", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT);
    const trimap = new Uint8Array(WIDTH * HEIGHT);
    for (let i = 0; i < alpha.length; i++) {
      // Checkerboard of interior fg/bg with a strip of "unknown" down the middle column.
      const x = i % WIDTH;
      if (x === 4) {
        alpha[i] = 0.5;
        trimap[i] = TrimapLabel.Unknown;
      } else if (x < 4) {
        alpha[i] = 0;
        trimap[i] = TrimapLabel.Background;
      } else {
        alpha[i] = 1;
        trimap[i] = TrimapLabel.Foreground;
      }
    }
    const rgba = makeFlatRgba(128);
    const result = smoothAlpha(alpha, rgba, WIDTH, HEIGHT, trimap, { radius: 3, eps: 1e-3 });
    expectNonUnknownUntouched(alpha, result, trimap);
  });

  it("radius 0 is a no-op copy", () => {
    const alpha = new Float32Array([0.2, 0.5, 0.8]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const rgba = new Uint8ClampedArray(3 * 4);
    const out = smoothAlpha(alpha, rgba, 3, 1, trimap, { radius: 0, eps: 1e-3 });
    expect(Array.from(out)).toEqual(Array.from(alpha));
  });
});

describe("featherAlpha", () => {
  it("never touches interior foreground/background pixels", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const trimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Foreground);
    trimap[10] = TrimapLabel.Unknown; // exactly one unknown pixel
    const out = featherAlpha(alpha, WIDTH, HEIGHT, trimap, 2);
    expectNonUnknownUntouched(alpha, out, trimap);
  });

  it("radius 0 is a no-op copy", () => {
    const alpha = new Float32Array([0.3, 0.6]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = featherAlpha(alpha, 2, 1, trimap, 0);
    expect(Array.from(out)).toEqual(Array.from(alpha));
  });

  it("widens a hard transition within the unknown band", () => {
    const width = 10;
    const height = 1;
    const alpha = new Float32Array(width);
    for (let x = 0; x < width; x++) alpha[x] = x < 5 ? 0 : 1;
    const trimap = new Uint8Array(width).fill(TrimapLabel.Unknown);

    const out = featherAlpha(alpha, width, height, trimap, 2);

    // A hard step has exactly one pixel strictly between 0 and 1 in the
    // *bilinear* sense (none, for a pure step) — after feathering, several
    // pixels around the boundary should now hold intermediate values.
    let midCount = 0;
    for (const v of out) if (v > 0.05 && v < 0.95) midCount++;
    expect(midCount).toBeGreaterThan(1);
  });
});

describe("antiAliasAlpha", () => {
  it("never touches interior foreground/background pixels", () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const trimap = new Uint8Array(WIDTH * HEIGHT).fill(TrimapLabel.Background);
    trimap[5] = TrimapLabel.Unknown;
    const out = antiAliasAlpha(alpha, WIDTH, HEIGHT, trimap, 1);
    expectNonUnknownUntouched(alpha, out, trimap);
  });

  it("radius 0 is a no-op copy", () => {
    const alpha = new Float32Array([0.4, 0.6]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = antiAliasAlpha(alpha, 2, 1, trimap, 0);
    expect(Array.from(out)).toEqual(Array.from(alpha));
  });
});
