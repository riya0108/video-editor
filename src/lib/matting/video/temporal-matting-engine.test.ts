import { describe, it, expect } from "vitest";
import { TemporalMattingEngine } from "./temporal-matting-engine";

const W = 4;
const H = 4;
const N = W * H;

function flatRgba(gray: number): Uint8ClampedArray {
  return new Uint8ClampedArray(N * 4).fill(gray);
}
function flatAlpha(value: number): Float32Array {
  return new Float32Array(N).fill(value);
}

describe("TemporalMattingEngine — first frame", () => {
  it("passes the raw alpha through unchanged when there is no history yet", () => {
    const engine = new TemporalMattingEngine();
    const raw = flatAlpha(0.7);
    const result = engine.processFrame(flatRgba(100), raw, W, H);
    expect(Array.from(result.alpha)).toEqual(Array.from(raw));
    expect(result.sceneCutDetected).toBe(false);
    expect(result.artifactPixelCount).toBe(0);
    expect(result.frameIndex).toBe(0);
  });
});

describe("TemporalMattingEngine — motion-aware smoothing (not blind blur)", () => {
  it("smooths a static region toward its history when the raw alpha flickers but the image itself didn't move", () => {
    const engine = new TemporalMattingEngine();
    const rgba = flatRgba(100); // identical content every frame -> zero measured motion
    engine.processFrame(rgba, flatAlpha(1), W, H);
    const result = engine.processFrame(rgba, flatAlpha(0), W, H); // raw flips 1 -> 0 with no image change: a flicker

    // weight = maxStaticSmoothing (0.75) here (persistence is only 1 so the
    // occlusion hold doesn't engage yet) -> blended = 0*0.25 + 1*0.75.
    expect(result.meanMotion).toBe(0);
    expect(result.alpha[0]).toBeCloseTo(0.75, 5);
  });

  it("does NOT smooth a genuinely moving region — real movement passes through almost unweighted", () => {
    const engine = new TemporalMattingEngine();
    engine.processFrame(flatRgba(50), flatAlpha(0), W, H);
    const result = engine.processFrame(flatRgba(250), flatAlpha(1), W, H); // huge image change -> motion saturates to 1

    expect(result.meanMotion).toBeCloseTo(1, 5);
    expect(result.alpha[0]).toBeCloseTo(1, 5); // trusts the new raw value almost entirely
  });
});

describe("TemporalMattingEngine — scene cuts", () => {
  it("detects a scene cut and resets state so the cut frame is unblended", () => {
    const engine = new TemporalMattingEngine();
    engine.processFrame(flatRgba(20), flatAlpha(1), W, H);
    const cutResult = engine.processFrame(flatRgba(230), flatAlpha(0.3), W, H); // huge luminance jump

    expect(cutResult.sceneCutDetected).toBe(true);
    expect(Array.from(cutResult.alpha)).toEqual(Array.from(flatAlpha(0.3))); // no blending — state was reset before this frame
  });

  it("resumes ordinary temporal blending on the frame after a cut, using the cut frame as new history", () => {
    const engine = new TemporalMattingEngine();
    engine.processFrame(flatRgba(20), flatAlpha(1), W, H);
    engine.processFrame(flatRgba(230), flatAlpha(0.3), W, H); // the cut
    const result = engine.processFrame(flatRgba(230), flatAlpha(0.9), W, H); // same shot continues, zero motion

    expect(result.sceneCutDetected).toBe(false);
    // weight = 0.75 (persistence too low for a hold — 0.3 wasn't even >0.5): blended = 0.9*0.25 + 0.3*0.75.
    expect(result.alpha[0]).toBeCloseTo(0.45, 5);
  });
});

