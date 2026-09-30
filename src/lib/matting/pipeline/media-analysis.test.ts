import { describe, it, expect } from "vitest";
import { analyzeMedia } from "./media-analysis";

function makeOpaqueRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return rgba;
}

describe("analyzeMedia", () => {
  it("defaults subjectHint to 'unknown' when no explicit hint is given — this app has no real subject detector yet", () => {
    const rgba = makeOpaqueRgba(4, 4);
    const analysis = analyzeMedia(rgba, 4, 4);
    expect(analysis.subjectHint).toBe("unknown");
  });

  it("passes an explicit subject hint through unchanged", () => {
    const rgba = makeOpaqueRgba(4, 4);
    const analysis = analyzeMedia(rgba, 4, 4, "portrait");
    expect(analysis.subjectHint).toBe("portrait");
  });

  it("computes aspect ratio from width/height", () => {
    const analysis = analyzeMedia(makeOpaqueRgba(16, 9), 16, 9);
    expect(analysis.aspectRatio).toBeCloseTo(16 / 9, 5);
  });

  it("detects a fully opaque image as having no existing alpha", () => {
    const analysis = analyzeMedia(makeOpaqueRgba(4, 4), 4, 4);
    expect(analysis.hasExistingAlpha).toBe(false);
  });

  it("detects existing transparency from real pixel data, not a guess", () => {
    const rgba = makeOpaqueRgba(4, 4);
    rgba[4 * 4 * 4 - 1] = 128; // make the last pixel's alpha channel non-opaque
    const analysis = analyzeMedia(rgba, 4, 4);
    expect(analysis.hasExistingAlpha).toBe(true);
  });
});
