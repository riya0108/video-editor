import { describe, it, expect, afterEach } from "vitest";
import { detectRuntimeDevice } from "./onnx-runtime";

/**
 * PHASE 16 — ADVERSARIAL MATTE TESTING ("GPU unavailable", #22).
 * detectRuntimeDevice is this app's one and only WebGPU-availability check
 * (see onnx-runtime.ts's own doc comment) — every model adapter trusts its
 * result rather than probing navigator.gpu itself, so this function alone
 * being correct is what "gracefully fails over to WASM" actually rests on.
 */

interface NavigatorWithGpu {
  gpu?: unknown;
}

const originalGpu = (globalThis.navigator as unknown as NavigatorWithGpu | undefined)?.gpu;

/** Real `navigator.gpu`/`GPUAdapter` are large native interfaces vitest has no browser to construct — this only needs to satisfy detectRuntimeDevice's own minimal structural use of `.gpu.requestAdapter()` and the adapter's `.features.has()`, so the cast is intentional rather than an oversight. */
function setMockGpu(mock: unknown): void {
  (navigator as unknown as NavigatorWithGpu).gpu = mock;
}

afterEach(() => {
  setMockGpu(originalGpu);
});

describe("detectRuntimeDevice — GPU unavailable", () => {
  it("falls back to wasm when navigator.gpu doesn't exist at all (this test's own Node environment — no mocking needed)", async () => {
    expect((navigator as unknown as NavigatorWithGpu).gpu).toBeUndefined();
    const device = await detectRuntimeDevice();
    expect(device).toEqual({ provider: "wasm", useFp16: false });
  });

  it("falls back to wasm when navigator.gpu exists but requestAdapter() resolves null (no adapter on this hardware)", async () => {
    setMockGpu({ requestAdapter: async () => null });
    const device = await detectRuntimeDevice();
    expect(device).toEqual({ provider: "wasm", useFp16: false });
  });

  it("falls back to wasm — never throws uncaught — when requestAdapter() itself rejects", async () => {
    setMockGpu({
      requestAdapter: async () => {
        throw new Error("WebGPU context lost");
      },
    });
    await expect(detectRuntimeDevice()).resolves.toEqual({ provider: "wasm", useFp16: false });
  });

  it("selects webgpu with fp16 only when a real adapter reports shader-f16 support", async () => {
    setMockGpu({ requestAdapter: async () => ({ features: { has: (name: string) => name === "shader-f16" } }) });
    const device = await detectRuntimeDevice();
    expect(device).toEqual({ provider: "webgpu", useFp16: true });
  });

  it("selects webgpu without fp16 when the adapter lacks shader-f16 support", async () => {
    setMockGpu({ requestAdapter: async () => ({ features: { has: () => false } }) });
    const device = await detectRuntimeDevice();
    expect(device).toEqual({ provider: "webgpu", useFp16: false });
  });
});