describe("TemporalMattingEngine — occlusion handling", () => {
  it("holds a brief occlusion instead of instantly trusting the drop, then recovers", () => {
    const engine = new TemporalMattingEngine();
    const rgba = flatRgba(100); // static scene throughout
    // Build up real persistence first — several stable, confidently-opaque frames.
    for (let i = 0; i < 5; i++) engine.processFrame(rgba, flatAlpha(1), W, H);

    const drop1 = engine.processFrame(rgba, flatAlpha(0), W, H); // occluder appears
    const drop2 = engine.processFrame(rgba, flatAlpha(0), W, H);
    const recovered = engine.processFrame(rgba, flatAlpha(1), W, H); // occluder gone

    expect(drop1.alpha[0]).toBeGreaterThan(0.5); // held, not instantly zeroed
    expect(drop2.alpha[0]).toBeGreaterThan(0.3);
    expect(recovered.alpha[0]).toBeGreaterThan(0.5); // recovers rather than staying damaged
  });

  it("still respects a SUSTAINED drop (genuine exit) once it outlasts the hold window, rather than holding forever", () => {
    const engine = new TemporalMattingEngine({ occlusionHoldFrames: 3 });
    const rgba = flatRgba(100);
    for (let i = 0; i < 5; i++) engine.processFrame(rgba, flatAlpha(1), W, H);

    let last = engine.processFrame(rgba, flatAlpha(0), W, H);
    for (let i = 0; i < 30; i++) last = engine.processFrame(rgba, flatAlpha(0), W, H);

    expect(last.alpha[0]).toBeLessThan(0.15);
  });
});

describe("TemporalMattingEngine — temporal artifact detection", () => {
  it("flags a pixel whose (post-smoothing) alpha still jumped a lot despite near-zero image motion", () => {
    const engine = new TemporalMattingEngine({ artifactAlphaThreshold: 0.2 });
    const rgba = flatRgba(100);
    engine.processFrame(rgba, flatAlpha(0), W, H);
    const result = engine.processFrame(rgba, flatAlpha(1), W, H); // zero motion, big raw jump

    expect(result.meanMotion).toBe(0);
    expect(result.artifactPixelCount).toBe(N);
  });

  it("does not flag ordinary, expected smoothing residue at the default (higher) threshold", () => {
    const engine = new TemporalMattingEngine();
    const rgba = flatRgba(100);
    engine.processFrame(rgba, flatAlpha(0), W, H);
    const result = engine.processFrame(rgba, flatAlpha(1), W, H);
    expect(result.artifactPixelCount).toBe(0);
  });
});

describe("TemporalMattingEngine — resolution changes and explicit reset", () => {
  it("treats a mid-stream resolution change as a fresh start rather than crashing or mixing buffers", () => {
    const engine = new TemporalMattingEngine();
    engine.processFrame(flatRgba(100), flatAlpha(1), W, H);
    const bigRgba = new Uint8ClampedArray(8 * 8 * 4).fill(50);
    const bigRaw = new Float32Array(64).fill(0.4);
    const result = engine.processFrame(bigRgba, bigRaw, 8, 8);
    expect(Array.from(result.alpha)).toEqual(Array.from(bigRaw));
  });

  it("resetTemporalState() makes the next frame behave like the very first frame", () => {
    const engine = new TemporalMattingEngine();
    engine.processFrame(flatRgba(100), flatAlpha(1), W, H);
    engine.resetTemporalState();
    const raw = flatAlpha(0.42);
    const result = engine.processFrame(flatRgba(100), raw, W, H);
    expect(Array.from(result.alpha)).toEqual(Array.from(raw));
    expect(result.frameIndex).toBe(0);
  });
});

describe("TemporalMattingEngine — checkpoint / resume", () => {
  it("a checkpoint restored into a fresh engine produces identical output to the original continuing", () => {
    const original = new TemporalMattingEngine();
    original.processFrame(flatRgba(100), flatAlpha(0.6), W, H);
    original.processFrame(flatRgba(105), flatAlpha(0.65), W, H);

    const checkpoint = original.getCheckpoint();
    const resumed = TemporalMattingEngine.fromCheckpoint(checkpoint);

    const nextRgba = flatRgba(140);
    const nextRaw = flatAlpha(0.8);
    const fromOriginal = original.processFrame(nextRgba, nextRaw, W, H);
    const fromResumed = resumed.processFrame(nextRgba, nextRaw, W, H);

    expect(Array.from(fromResumed.alpha)).toEqual(Array.from(fromOriginal.alpha));
    expect(fromResumed.frameIndex).toBe(fromOriginal.frameIndex);
  });
});
