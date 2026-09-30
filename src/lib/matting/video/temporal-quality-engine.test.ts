import { describe, it, expect } from "vitest";
import { TemporalMatteQualityEngine, TemporalInstabilityKind } from "./temporal-quality-engine";

const W = 20;
const H = 20;

function flatRgba(gray: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** A stable solid block, alpha 1 inside [4,16)x[4,16), 0 elsewhere. `hasHole` punches a small 3x3 background pocket in the middle for that frame only. */
function makeBlockAlpha(hasHole = false): Float32Array {
  const alpha = new Float32Array(W * H).fill(0);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) alpha[y * W + x] = 1;
  if (hasHole) for (let y = 9; y < 12; y++) for (let x = 9; x < 12; x++) alpha[y * W + x] = 0;
  return alpha;
}

describe("TemporalMatteQualityEngine — stable sequence", () => {
  it("raises no events and reports high overall quality for a consistent, unchanging sequence", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    for (let i = 0; i < 6; i++) engine.observeFrame(makeBlockAlpha(false), rgba, W, H);
    const report = engine.finalize();

    expect(report.events).toHaveLength(0);
    expect(report.needsReview).toBe(false);
    expect(report.overallTemporalQuality).toBeGreaterThan(0.9);
    expect(report.framesAnalyzed).toBe(6);
  });
});

describe("TemporalMatteQualityEngine — sudden opacity change: full remediation workflow", () => {
  it("a moderate one-frame spike is detected, localized, corrected, and re-evaluated as resolved", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    const stable = new Float32Array(W * H).fill(0);
    const spiked = stable.slice();
    for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) spiked[y * W + x] = 0.6; // moderate, correctable spike

    engine.observeFrame(stable, rgba, W, H);
    engine.observeFrame(spiked, rgba, W, H);
    const report = engine.finalize();

    const event = report.events.find((e) => e.kind === TemporalInstabilityKind.SuddenOpacityChange);
    expect(event).toBeDefined();
    // 1. frame range identified
    expect(event!.frameRange).toEqual({ start: 0, end: 1 });
    // 2. region identified — the exact 3x3 patch, not the whole frame
    expect(event!.region).toEqual({ x: 5, y: 5, width: 3, height: 3 });
    // 3 & 4. correction attempted and re-evaluated
    expect(event!.correctionAttempted).toBe(true);
    expect(event!.severityAfterCorrection).toBeLessThan(event!.severity);
    // 5. resolved -> not flagged for review
    expect(event!.resolved).toBe(true);
    expect(event!.needsHumanReview).toBe(false);
  });

  it("a severe, uncorrectable spike is still flagged for human review after a failed correction attempt — 'do not hide failures'", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    const stable = new Float32Array(W * H).fill(0);
    const spiked = stable.slice();
    for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) spiked[y * W + x] = 1; // full jump — a simple 2-tap average can't fix this

    engine.observeFrame(stable, rgba, W, H);
    engine.observeFrame(spiked, rgba, W, H);
    const report = engine.finalize();

    const event = report.events.find((e) => e.kind === TemporalInstabilityKind.SuddenOpacityChange);
    expect(event).toBeDefined();
    expect(event!.correctionAttempted).toBe(true);
    expect(event!.resolved).toBe(false);
    expect(event!.needsHumanReview).toBe(true);
    expect(report.needsReview).toBe(true);
    expect(report.unresolvedEvents).toContain(event);
    expect(report.warnings.some((w) => w.includes("still unstable"))).toBe(true);
  });
});

describe("TemporalMatteQualityEngine — temporal holes: uses real lookahead and a true 3-tap correction", () => {
  it("a hole present only in the middle frame is detected, corrected via 3-frame median, and resolved", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    engine.observeFrame(makeBlockAlpha(false), rgba, W, H); // frame 0: no hole
    engine.observeFrame(makeBlockAlpha(true), rgba, W, H); // frame 1: transient hole
    engine.observeFrame(makeBlockAlpha(false), rgba, W, H); // frame 2: no hole again
    const report = engine.finalize();

    const event = report.events.find((e) => e.kind === TemporalInstabilityKind.TemporalHole);
    expect(event).toBeDefined();
    expect(event!.frameRange).toEqual({ start: 1, end: 1 }); // the middle (transient) frame specifically
    expect(event!.region.width).toBeGreaterThan(0);
    expect(event!.correctionAttempted).toBe(true);
    expect(event!.resolved).toBe(true);
  });

  it("a hole present across all three frames is a real, sustained feature, not a temporal artifact — no event", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    for (let i = 0; i < 3; i++) engine.observeFrame(makeBlockAlpha(true), rgba, W, H);
    const report = engine.finalize();
    expect(report.events.filter((e) => e.kind === TemporalInstabilityKind.TemporalHole)).toHaveLength(0);
  });
});

describe("TemporalMatteQualityEngine — temporal leakage: honestly never attempts correction", () => {
  it("volatile leakage over the rolling window is flagged directly for human review, with no correction attempt", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    const pattern = [false, true, false, true, false, true];
    for (const hasHole of pattern) engine.observeFrame(makeBlockAlpha(hasHole), rgba, W, H);
    const report = engine.finalize();

    const event = report.events.find((e) => e.kind === TemporalInstabilityKind.TemporalLeakage);
    expect(event).toBeDefined();
    expect(event!.correctionAttempted).toBe(false);
    expect(event!.severityAfterCorrection).toBeNull();
    expect(event!.resolved).toBe(false);
    expect(event!.needsHumanReview).toBe(true);
  });
});

describe("TemporalMatteQualityEngine — report shape", () => {
  it("never mutates its inputs and always returns scores in [0,1]", () => {
    const engine = new TemporalMatteQualityEngine();
    const rgba = flatRgba(120);
    const rgbaBefore = rgba.slice();
    const alpha = makeBlockAlpha(false);
    const alphaBefore = alpha.slice();

    engine.observeFrame(alpha, rgba, W, H);
    engine.observeFrame(makeBlockAlpha(true), rgba, W, H);
    const report = engine.finalize();

    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    for (const v of Object.values(report.metrics)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(report.overallTemporalQuality).toBeGreaterThanOrEqual(0);
    expect(report.overallTemporalQuality).toBeLessThanOrEqual(1);
  });
});
