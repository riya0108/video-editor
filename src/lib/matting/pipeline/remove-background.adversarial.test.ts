import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteOutput, HealthCheckResult, ModelClass } from "../types";

/**
 * PHASE 16 — ADVERSARIAL MATTE TESTING. Exercises `removeBackgroundFromImage`
 * (the actual orchestration function production code calls, not a
 * reimplementation of its logic) against simulated failure conditions —
 * model download failure ("model unavailable"), a model that throws an
 * OOM-shaped error, degenerate/adversarial alpha outputs (no subject, a
 * single-pixel subject, a subject touching the frame edge), and a
 * resolution far past what's safe to allocate in a browser tab.
 *
 * `./dom-io` is mocked so this runs in plain Node/Vitest without a real
 * canvas or ONNX runtime — `drawSourceToRgba`/`compositeTransparentForeground`
 * are this pipeline's ONLY two DOM touchpoints (see remove-background.ts's
 * own doc comment), so mocking exactly those two functions lets the REAL
 * orchestration, refinement, decontamination, and quality-analysis code run
 * for real against synthetic pixel data.
 */

vi.mock("./dom-io", () => ({
  drawSourceToRgba: vi.fn(),
  compositeTransparentForeground: vi.fn(() => ({ __fakeCanvas: true }) as unknown as HTMLCanvasElement),
}));

import { drawSourceToRgba } from "./dom-io";
import { removeBackgroundFromImage } from "./remove-background";
import { MattingError } from "./types";

const WIDTH = 64;
const HEIGHT = 64;

/** A mid-gray, fully-opaque RGBA buffer — a plausible, uninteresting "photo" for tests that don't care about pixel content. */
function neutralRgba(width = WIDTH, height = HEIGHT): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128;
    rgba[i + 1] = 128;
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  return rgba;
}

const BASE_CAPS: Omit<MattingModelCapabilities, "modelId" | "modelClass"> = {
  supportedMedia: ["image"],
  supportedSubjects: ["general"],
  requiredInputs: ["frame"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: 64, nativeHeight: 64 },
  deviceSupport: ["wasm"],
  supportsTemporal: false,
  license: { id: "MIT", commercialUse: true, redistributable: true, sourceUrl: "https://example.invalid" },
};

interface MockModelOptions {
  modelId: string;
  modelClass?: ModelClass;
  /** Rejects load() with this error, if set — simulates a model download/init failure ("model unavailable" / "GPU unavailable" / any load-time failure). */
  loadError?: Error;
  /** Rejects inferImage() with this error, if set — simulates a runtime inference failure (OOM, corrupt internal state, etc). */
  inferError?: Error;
  /** What inferImage() resolves with when it doesn't fail — defaults to a flat mid-confidence alpha the same size as the request. */
  alpha?: Float32Array;
}

/** Builds a minimal, spec-compliant MattingModel test double — real enough to pass router.ts's eligibility/ranking, controllable enough to simulate any failure mode. */
function makeMockModel(opts: MockModelOptions): MattingModel {
  let loaded = false;
  return {
    capabilities: { ...BASE_CAPS, modelId: opts.modelId, modelClass: opts.modelClass ?? "segmentation" },
    isLoaded: () => loaded,
    load: vi.fn(async () => {
      if (opts.loadError) throw opts.loadError;
      loaded = true;
    }),
    unload: () => {
      loaded = false;
    },
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: loaded, loaded, device: "wasm" }),
    inferImage: vi.fn(async (input: MatteImageInput): Promise<MatteOutput> => {
      if (opts.inferError) throw opts.inferError;
      const alpha = opts.alpha ?? new Float32Array(input.width * input.height).fill(0.7);
      return { alpha, alphaWidth: input.width, alphaHeight: input.height, producedBy: { modelId: opts.modelId, modelClass: opts.modelClass ?? "segmentation" } };
    }),
  };
}

beforeEach(() => {
  vi.mocked(drawSourceToRgba).mockReset();
  vi.mocked(drawSourceToRgba).mockReturnValue(neutralRgba());
});

