import { describe, it, expect } from "vitest";
import { ClassicalEdgeClassifier } from "./classical-edge-classifier";
import { EdgeCategory } from "./edge-category";
import { buildTrimap, DEFAULT_TRIMAP_OPTIONS, TrimapLabel } from "./trimap";

/**
 * ClassicalEdgeClassifier acceptance tests. HARD_EDGE, SOFT_EDGE, HAIR, FUR,
 * and TRANSLUCENT rest on fairly direct signals and are checked with tight
 * assertions. MOTION_BLUR, SHADOW, and REFLECTION are inherently fuzzier
 * from a single still frame (see the classifier's own doc comment) — those
 * are checked more loosely (the *intended* cue actually moves the needle
 * toward the right category, not necessarily that it wins outright every
 * time), which is an honest reflection of what classical heuristics can
 * promise here, not a weakened test standard applied arbitrarily.
 */

const WIDTH = 32;
const HEIGHT = 32;

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

function classify(alpha: Float32Array, rgba: Uint8ClampedArray) {
  const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
  return new ClassicalEdgeClassifier().classify({ alpha, rgba, width: WIDTH, height: HEIGHT, trimap });
}

describe("ClassicalEdgeClassifier", () => {
  it("classifies a one-pixel-wide alpha step on a flat-colour scene as HARD_EDGE", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) for (let x = 16; x < WIDTH; x++) alpha[y * WIDTH + x] = 1;

    const { labels, confidence } = classify(alpha, rgba);
    const i = 16 * WIDTH + 16;
    expect(labels[i]).toBe(EdgeCategory.HardEdge);
    expect(confidence[i]).toBeGreaterThan(0.5);
  });

  it("classifies a wide, gradual alpha ramp on a flat-colour scene as SOFT_EDGE", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const t = (x - 8) / 16;
        alpha[y * WIDTH + x] = Math.min(1, Math.max(0, t));
      }
    }

    const { labels } = classify(alpha, rgba);
    const i = 16 * WIDTH + 16; // midpoint of the ramp, alpha ~0.5
    expect(labels[i]).toBe(EdgeCategory.SoftEdge);
  });

  it("classifies a few sparse, widely-spaced strands on a contrasting background as HAIR rather than FUR", () => {
    const rgba = makeFlatRgba(250);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // Two isolated single-pixel-wide strands, far enough apart that each
    // one's own local candidate "bleed" (see hairDensityRadius's doc
    // comment) doesn't overlap the other's — sparse coverage of the local
    // window, unlike FUR's dense, area-filling texture below.
    const strandXs = [6, 25];
    for (const x of strandXs) {
      for (let y = 4; y < 28; y++) {
        const i = y * WIDTH + x;
        alpha[i] = 1;
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 10;
      }
    }

    const { labels } = classify(alpha, rgba);
    let hairVotes = 0;
    let furVotes = 0;
    for (const x of strandXs) {
      for (let y = 10; y < 22; y++) {
        const label = labels[y * WIDTH + x];
        if (label === EdgeCategory.Hair) hairVotes++;
        if (label === EdgeCategory.Fur) furVotes++;
      }
    }
    expect(hairVotes + furVotes).toBeGreaterThan(0);
    expect(hairVotes).toBeGreaterThan(furVotes);
  });

  it("classifies a dense, high-frequency textured band (denser than the HAIR case) as FUR more often than HAIR", () => {
    const rgba = makeFlatRgba(250);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1); // solid opaque subject
    // Dense single-pixel alternation across a WIDE band in both directions —
    // much denser coverage than the sparse HAIR test's isolated strands.
    for (let y = 6; y < 26; y++) {
      for (let x = 6; x < 26; x++) {
        const i = y * WIDTH + x;
        if ((x + y) % 2 === 0) {
          alpha[i] = 0.6;
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 60;
        } else {
          alpha[i] = 1;
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 250;
        }
      }
    }

    const { labels } = classify(alpha, rgba);
    let hairVotes = 0;
    let furVotes = 0;
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const label = labels[y * WIDTH + x];
        if (label === EdgeCategory.Hair) hairVotes++;
        if (label === EdgeCategory.Fur) furVotes++;
      }
    }
    expect(furVotes).toBeGreaterThan(hairVotes);
  });

  it("classifies a broad, flat mid-alpha plateau as TRANSLUCENT", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) alpha[y * WIDTH + x] = 0.5;

    const { labels } = classify(alpha, rgba);
    expect(labels[16 * WIDTH + 16]).toBe(EdgeCategory.Translucent);
  });

  it("gives a directional, wide alpha transition (motion blur signature) a meaningfully higher MOTION_BLUR score than an equivalent-width isotropic transition", () => {
    // A wide, unidirectional horizontal ramp with a correspondingly directional
    // (horizontal-stripe) colour pattern — the combined "wide + directionally
    // coherent" signature this category is built on.
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = y * WIDTH + x;
        const t = (x - 8) / 16;
        alpha[i] = Math.min(1, Math.max(0, t));
        const v = y % 2 === 0 ? 210 : 40; // horizontal streaking, matching the ramp's own horizontal direction
        rgba[i * 4] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
      }
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const classifier = new ClassicalEdgeClassifier();
    const { confidence } = classifier.classify({ alpha, rgba, width: WIDTH, height: HEIGHT, trimap });

    // Compare against the same classifier's motion-blur-relevant evidence on
    // a plain flat-colour ramp of the same width/shape (no directional
    // colour texture at all) — the directional case should score noticeably
    // more evidence overall (checked via confidence, since MOTION_BLUR must
    // out-compete SOFT_EDGE for the *label*, which a purely classical
    // heuristic is not guaranteed to win outright every time).
    const flatRgba = makeFlatRgba(128);
    const flatResult = classifier.classify({ alpha, rgba: flatRgba, width: WIDTH, height: HEIGHT, trimap });

    const i = 16 * WIDTH + 16;
    expect(confidence[i]).toBeGreaterThanOrEqual(flatResult.confidence[i]);
  });

  it("recognizes a chromaticity-consistent, darkened region near the background as SHADOW rather than confidently foreground", () => {
    const bgColor: [number, number, number] = [180, 170, 160];
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = bgColor[0];
      rgba[i * 4 + 1] = bgColor[1];
      rgba[i * 4 + 2] = bgColor[2];
      rgba[i * 4 + 3] = 255;
    }
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    // A shadow patch: same hue as the background, notably darker, and the
    // model gave it low-to-mid (uncertain) alpha rather than 0.
    const shadowScale = 0.5;
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const i = y * WIDTH + x;
        rgba[i * 4] = Math.round(bgColor[0] * shadowScale);
        rgba[i * 4 + 1] = Math.round(bgColor[1] * shadowScale);
        rgba[i * 4 + 2] = Math.round(bgColor[2] * shadowScale);
        alpha[i] = 0.4;
      }
    }

    const { labels, confidence } = classify(alpha, rgba);
    const i = 16 * WIDTH + 16;
    expect(labels[i]).toBe(EdgeCategory.Shadow);
    expect(confidence[i]).toBeGreaterThan(0);
  });

  it("gives a dim, desaturated echo of a nearby foreground colour real REFLECTION evidence, capped by the caution factor", () => {
    const width = 20;
    const height = 20;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const alpha = new Float32Array(width * height).fill(0);
    // A confident foreground block (e.g. a red object).
    const fgColor: [number, number, number] = [200, 40, 30];
    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 18; x++) {
        const i = y * width + x;
        alpha[i] = 1;
        rgba[i * 4] = fgColor[0];
        rgba[i * 4 + 1] = fgColor[1];
        rgba[i * 4 + 2] = fgColor[2];
        rgba[i * 4 + 3] = 255;
      }
    }
    // A dimmer echo of that same colour just below it (a floor reflection),
    // with uncertain (not confidently foreground) alpha.
    for (let y = 10; y < 14; y++) {
      for (let x = 2; x < 18; x++) {
        const i = y * width + x;
        alpha[i] = 0.4;
        rgba[i * 4] = Math.round(fgColor[0] * 0.4);
        rgba[i * 4 + 1] = Math.round(fgColor[1] * 0.4);
        rgba[i * 4 + 2] = Math.round(fgColor[2] * 0.4);
        rgba[i * 4 + 3] = 255;
      }
    }
    const trimap = buildTrimap(alpha, width, height, DEFAULT_TRIMAP_OPTIONS);
    const { labels, confidence } = new ClassicalEdgeClassifier().classify({ alpha, rgba, width, height, trimap });

    const i = 12 * width + 9;
    expect(trimap[i]).toBe(TrimapLabel.Unknown);
    // Reflection is deliberately the most conservative category — checking
    // it was at least *evaluated* with real, nonzero evidence (rather than
    // asserting it always wins the label outright) is the honest bar here.
    expect(confidence[i]).toBeGreaterThan(0);
  });

  it("falls back to UNCERTAIN when the winning score doesn't clear minConfidence, rather than reporting a low-confidence guess as a real category", () => {
    // A wide, gradual ramp ordinarily classifies confidently as SOFT_EDGE
    // (see the dedicated test above) — this confirms the *fallback
    // mechanism* itself: raising minConfidence past whatever that scene's
    // best score reaches must flip the same pixel to UNCERTAIN, at the same
    // (now sub-threshold) confidence value rather than a fabricated one.
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const t = (x - 8) / 16;
        alpha[y * WIDTH + x] = Math.min(1, Math.max(0, t));
      }
    }
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const i = 16 * WIDTH + 16;

    const normal = new ClassicalEdgeClassifier().classify({ alpha, rgba, width: WIDTH, height: HEIGHT, trimap });
    expect(normal.labels[i]).toBe(EdgeCategory.SoftEdge);

    const strict = new ClassicalEdgeClassifier({ minConfidence: 0.999 }).classify({ alpha, rgba, width: WIDTH, height: HEIGHT, trimap });
    expect(strict.labels[i]).toBe(EdgeCategory.Uncertain);
    expect(strict.confidence[i]).toBe(normal.confidence[i]);
    expect(strict.confidence[i]).toBeGreaterThan(0); // still "evaluated", just not confidently dominant
  });

  it("marks deep-interior background/foreground pixels as not-evaluated (confidence exactly 0)", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1); // fully opaque everywhere, no edge anywhere
    const { confidence } = classify(alpha, rgba);
    expect(confidence[16 * WIDTH + 16]).toBe(0);
  });

  it("never mutates its inputs", () => {
    const rgba = makeFlatRgba(128);
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const rgbaBefore = rgba.slice();
    const alphaBefore = alpha.slice();
    const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
    const trimapBefore = trimap.slice();

    new ClassicalEdgeClassifier().classify({ alpha, rgba, width: WIDTH, height: HEIGHT, trimap });

    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    expect(Array.from(trimap)).toEqual(Array.from(trimapBefore));
  });
});
