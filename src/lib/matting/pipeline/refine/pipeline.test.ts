import { describe, it, expect } from "vitest";
import { refineAlphaMatte } from "./pipeline";
import { TrimapLabel } from "./trimap";

/**
 * "Visual regression tests using known input images" — this repo has no
 * hand-labeled ground-truth photo dataset (see MATTE_IMPLEMENTATION_PLAN.md
 * section 19's honest limitation on that), so these use deterministic
 * synthetic shapes with a KNOWN correct outcome instead of golden-image
 * diffing: a circle with a deliberate hole, a deliberate disconnected noise
 * speck, and a deliberate disconnected-but-textured "hair wisp". Each
 * assertion is about a specific, predictable pixel/region, not a fuzzy
 * "looks about right" comparison.
 */

const WIDTH = 40;
const HEIGHT = 40;

function makeCircleAlpha(cx: number, cy: number, r: number): Float32Array {
  const alpha = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      alpha[y * WIDTH + x] = Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
    }
  }
  return alpha;
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

describe("refineAlphaMatte — visual regression on known synthetic shapes", () => {
  it("fills a small enclosed hole and removes a small disconnected noise speck on a plain background, while preserving the main shape", () => {
    const alpha = makeCircleAlpha(20, 20, 10);
    alpha[20 * WIDTH + 20] = 0; // hole in the dead center of the circle
    alpha[2 * WIDTH + 2] = 1; // disconnected speck, far corner, on a flat (non-textured) background

    const rgba = makeFlatRgba(128); // no image texture anywhere -> no fine-detail exception applies

    const result = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT);

    expect(result.holesFilled).toBeGreaterThanOrEqual(1);
    expect(result.alpha[20 * WIDTH + 20]).toBeGreaterThan(0.9); // hole filled back to solid

    expect(result.islandsRemoved).toBeGreaterThanOrEqual(1);
    expect(result.alpha[2 * WIDTH + 2]).toBeLessThan(0.1); // speck suppressed

    expect(result.alpha[0]).toBeLessThan(0.1); // real background corner, untouched
  });

  it("preserves a thin, disconnected, texture-correlated tail (e.g. a hair wisp) instead of erasing it as noise", () => {
    const alpha = makeCircleAlpha(20, 25, 8);
    const rgba = makeFlatRgba(30); // dark background everywhere else

    // A short, fully-opaque, disconnected line of alpha — same shape of
    // "problem" as the noise speck above — but this time positioned over a
    // genuine high-frequency pattern in the source image, so
    // buildFineDetailMask has real texture to detect (contrast with the
    // previous test's speck, which sat on a flat background and was
    // correctly removed). Uses 2-pixel-wide blocks, not single-pixel
    // alternation: a plain Sobel kernel has a real mathematical blind spot
    // at exactly the Nyquist frequency (period-2), so a naive per-pixel
    // checkerboard/stripe produces identically zero gradient everywhere —
    // see trimap.test.ts's makeNoisyRgba comment for the full explanation.
    const tailY = 5;
    const tailXs = [9, 10, 11, 12, 13, 14, 15];
    for (const x of tailXs) {
      alpha[tailY * WIDTH + x] = 1;
      const bright = Math.floor((x - tailXs[0]) / 2) % 2 === 0 ? 230 : 15;
      const o = (tailY * WIDTH + x) * 4;
      rgba[o] = bright;
      rgba[o + 1] = bright;
      rgba[o + 2] = bright;
    }

    const result = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT);

    expect(result.islandsPreserved).toBeGreaterThanOrEqual(1);
    expect(result.islandsRemoved).toBe(0);
    for (const x of tailXs) {
      // The whole tail should have survived as one preserved island — cleanup.ts
      // preserves or removes an island as a unit, not pixel-by-pixel.
      expect(result.alpha[tailY * WIDTH + x]).toBeGreaterThan(0.3);
    }
  });

  it("classifies interior foreground, interior background, and the transition band correctly on a soft-edged circle", () => {
    const cx = 20;
    const cy = 20;
    const r = 10;
    const featherWidth = 3;
    const alpha = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const t = (r + featherWidth - d) / (2 * featherWidth);
        alpha[y * WIDTH + x] = Math.min(1, Math.max(0, t));
      }
    }
    const rgba = makeFlatRgba(100);

    const result = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT);

    expect(result.trimap[cy * WIDTH + cx]).toBe(TrimapLabel.Foreground); // deep interior
    expect(result.trimap[0]).toBe(TrimapLabel.Background); // far corner
    expect(result.trimap[cy * WIDTH + (cx + r)]).toBe(TrimapLabel.Unknown); // right on the original feather ring
  });

  it("never produces out-of-range alpha values and never mutates its inputs", () => {
    const alpha = makeCircleAlpha(20, 20, 10);
    const rgba = makeFlatRgba(128);
    const alphaBefore = alpha.slice();
    const rgbaBefore = rgba.slice();

    const result = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT);

    for (const v of result.alpha) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
  });

  it("exposes tunable parameters through the internal API without requiring any UI change — e.g. a caller-requested edge expansion measurably grows the matte", () => {
    const alpha = makeCircleAlpha(20, 20, 5);
    const rgba = makeFlatRgba(128);

    const grown = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT, { contractExpand: { amount: 3 } });
    const shrunk = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT, { contractExpand: { amount: -3 } });

    const justOutsideOriginalRadius = 20 + 6; // radius was 5
    expect(grown.alpha[20 * WIDTH + justOutsideOriginalRadius]).toBeGreaterThan(
      shrunk.alpha[20 * WIDTH + justOutsideOriginalRadius],
    );
  });

  it("default parameters leave the four 'creative' shaping tools (contract/expand, shift-edge, contrast, feather) as true no-ops", () => {
    const alpha = makeCircleAlpha(20, 20, 10);
    const rgba = makeFlatRgba(128);
    const withDefaults = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT);
    const withExplicitNoops = refineAlphaMatte(alpha, rgba, WIDTH, HEIGHT, {
      contractExpand: { amount: 0 },
      shiftEdge: { bias: 0 },
      contrast: { amount: 0 },
      feather: { radius: 0 },
    });
    expect(Array.from(withDefaults.alpha)).toEqual(Array.from(withExplicitNoops.alpha));
  });
});