describe("failure mode: model unavailable (#23)", () => {
  it("skips a model whose load() fails (simulating a 404/network failure) and falls back to the next candidate, recording why", async () => {
    const failing = makeMockModel({ modelId: "unavailable-model", loadError: new Error("Failed to download /models/unavailable.onnx (404)") });
    const working = makeMockModel({ modelId: "working-model" });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [failing, working] });

    // Never silently substitutes an unrelated model: modelUsed must name the
    // model that ACTUALLY produced this alpha, and the failure must be
    // recorded, not swallowed.
    expect(result.modelUsed).toBe("working-model");
    expect(result.warnings.some((w) => w.includes("unavailable-model") && w.includes("404"))).toBe(true);
  });

  it("throws MattingError (ALL_MODELS_FAILED) — never a fake successful result — when every candidate's load() fails", async () => {
    const a = makeMockModel({ modelId: "a", loadError: new Error("network error") });
    const b = makeMockModel({ modelId: "b", loadError: new Error("network error") });

    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [a, b] })).rejects.toThrow(MattingError);
    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [a, b] })).rejects.toMatchObject({
      code: "ALL_MODELS_FAILED",
    });
  });

  it("throws NO_ELIGIBLE_MODEL — never a fake result — when the registry is empty", async () => {
    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [] })).rejects.toMatchObject({
      code: "NO_ELIGIBLE_MODEL",
    });
  });
});

describe("failure mode: out-of-memory-shaped inference error (#25)", () => {
  it("treats an inferImage() OOM-style throw as a normal candidate failure and falls back, rather than crashing the whole call", async () => {
    const outOfMemory = makeMockModel({ modelId: "oom-model", inferError: new RangeError("Array buffer allocation failed") });
    const working = makeMockModel({ modelId: "working-model" });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [outOfMemory, working] });

    expect(result.modelUsed).toBe("working-model");
    expect(result.warnings.some((w) => w.includes("oom-model"))).toBe(true);
  });

  it("throws MattingError rather than an unhandled rejection when the only candidate throws an OOM-shaped error", async () => {
    const outOfMemory = makeMockModel({ modelId: "oom-model", inferError: new RangeError("Array buffer allocation failed") });
    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [outOfMemory] })).rejects.toThrow(MattingError);
  });
});

describe("failure mode: no subject in frame (#1)", () => {
  it("returns a genuine (not fabricated) low-confidence, near-zero-coverage result rather than throwing or inventing a plausible-looking subject", async () => {
    const emptyModel = makeMockModel({ modelId: "m", alpha: new Float32Array(WIDTH * HEIGHT).fill(0) });
    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [emptyModel] });

    expect(result.qualityMetrics.coverageFraction).toBeCloseTo(0, 5);
    expect(result.boundingBox).toBeNull();
    expect(result.warnings.some((w) => /coverage/i.test(w))).toBe(true);
  });
});

