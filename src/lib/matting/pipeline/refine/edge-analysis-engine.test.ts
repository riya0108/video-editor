import { describe, it, expect } from "vitest";
import { EdgeAnalysisEngine } from "./edge-analysis-engine";
import { EdgeCategory, getEdgeRefinementGuidance } from "./edge-category";
import { buildTrimap, DEFAULT_TRIMAP_OPTIONS } from "./trimap";
import type { EdgeClassifier, EdgeClassifierInput, EdgeClassificationMap } from "./edge-classifier";

const WIDTH = 10;
const HEIGHT = 10;

function makeFlatScene(gray: number, alphaFill: number) {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  const alpha = new Float32Array(WIDTH * HEIGHT).fill(alphaFill);
  const trimap = buildTrimap(alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS);
  return { rgba, alpha, trimap };
}

/** A minimal fake classifier — demonstrates the engine depends only on the EdgeClassifier interface, not on ClassicalEdgeClassifier specifically ("keep it modular so a better edge classifier can be added later"). */
class AlwaysHardEdgeClassifier implements EdgeClassifier {
  readonly name = "always-hard-edge-fake";
  classify(input: EdgeClassifierInput): EdgeClassificationMap {
    const n = input.width * input.height;
    return {
      labels: new Uint8Array(n).fill(EdgeCategory.HardEdge),
      confidence: new Float32Array(n).fill(0.9),
    };
  }
}

describe("EdgeAnalysisEngine", () => {
  it("defaults to the classical classifier and reports its name", () => {
    const { rgba, alpha, trimap } = makeFlatScene(128, 0);
    const engine = new EdgeAnalysisEngine();
    const result = engine.analyze({ rgba, alpha, width: WIDTH, height: HEIGHT, trimap });
    expect(result.classifierName).toBe("classical-v1");
  });

  it("uses an injected classifier instead of the default — the modularity contract", () => {
    const { rgba, alpha, trimap } = makeFlatScene(128, 0.5);
    const engine = new EdgeAnalysisEngine(new AlwaysHardEdgeClassifier());
    const result = engine.analyze({ rgba, alpha, width: WIDTH, height: HEIGHT, trimap });

    expect(result.classifierName).toBe("always-hard-edge-fake");
    expect(Array.from(result.labels).every((l) => l === EdgeCategory.HardEdge)).toBe(true);
    expect(result.pixelCountByCategory[EdgeCategory.HardEdge]).toBe(WIDTH * HEIGHT);
    expect(result.pixelCountByCategory[EdgeCategory.Uncertain]).toBe(0);
  });

  it("guidanceForPixel and categoryNameForPixel match the pixel's own assigned label", () => {
    const { rgba, alpha, trimap } = makeFlatScene(128, 0.5);
    const engine = new EdgeAnalysisEngine(new AlwaysHardEdgeClassifier());
    const result = engine.analyze({ rgba, alpha, width: WIDTH, height: HEIGHT, trimap });

    expect(engine.categoryNameForPixel(result, 0)).toBe("HARD_EDGE");
    expect(engine.guidanceForPixel(result, 0)).toEqual(getEdgeRefinementGuidance(EdgeCategory.HardEdge));
  });

  it("produces a confidence map the same size as the image, with values in [0,1]", () => {
    const { rgba, alpha, trimap } = makeFlatScene(128, 0.5);
    const engine = new EdgeAnalysisEngine();
    const result = engine.analyze({ rgba, alpha, width: WIDTH, height: HEIGHT, trimap });

    expect(result.confidence.length).toBe(WIDTH * HEIGHT);
    for (const c of result.confidence) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it("never mutates its inputs", () => {
    const { rgba, alpha, trimap } = makeFlatScene(128, 0.5);
    const rgbaBefore = rgba.slice();
    const alphaBefore = alpha.slice();
    const trimapBefore = trimap.slice();

    new EdgeAnalysisEngine().analyze({ rgba, alpha, width: WIDTH, height: HEIGHT, trimap });

    expect(Array.from(rgba)).toEqual(Array.from(rgbaBefore));
    expect(Array.from(alpha)).toEqual(Array.from(alphaBefore));
    expect(Array.from(trimap)).toEqual(Array.from(trimapBefore));
  });
});
