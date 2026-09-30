import { describe, it, expect } from "vitest";
import { HairRefinementEngine } from "./hair-refinement";
import { buildTrimap, TrimapLabel, DEFAULT_TRIMAP_OPTIONS } from "./trimap";

/**
 * HairRefinementEngine acceptance tests — Phase 3 ("HAIR AND FINE DETAIL
 * REFINEMENT"). Each scenario below is one of the categories explicitly
 * called out in the brief: dark-on-dark, light-on-light, curly, long loose
 * hair, fine strands, and hair against a high-contrast background. Like
 * pipeline.test.ts's Phase 2 visual-regression suite, these use
 * deterministic synthetic scenes with a known correct outcome rather than a
 * hand-labeled photo dataset — there isn't one in this repo (see
 * MATTE_IMPLEMENTATION_PLAN.md section 19).
 */

const WIDTH = 24;
const HEIGHT = 24;

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

/** Alternating-value strip: a real local alpha spread regardless of source-image color contrast — see hair-detector.test.ts for why this is the right synthetic stand-in for "the model sensed some strand structure but the image itself has ~no color contrast to confirm it with". */
function paintAlternatingAlphaStrip(alpha: Float32Array, y: number, x0: number, x1: number, lo: number, hi: number): number[] {
  const idx: number[] = [];
  for (let x = x0; x <= x1; x++) {
    const i = y * WIDTH + x;
    alpha[i] = (x - x0) % 2 === 0 ? hi : lo;
    idx.push(i);
  }
  return idx;
}