describe("failure mode: very small subject (#3) and subject touching the image boundary (#4)", () => {
  it("treats a genuinely single-pixel 'subject' as noise (small-island cleanup) rather than crashing OR fabricating a one-pixel result", async () => {
    // Real, verified behavior (not an assumption): refine/pipeline.ts's
    // small-island cleanup (cleanup.ts, maxHoleSize 24px by default) treats
    // a 1px disconnected foreground speck as sensor noise and removes it —
    // the same design already covered by cleanup.test.ts's "suppresses a
    // small disconnected foreground speck". A single real pixel is
    // genuinely indistinguishable from noise, so ending up with "nothing
    // found" here (null bounding box, low confidence, a coverage warning)
    // is the CORRECT graceful outcome, not a bug — the failure mode this
    // case actually guards against is a crash or a fabricated result, and
    // there is neither.
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    alpha[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)] = 1;
    const model = makeMockModel({ modelId: "m", alpha });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(Number.isNaN(result.confidence)).toBe(false);
    expect(result.boundingBox).toBeNull();
    expect(result.warnings.some((w) => /coverage/i.test(w))).toBe(true);
  });

  it("preserves a small-but-real subject once it's above the noise-cleanup threshold", async () => {
    // A 6x6 (36px) solid block — comfortably above cleanup.ts's default
    // 24px maxHoleSize/island threshold — survives intact, unlike the
    // single-pixel case above. Pins down roughly where "too small" starts.
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 29; y < 35; y++) for (let x = 29; x < 35; x++) alpha[y * WIDTH + x] = 1;
    const model = makeMockModel({ modelId: "m", alpha });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(result.boundingBox).not.toBeNull();
    expect(result.boundingBox!.width).toBeGreaterThanOrEqual(6);
  });

  it("does not crash when the subject region touches every edge of the frame (a tight close-up crop)", async () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(1); // foreground fills the entire frame, edge to edge
    const model = makeMockModel({ modelId: "m", alpha });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(result.boundingBox).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    expect(Number.isNaN(result.confidence)).toBe(false);
  });

  it("does not crash when the subject is a corner-touching sliver (about to leave frame, #20)", async () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < 3; x++) alpha[y * WIDTH + x] = 1; // a 3px-wide strip along the left edge only
    }
    const model = makeMockModel({ modelId: "m", alpha });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(result.boundingBox).toEqual({ x: 0, y: 0, width: 3, height: HEIGHT });
    expect(Number.isNaN(result.confidence)).toBe(false);
  });
});

describe("failure mode: multiple / overlapping subjects (#2)", () => {
  it("does not crash and produces a bounding box spanning two disjoint foreground blobs", async () => {
    const alpha = new Float32Array(WIDTH * HEIGHT).fill(0);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) alpha[y * WIDTH + x] = 1;
    for (let y = 40; y < 55; y++) for (let x = 45; x < 60; x++) alpha[y * WIDTH + x] = 1;
    const model = makeMockModel({ modelId: "m", alpha });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(result.boundingBox).toEqual({ x: 5, y: 5, width: 55, height: 50 });
  });
});

describe("failure mode: extremely high resolution (#12)", () => {
  it("rejects a request far past the safety ceiling immediately, before ever touching the DOM or a model", async () => {
    const model = makeMockModel({ modelId: "m" });
    const huge = 12000;

    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, huge, huge, { models: [model] })).rejects.toMatchObject({
      code: "ALL_MODELS_FAILED",
    });
    expect(drawSourceToRgba).not.toHaveBeenCalled();
    expect(model.inferImage).not.toHaveBeenCalled();
  });

  it("does not trip the resolution guard for an ordinary (non-extreme) size", async () => {
    // Confirms the guard is a genuine ceiling, not an off-by-something that
    // rejects normal input. Deliberately NOT run at a real 24MP-scale
    // resolution: doing so for real (see the constant's own doc comment in
    // remove-background.ts) measured ~19 SECONDS for 36MP in this suite —
    // far too slow for a unit test. That real-world latency is exactly why
    // MAX_PIXELS was set where it is; re-proving it here on every test run
    // would make the whole suite unusably slow for no extra safety signal.
    const model = makeMockModel({ modelId: "m", alpha: new Float32Array(WIDTH * HEIGHT).fill(0.5) });
    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] })).resolves.toBeTruthy();
  });
});

describe("failure mode: very low resolution (#11)", () => {
  it("does not crash on a tiny (4x4) image", async () => {
    const tiny = 4;
    vi.mocked(drawSourceToRgba).mockReturnValue(neutralRgba(tiny, tiny));
    const model = makeMockModel({ modelId: "m", alpha: new Float32Array(tiny * tiny).fill(0.5) });

    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, tiny, tiny, { models: [model] });
    expect(Number.isNaN(result.confidence)).toBe(false);
    expect(result.alphaWidth).toBe(tiny);
    expect(result.alphaHeight).toBe(tiny);
  });

  it("rejects a 0x0 request cleanly rather than crashing on a divide-by-zero somewhere downstream", async () => {
    const model = makeMockModel({ modelId: "m" });
    await expect(removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, 0, 0, { models: [model] })).rejects.toThrow(MattingError);
  });
});

