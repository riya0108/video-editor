import { describe, it, expect } from "vitest";
import { MatteQualityEngine, RecommendedAction } from "./matte-quality-engine";

const WIDTH = 60;
const HEIGHT = 60;

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

/** A clean, well-behaved matte: a solid block with a soft (but not overly wide) graded edge on a flat, non-contaminating background — nothing here should trip any warning. */
function makeCleanScene() {
  const rgba = makeFlatRgba(235);
  const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
  const cx = 30, cy = 30, r = 18, feather = 3;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const t = (r + feather - d) / (2 * feather);
      const a = Math.min(1, Math.max(0, t));
      alpha[y * WIDTH + x] = a;
      const i = (y * WIDTH + x) * 4;
      rgba[i] = Math.round(a * 40 + (1 - a) * 235);
      rgba[i + 1] = Math.round(a * 35 + (1 - a) * 235);
      rgba[i + 2] = Math.round(a * 30 + (1 - a) * 235);
    }
  }
  return { rgba, alpha };
}

// The default resolution-adequacy thresholds are calibrated for real photos
// (a few hundred px) — a 60x60 test fixture is "inadequate" by those
// defaults regardless of matte quality, which would otherwise confound
// tests that are really about something else. Lowered here so these tests
// isolate the dimension they actually name.
const LENIENT_RESOLUTION = { resolutionLowThreshold: 5, resolutionHighThreshold: 40, resolutionHighThresholdWithFineDetail: 40 };

describe("MatteQualityEngine.analyze — overall behavior", () => {
  it("reports a clean matte as high quality with no warnings and no review flag", () => {
    const { rgba, alpha } = makeCleanScene();
    const report = new MatteQualityEngine(LENIENT_RESOLUTION).analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.overallQuality).toBeGreaterThan(0.6);
    expect(report.needsReview).toBe(false);
    expect(report.recommendedActions).not.toContain(RecommendedAction.HumanReview);
    expect(report.leakageScore).toBe(0);
    expect(report.haloScore).toBe(0);
  });

  it("never produces NaN or out-of-range scores, even for degenerate all-zero or all-one alpha", () => {
    const rgba = makeFlatRgba(128);
    for (const fill of [0, 1]) {
      const alpha = new Float32Array(WIDTH * HEIGHT).fill(fill);
      const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);
      for (const v of [report.overallQuality, report.confidence, report.edgeQuality, report.hairQuality, report.leakageScore, report.haloScore, report.contaminationScore, report.fragmentationScore]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never mutates its inputs", () => {
    const { rgba, alpha } = makeCleanScene();
    const rgbaBefore = rgba.slice();
    const alphaBefore = alpha.slice();
    new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);
    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
  });

  it("never names its scoring anything resembling a 'Photoshop score', per the explicit instruction", () => {
    const { rgba, alpha } = makeCleanScene();
    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);
    const serialized = JSON.stringify(report).toLowerCase();
    expect(serialized).not.toContain("photoshop");
  });
});

describe("MatteQualityEngine.analyze — background leakage (holes)", () => {
  it("flags an enclosed hole, raises leakageScore, warns, and recommends local refinement with a problem region", () => {
    const { rgba, alpha } = makeCleanScene();
    for (let y = 27; y < 33; y++) for (let x = 27; x < 33; x++) alpha[y * WIDTH + x] = 0; // punch a hole in the solid interior

    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.leakageScore).toBeGreaterThan(0);
    expect(report.warnings.some((w) => /leakage/i.test(w))).toBe(true);
    expect(report.recommendedActions).toContain(RecommendedAction.LocalRefinement);
    expect(report.problemRegions.length).toBeGreaterThan(0);
  });
});

