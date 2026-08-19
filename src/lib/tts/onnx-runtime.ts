import * as ort from "onnxruntime-web";

// Deliberately NOT self-hosting these wasm files (unlike ffmpeg-core): the
// wasm loader uses a dynamic import() of its .mjs companion, which Vite's
// dev server refuses for files served from /public ("should not be imported
// from source code"). onnxruntime-web's own default wasmPaths (jsdelivr,
// version-matched to the installed package) sidesteps that entirely — and
// this app already fetches ML models themselves from HF hub for Whisper and
// Kokoro, so this isn't a new privacy tradeoff.

async function webgpuFp16Supported(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu as
    | { requestAdapter: (opts?: unknown) => Promise<{ features: { has(name: string): boolean } } | null> }
    | undefined;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return !!adapter?.features.has("shader-f16");
  } catch {
    return false;
  }
}

export interface RuntimeDevice {
  /** Execution provider onnxruntime-web should use. */
  provider: "webgpu" | "wasm";
  /** Whether the fp16 transformer variant is safe to use (only reliable on WebGPU with fp16 shader support). */
  useFp16: boolean;
}

/** Picks the best available backend: WebGPU (with fp16 if supported) or WASM CPU (always fp32 — onnxruntime-web's WASM backend doesn't reliably support fp16 ops). */
export async function detectRuntimeDevice(): Promise<RuntimeDevice> {
  const hasWebgpu = typeof navigator !== "undefined" && "gpu" in navigator;
  if (!hasWebgpu) return { provider: "wasm", useFp16: false };
  const fp16 = await webgpuFp16Supported();
  return { provider: "webgpu", useFp16: fp16 };
}

export async function createInferenceSession(
  buffer: Uint8Array,
  device: RuntimeDevice,
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(buffer, {
    executionProviders: [device.provider],
    graphOptimizationLevel: "all",
  });
}

export { ort };
