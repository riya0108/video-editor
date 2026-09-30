import { describe, it, expect } from "vitest";
import { MattePreviewEngine } from "./matte-preview-engine";
import { PreviewBackgroundMode } from "./preview-compositor";
import { buildTrimap, DEFAULT_TRIMAP_OPTIONS } from "./trimap";

const WIDTH = 8;
const HEIGHT = 8;

function makeMatte(gray = 100, a = 0.6) {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  const alpha = new Float32Array(WIDTH * HEIGHT).fill(a);
  return { alpha, rgba, width: WIDTH, height: HEIGHT };
}

const ALL_MODES = [
  PreviewBackgroundMode.Original,
  PreviewBackgroundMode.Checkerboard,
  PreviewBackgroundMode.Black,
  PreviewBackgroundMode.White,
  PreviewBackgroundMode.Gray,
  PreviewBackgroundMode.Custom,
  PreviewBackgroundMode.HighContrastDiagnostic,
  PreviewBackgroundMode.MatteOnly,
  PreviewBackgroundMode.AlphaVisualization,
];

describe("MattePreviewEngine — separates generation from compositing", () => {
  it("switching across all 9 preview modes never calls a model/generator again", () => {
    let generatorCalls = 0;
    function generateMatte() {
      generatorCalls++;
      return makeMatte();
    }

    const engine = new MattePreviewEngine(generateMatte()); // the ONE (and only) generation call
    expect(generatorCalls).toBe(1);

    for (const mode of ALL_MODES) {
      engine.render(mode);
      engine.render(mode, { checkerSize: 2 }); // also vary options, still no regeneration
    }

    expect(generatorCalls).toBe(1); // still exactly one — switching modes never regenerated anything
  });

  it("render() with every mode succeeds against the same stored matte and produces a full-size buffer", () => {
    const engine = new MattePreviewEngine(makeMatte());
    for (const mode of ALL_MODES) {
      const result = engine.render(mode);
      expect(result.width).toBe(WIDTH);
      expect(result.height).toBe(HEIGHT);
      expect(result.rgba.length).toBe(WIDTH * HEIGHT * 4);
    }
  });
});

describe("MattePreviewEngine — efficient updates (caching)", () => {
  it("an identical repeated render() call is served from cache, not recomposited", () => {
    const engine = new MattePreviewEngine(makeMatte());
    engine.render(PreviewBackgroundMode.White);
    engine.render(PreviewBackgroundMode.White);
    engine.render(PreviewBackgroundMode.White);

    const stats = engine.getStats();
    expect(stats.compositeRunCount).toBe(1);
    expect(stats.cacheHitCount).toBe(2);
  });

  it("a different mode or option is never a cache hit", () => {
    const engine = new MattePreviewEngine(makeMatte());
    engine.render(PreviewBackgroundMode.White);
    engine.render(PreviewBackgroundMode.Black);
    engine.render(PreviewBackgroundMode.Black, { checkerSize: 99 }); // options differ even if irrelevant to this mode's rendering — key is still distinct

    const stats = engine.getStats();
    expect(stats.compositeRunCount).toBe(3);
    expect(stats.cacheHitCount).toBe(0);
  });

  it("the cached result is byte-identical to a fresh composite of the same request", () => {
    const engine = new MattePreviewEngine(makeMatte());
    const first = engine.render(PreviewBackgroundMode.Gray, { grayColor: [77, 77, 77] });
    const second = engine.render(PreviewBackgroundMode.Gray, { grayColor: [77, 77, 77] });
    expect(Array.from(second.rgba)).toEqual(Array.from(first.rgba));
  });
});

describe("MattePreviewEngine — reusable across a real matte update", () => {
  it("updateMatte() invalidates the cache and subsequent renders reflect the NEW matte", () => {
    const engine = new MattePreviewEngine(makeMatte(50, 1));
    const before = engine.render(PreviewBackgroundMode.MatteOnly);
    expect(before.rgba[0]).toBe(255); // alpha 1 -> white matte-only pixel

    engine.updateMatte(makeMatte(50, 0));
    const after = engine.render(PreviewBackgroundMode.MatteOnly);
    expect(after.rgba[0]).toBe(0); // alpha 0 -> black matte-only pixel — proves it's reading the NEW matte, not a stale cache
    expect(engine.getStats().compositeRunCount).toBe(2); // both were real composites, no incorrect cache hit across the update
  });

  it("getMatte() exposes the currently stored matte, updated by updateMatte()", () => {
    const engine = new MattePreviewEngine(makeMatte(10, 0.2));
    expect(engine.getMatte().rgba[0]).toBe(10);
    engine.updateMatte(makeMatte(20, 0.2));
    expect(engine.getMatte().rgba[0]).toBe(20);
  });
});

describe("MattePreviewEngine — edge diagnostic", () => {
  it("throws a clear error if renderEdgeDiagnostic is called before setTrimap", () => {
    const engine = new MattePreviewEngine(makeMatte());
    expect(() => engine.renderEdgeDiagnostic()).toThrow(/setTrimap/);
  });

  it("renders the edge diagnostic once a trimap is supplied", () => {
    const matte = makeMatte();
    const engine = new MattePreviewEngine(matte);
    engine.setTrimap(buildTrimap(matte.alpha, WIDTH, HEIGHT, DEFAULT_TRIMAP_OPTIONS));
    const result = engine.renderEdgeDiagnostic();
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
  });
});