describe("MatteQualityEngine.analyze — halo", () => {
  it("flags an implausible colour-overshoot edge, raises haloScore, and recommends additional refinement", () => {
    const rgba = makeFlatRgba(245); // bright background
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 20; y < 40; y++) {
      for (let x = 20; x < 40; x++) {
        const i = y * WIDTH + x;
        alpha[i] = 0.15; // mostly-background alpha
        rgba[i * 4] = 5; // implausibly dark given that alpha and a bright background
        rgba[i * 4 + 1] = 5;
        rgba[i * 4 + 2] = 5;
      }
    }

    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.haloScore).toBeGreaterThan(0);
    expect(report.recommendedActions).toContain(RecommendedAction.AdditionalRefinement);
  });
});

describe("MatteQualityEngine.analyze — fragmentation", () => {
  it("flags foreground fragments disconnected from the main mass as fragmentation, not as hair", () => {
    const { rgba, alpha } = makeCleanScene();
    for (let y = 50; y < 54; y++) for (let x = 50; x < 54; x++) {
      alpha[y * WIDTH + x] = 1; // a stray disconnected opaque blob, far from the main subject, flat-coloured (not hair-like)
      const i = (y * WIDTH + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 235; // same as the background — no fine-detail texture
    }

    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.fragmentationScore).toBeGreaterThan(0);
    expect(report.recommendedActions).toContain(RecommendedAction.LocalRefinement);
  });
});

describe("MatteQualityEngine.analyze — hair preservation", () => {
  it("flags crushed (near-binary) alpha in a region the hair detector identifies as fine detail", () => {
    const rgba = makeFlatRgba(250);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // Solid subject block.
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) alpha[y * WIDTH + x] = 1;
    // A strand region with real colour texture (so the hair detector flags
    // it) but alpha crushed to hard 0/1 instead of graded.
    for (let y = 10; y < 40; y++) {
      const i = y * WIDTH + 42;
      alpha[i] = 1;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 10;
    }

    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.details.hairPreservation.noHairDetected).toBe(false);
    expect(report.hairQuality).toBeLessThan(1);
  });

  it("reports full hairQuality without praise semantics when no hair signal exists at all", () => {
    // Flat colour AND flat alpha, with no edge anywhere at all: hair-
    // detector.ts's alpha-variance cue is sensitive enough that even an
    // ordinary gradual ramp's local variance clears its default threshold
    // (found empirically while writing this test — the same over-triggering
    // class documented in classical-edge-classifier.ts, which gates it with
    // an oscillation check this engine doesn't apply). A genuinely edge-free
    // field is the honest way to get zero candidates, not a fabricated one.
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1);

    const report = new MatteQualityEngine(LENIENT_RESOLUTION).analyze(alpha, rgba, WIDTH, HEIGHT);
    expect(report.details.hairPreservation.noHairDetected).toBe(true);
    expect(report.hairQuality).toBe(1);
  });
});

describe("MatteQualityEngine.analyze — low confidence triggers review", () => {
  it("marks needsReview and recommends human review when confidence is low", () => {
    // A non-bimodal, mushy alpha (everything hovering around 0.5) with no
    // clear foreground/background commitment at all — genuinely low
    // confidence, not an artificially forced flag.
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);

    const report = new MatteQualityEngine().analyze(alpha, rgba, WIDTH, HEIGHT);

    expect(report.confidence).toBeLessThan(0.4);
    expect(report.needsReview).toBe(true);
    expect(report.recommendedActions).toContain(RecommendedAction.HumanReview);
    expect(report.warnings.some((w) => /review/i.test(w))).toBe(true);
  });

  it("a caller-supplied confidenceReviewThreshold changes the review outcome for the same input", () => {
    const { rgba, alpha } = makeCleanScene();
    const lenient = new MatteQualityEngine({ confidenceReviewThreshold: 0 }).analyze(alpha, rgba, WIDTH, HEIGHT);
    const strict = new MatteQualityEngine({ confidenceReviewThreshold: 0.999 }).analyze(alpha, rgba, WIDTH, HEIGHT);
    expect(lenient.needsReview).toBe(false);
    expect(strict.needsReview).toBe(true);
  });
});
