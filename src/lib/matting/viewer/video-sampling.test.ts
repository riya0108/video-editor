import { describe, it, expect } from "vitest";
import { nearestSampleAtOrBefore, type ViewerSample } from "./video-sampling";

/**
 * `sampleVideoMatte` itself needs a real `<video>`/canvas and isn't unit-
 * tested under Vitest (no canvas implementation in this repo's plain-Node
 * test environment — same convention as dom-io.ts) — verified manually in
 * the browser instead. `nearestSampleAtOrBefore` is pure and gets real
 * coverage here.
 */
function makeSample(time: number): ViewerSample {
  return { time, alpha: new Float32Array(0), sourceRgba: new Uint8ClampedArray(0), foreground: {} as HTMLCanvasElement, width: 0, height: 0, warnings: [], modelUsed: "test" };
}

describe("nearestSampleAtOrBefore", () => {
  it("returns null for an empty list", () => {
    expect(nearestSampleAtOrBefore([], 1)).toBeNull();
  });

  it("picks the exact match when one exists", () => {
    const samples = [makeSample(0), makeSample(1), makeSample(2)];
    expect(nearestSampleAtOrBefore(samples, 1)?.time).toBe(1);
  });

  it("holds the most recent sample at-or-before the requested time (sample-and-hold)", () => {
    const samples = [makeSample(0), makeSample(1), makeSample(2)];
    expect(nearestSampleAtOrBefore(samples, 1.9)?.time).toBe(1);
  });

  it("falls back to the first sample when the requested time is before every sample", () => {
    const samples = [makeSample(5), makeSample(6)];
    expect(nearestSampleAtOrBefore(samples, 0)?.time).toBe(5);
  });

  it("returns the last sample when the requested time is after every sample", () => {
    const samples = [makeSample(0), makeSample(1), makeSample(2)];
    expect(nearestSampleAtOrBefore(samples, 100)?.time).toBe(2);
  });
});
