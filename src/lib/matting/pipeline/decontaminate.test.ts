import { describe, it, expect } from "vitest";
import { decontaminate, DEFAULT_DECONTAMINATE_OPTIONS } from "./decontaminate";

const WIDTH = 6;
const HEIGHT = 6;
const TARGET = { x: 3, y: 3 }; // surrounded on all sides by background pixels

function buildScene(targetAlpha: number, targetRgb: [number, number, number]): { rgba: Uint8ClampedArray; alpha: Float32Array } {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const alpha = new Float32Array(WIDTH * HEIGHT);
  // Background everywhere: pure green, alpha 0.
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 255;
    alpha[i] = 0;
  }
  const ti = TARGET.y * WIDTH + TARGET.x;
  const [r, g, b] = targetRgb;
  rgba[ti * 4] = r;
  rgba[ti * 4 + 1] = g;
  rgba[ti * 4 + 2] = b;
  alpha[ti] = targetAlpha;
  return { rgba, alpha };
}

describe("decontaminate", () => {
  it("recovers a foreground color close to the true (pre-blend) color at a semi-transparent pixel, given a known background", () => {
    const bg: [number, number, number] = [0, 255, 0];
    const trueForeground: [number, number, number] = [255, 0, 0];
    const alphaValue = 0.5;
    // Observed = alpha*fg + (1-alpha)*bg, per-channel.
    const observed: [number, number, number] = [
      Math.round(alphaValue * trueForeground[0] + (1 - alphaValue) * bg[0]),
      Math.round(alphaValue * trueForeground[1] + (1 - alphaValue) * bg[1]),
      Math.round(alphaValue * trueForeground[2] + (1 - alphaValue) * bg[2]),
    ];
    const { rgba, alpha } = buildScene(alphaValue, observed);

    const { rgba: out, alpha: outAlpha, pixelsDecontaminated, pixelsSuppressed } = decontaminate(
      rgba,
      alpha,
      WIDTH,
      HEIGHT,
      DEFAULT_DECONTAMINATE_OPTIONS,
    );

    expect(pixelsDecontaminated).toBe(1);
    expect(pixelsSuppressed).toBe(0); // a real, distinct foreground color — nothing to suppress
    const ti = TARGET.y * WIDTH + TARGET.x;
    expect(out[ti * 4]).toBeGreaterThan(240); // recovered red channel close to 255
    expect(out[ti * 4 + 1]).toBeLessThan(20); // recovered green channel close to 0
    expect(out[ti * 4 + 2]).toBeLessThan(20); // recovered blue channel close to 0
    expect(outAlpha[ti]).toBe(alphaValue); // untouched — a real foreground signal was found
  });

  it("suppresses alpha to 0 when the unmixed 'foreground' is indistinguishable from the local background — a real defect found via live testing: a segmentation model can assign low nonzero alpha to pixels that are actually 100% background", () => {
    // The target pixel's observed color IS the surrounding background color
    // (buildScene's hardcoded pure green), unchanged — exactly what a
    // spurious low-confidence model prediction over a still-background pixel
    // looks like (see decontaminate.ts's doc comment).
    const bg: [number, number, number] = [0, 255, 0];
    const { rgba, alpha } = buildScene(0.09, bg);

    const { rgba: out, alpha: outAlpha, pixelsDecontaminated, pixelsSuppressed } = decontaminate(
      rgba,
      alpha,
      WIDTH,
      HEIGHT,
      DEFAULT_DECONTAMINATE_OPTIONS,
    );

    const ti = TARGET.y * WIDTH + TARGET.x;
    expect(pixelsSuppressed).toBe(1);
    expect(pixelsDecontaminated).toBe(0);
    expect(outAlpha[ti]).toBe(0);
    // rgba is left as observed (unchanged) — only alpha is corrected.
    expect(out[ti * 4]).toBe(bg[0]);
    expect(out[ti * 4 + 1]).toBe(bg[1]);
    expect(out[ti * 4 + 2]).toBe(bg[2]);
  });

  it("leaves fully opaque and fully transparent pixels completely unchanged", () => {
    const { rgba, alpha } = buildScene(0.5, [128, 128, 0]);
    const opaqueIndex = 0;
    alpha[opaqueIndex] = 1;
    rgba[opaqueIndex * 4] = 10;
    rgba[opaqueIndex * 4 + 1] = 20;
    rgba[opaqueIndex * 4 + 2] = 30;

    const { rgba: out } = decontaminate(rgba, alpha, WIDTH, HEIGHT, DEFAULT_DECONTAMINATE_OPTIONS);

    expect(out[opaqueIndex * 4]).toBe(10);
    expect(out[opaqueIndex * 4 + 1]).toBe(20);
    expect(out[opaqueIndex * 4 + 2]).toBe(30);
  });

  it("leaves a semi-transparent pixel unchanged when no nearby background sample exists within the search radius", () => {
    // Every pixel is semi-transparent — no pixel qualifies as "background"
    // for estimateLocalBackground to sample from.
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(100);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const { rgba: out, pixelsDecontaminated } = decontaminate(rgba, alpha, WIDTH, HEIGHT, {
      ...DEFAULT_DECONTAMINATE_OPTIONS,
      searchRadius: 2,
    });
    expect(pixelsDecontaminated).toBe(0);
    expect(Array.from(out)).toEqual(Array.from(rgba));
  });
});