describe("failure mode: very dark / very bright image (#13 / #14)", () => {
  it("produces finite (non-NaN) quality metrics for a near-black source image", async () => {
    const dark = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < dark.length; i += 4) {
      dark[i] = 1;
      dark[i + 1] = 1;
      dark[i + 2] = 1;
      dark[i + 3] = 255;
    }
    vi.mocked(drawSourceToRgba).mockReturnValue(dark);
    const model = makeMockModel({ modelId: "m" });
    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(Number.isFinite(result.confidence)).toBe(true);
    expect(Number.isFinite(result.qualityMetrics.edgeGradientEnergy)).toBe(true);
  });

  it("produces finite (non-NaN) quality metrics for a near-white source image", async () => {
    const bright = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(254);
    vi.mocked(drawSourceToRgba).mockReturnValue(bright);
    const model = makeMockModel({ modelId: "m" });
    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(Number.isFinite(result.confidence)).toBe(true);
  });
});

describe("failure mode: smoke-like diffuse low-alpha regions (#9)", () => {
  it("does not produce NaN/Infinity metrics for a very sparse, low-value alpha field", async () => {
    const alpha = new Float32Array(WIDTH * HEIGHT);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (i % 7 === 0 ? 0.05 : 0) * Math.random();
    const model = makeMockModel({ modelId: "m", alpha });
    const result = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(Number.isFinite(result.confidence)).toBe(true);
    expect(Number.isFinite(result.qualityMetrics.coverageFraction)).toBe(true);
  });
});

describe("invariant: never destroys the original media", () => {
  it("never mutates the Uint8ClampedArray drawSourceToRgba returned", async () => {
    const rgba = neutralRgba();
    const snapshot = rgba.slice();
    vi.mocked(drawSourceToRgba).mockReturnValue(rgba);
    const model = makeMockModel({ modelId: "m" });

    await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [model] });
    expect(rgba).toEqual(snapshot);
  });

  it("never calls any method on the source object itself (only ever reads through drawSourceToRgba)", async () => {
    const source = new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`Unexpected direct access to source.${String(prop)} — the pipeline must only read the source via drawSourceToRgba.`);
        },
      },
    ) as unknown as CanvasImageSource;
    const model = makeMockModel({ modelId: "m" });
    await expect(removeBackgroundFromImage(source, WIDTH, HEIGHT, { models: [model] })).resolves.toBeTruthy();
  });
});

describe("invariant: back-to-back calls with wildly different content don't leak state (scene-cut safety, #21)", () => {
  // A 50/50 vertical split — like quality-metrics.test.ts's own "normal"
  // fixture — deliberately avoids the "unusual coverage"/"low confidence"
  // warnings a degenerate alpha (all-0, all-1, all-0.7) would add on its
  // own, so the only thing under test is whether call 2 inherits anything
  // from call 1, not incidental warnings both calls would generate anyway.
  function halfSplitAlpha(): Float32Array {
    const alpha = new Float32Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) alpha[y * WIDTH + x] = x < WIDTH / 2 ? 1 : 0;
    return alpha;
  }

  it("a second call's warnings/model choice are unaffected by the first call's failure", async () => {
    const failingThenA = makeMockModel({ modelId: "a", loadError: new Error("boom") });
    const workingB = makeMockModel({ modelId: "b", alpha: halfSplitAlpha() });
    const first = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [failingThenA, workingB] });
    expect(first.warnings.some((w) => w.includes("\"a\""))).toBe(true);

    const cleanModel = makeMockModel({ modelId: "c", alpha: halfSplitAlpha() });
    const second = await removeBackgroundFromImage(neutralRgba() as unknown as CanvasImageSource, WIDTH, HEIGHT, { models: [cleanModel] });
    // A hard-edged 50/50 mock alpha has no semi-transparent pixels at all,
    // so decontamination's own benign "nothing to correct" warning is
    // expected here — the actual thing under test is that NOTHING from
    // call 1 (model "a"'s failure) bleeds into call 2's result.
    expect(second.warnings.some((w) => w.includes("\"a\"") || w.includes("boom"))).toBe(false);
    expect(second.modelUsed).toBe("c");
  });
});