describe("HairRefinementEngine.refine", () => {
  it("dark hair on a dark background: detects the strand via alpha structure, expands unknown past the base trimap's confident classification, and keeps the result continuous", () => {
    const rgba = makeFlatRgba(20); // near-black, ~zero color contrast
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // lo/hi sit outside the default trimap's unknown band (0.1-0.9), so the
    // BASE trimap already calls every one of these pixels confidently
    // Background or Foreground — expansion has to do real work here.
    const stripIdx = paintAlternatingAlphaStrip(alpha, 12, 6, 17, 0.05, 0.95);
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    expect(result.pixelsCandidates).toBeGreaterThan(0);

    const wasConfidentButNowExpanded = stripIdx.some(
      (i) => trimap[i] !== TrimapLabel.Unknown && result.expandedTrimap[i] === TrimapLabel.Unknown,
    );
    expect(wasConfidentButNowExpanded).toBe(true);

    const stillGraded = stripIdx.some((i) => result.alpha[i] > 0.01 && result.alpha[i] < 0.99);
    expect(stillGraded).toBe(true);
  });

  it("light hair on a light background: same alpha-structure detection holds with ~zero color contrast in the other direction", () => {
    const rgba = makeFlatRgba(235); // near-white, ~zero color contrast
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const stripIdx = paintAlternatingAlphaStrip(alpha, 12, 6, 17, 0.05, 0.95);
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    expect(result.pixelsCandidates).toBeGreaterThan(0);
    const stillGraded = stripIdx.some((i) => result.alpha[i] > 0.01 && result.alpha[i] < 0.99);
    expect(stillGraded).toBe(true);
  });

  it("curly hair: detects a curved strand via color contrast and does not erode its (already-opaque) alpha", () => {
    const rgba = makeFlatRgba(250);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const curveIdx: number[] = [];
    for (let x = 3; x < WIDTH - 3; x++) {
      const y = 12 + Math.round(5 * Math.sin(x / 2.5));
      const i = y * WIDTH + x;
      rgba[i * 4] = 12;
      rgba[i * 4 + 1] = 9;
      rgba[i * 4 + 2] = 7;
      alpha[i] = 1;
      curveIdx.push(i);
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    let flagged = 0;
    for (const i of curveIdx) if (result.candidateMask[i]) flagged++;
    expect(flagged / curveIdx.length).toBeGreaterThan(0.5);

    const meanAlphaOnCurve = curveIdx.reduce((sum, i) => sum + result.alpha[i], 0) / curveIdx.length;
    expect(meanAlphaOnCurve).toBeGreaterThan(0.7); // still substantially opaque, not eroded away
  });

  it("long loose hair: a thin strand far from the main mass survives refinement instead of being eroded toward the surrounding background", () => {
    const rgba = makeFlatRgba(245);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);

    // A small solid "head" blob.
    for (let y = 4; y < 9; y++) {
      for (let x = 4; x < 9; x++) {
        const i = y * WIDTH + x;
        alpha[i] = 1;
        rgba[i * 4] = 10;
        rgba[i * 4 + 1] = 8;
        rgba[i * 4 + 2] = 6;
      }
    }
    // A long, thin, single-pixel-wide strand trailing far away from the
    // blob — isolated on all sides by pure background.
    const strandIdx: number[] = [];
    for (let x = 10; x < WIDTH - 1; x++) {
      const i = 6 * WIDTH + x;
      alpha[i] = 1;
      rgba[i * 4] = 10;
      rgba[i * 4 + 1] = 8;
      rgba[i * 4 + 2] = 6;
      strandIdx.push(i);
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    const farEnd = strandIdx[strandIdx.length - 1];
    expect(result.alpha[farEnd]).toBeGreaterThan(0.5);
  });

  it("fine strands: several widely-spaced single-pixel-wide lines are preserved without inflating the background between them", () => {
    const rgba = makeFlatRgba(240);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    const lineXs = [5, 11, 17];
    for (const x of lineXs) {
      for (let y = 3; y < HEIGHT - 3; y++) {
        const i = y * WIDTH + x;
        alpha[i] = 1;
        rgba[i * 4] = 6;
        rgba[i * 4 + 1] = 6;
        rgba[i * 4 + 2] = 6;
      }
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    for (const x of lineXs) {
      expect(result.alpha[12 * WIDTH + x]).toBeGreaterThan(0.5);
    }
    const betweenLines = result.alpha[12 * WIDTH + 8];
    expect(betweenLines).toBeLessThan(0.3);
  });

  it("hair against a high-contrast background: decontaminates a background-colour-contaminated strand edge", () => {
    const rgba = makeFlatRgba(255); // pure white background
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 8; y < 16; y++) {
      const i = y * WIDTH + 12;
      alpha[i] = 1;
      rgba[i * 4] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
    }
    // One semi-transparent edge pixel whose observed color is a known blend
    // of the black hair and the white background — a real contamination
    // case, same construction as decontaminate.test.ts.
    const edgeIndex = 12 * WIDTH + 13;
    const edgeAlpha = 0.5;
    alpha[edgeIndex] = edgeAlpha;
    rgba[edgeIndex * 4] = Math.round(edgeAlpha * 0 + (1 - edgeAlpha) * 255);
    rgba[edgeIndex * 4 + 1] = Math.round(edgeAlpha * 0 + (1 - edgeAlpha) * 255);
    rgba[edgeIndex * 4 + 2] = Math.round(edgeAlpha * 0 + (1 - edgeAlpha) * 255);
    const observedBeforeGreen = rgba[edgeIndex * 4 + 1];

    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    expect(result.confidence[12 * WIDTH + 12]).toBeGreaterThan(0.8);
    expect(result.pixelsDecontaminated).toBeGreaterThanOrEqual(1);
    expect(result.rgba[edgeIndex * 4 + 1]).toBeLessThan(observedBeforeGreen);
  });

  it("never mutates its inputs and always stays in [0,1]", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.3);
    const alphaBefore = alpha.slice();
    const rgbaBefore = rgba.slice();
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);

    const engine = new HairRefinementEngine();
    const result = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);

    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    for (const v of result.alpha) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("HairRefinementEngine.refineRegion (local refinement mode)", () => {
  function buildFineStrandScene() {
    const rgba = makeFlatRgba(240);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 3; y < HEIGHT - 3; y++) {
      const i = y * WIDTH + 12;
      alpha[i] = 1;
      rgba[i * 4] = 6;
      rgba[i * 4 + 1] = 6;
      rgba[i * 4 + 2] = 6;
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    return { rgba, alpha, trimap };
  }

  it("an all-zero region mask ('paint nothing') leaves the alpha completely unchanged", () => {
    const { rgba, alpha, trimap } = buildFineStrandScene();
    const regionMask = new Uint8Array(WIDTH * HEIGHT); // all zero

    const engine = new HairRefinementEngine();
    const result = engine.refineRegion(alpha, rgba, WIDTH, HEIGHT, trimap, regionMask);

    expect(Array.from(result.alpha)).toEqual(Array.from(alpha));
    expect(result.pixelsRefined).toBe(0);
  });

  it("only changes pixels inside the painted region (plus its small context margin) — everything else is bit-identical to the input", () => {
    const { rgba, alpha, trimap } = buildFineStrandScene();
    const regionMask = new Uint8Array(WIDTH * HEIGHT);
    // Paint only the top third of the strand.
    for (let y = 3; y < 8; y++) {
      for (let x = 8; x <= 16; x++) regionMask[y * WIDTH + x] = 1;
    }

    const engine = new HairRefinementEngine();
    const full = engine.refine(alpha, rgba, WIDTH, HEIGHT, trimap);
    const local = engine.refineRegion(alpha, rgba, WIDTH, HEIGHT, trimap, regionMask, 4);

    // Far from the painted region (bottom of the strand), local must match
    // the ORIGINAL input exactly, even though the full-image refine would
    // have changed it.
    const farIndex = 20 * WIDTH + 12;
    expect(local.alpha[farIndex]).toBe(alpha[farIndex]);
    expect(full.alpha[farIndex]).not.toBe(alpha[farIndex]);

    // Inside the painted region, local must match what a full refine would
    // have produced there.
    const nearIndex = 5 * WIDTH + 12;
    expect(local.alpha[nearIndex]).toBeCloseTo(full.alpha[nearIndex], 5);
    expect(local.pixelsRefined).toBeGreaterThan(0);
  });
});
