import * as ort from "onnxruntime-web";

// Deliberately NOT self-hosting these wasm files (unlike ffmpeg-core): the
// wasm loader uses a dynamic import() of its .mjs companion, which Vite's
// dev server refuses for files served from /public ("should not be imported
// from source code"). onnxruntime-web's own default wasmPaths (jsdelivr,
// version-matched to the installed package) sidesteps that entirely — and
// this app already fetches ML models themselves from HF hub for Whisper and
// Kokoro, so this isn't a new privacy tradeoff.

type GpuAdapter = { features: { has(name: string): boolean } };
type GpuLike = { requestAdapter: (opts?: unknown) => Promise<GpuAdapter | null> };

/** `navigator.gpu` existing doesn't mean WebGPU actually works here (e.g. headless/sandboxed Chrome exposes the API surface but `requestAdapter` resolves to null or hangs) — only a real adapter counts as support. */
async function requestGpuAdapter(): Promise<GpuAdapter | null> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) return null;
  try {
    return await gpu.requestAdapter();
  } catch {
    return null;
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
  const adapter = await requestGpuAdapter();
  if (!adapter) return { provider: "wasm", useFp16: false };
  return { provider: "webgpu", useFp16: adapter.features.has("shader-f16") };
}

export async function createInferenceSession(
  buffer: Uint8Array,
  device: RuntimeDevice,
): Promise<ort.InferenceSession> {
  // Proxy WASM (CPU) execution to a worker thread instead of running it
  // synchronously on the main thread — without this, a heavy model (e.g.
  // the upscale tool's RRDBNet super-resolution net) freezes the entire tab,
  // including its own progress bar, for as long as inference takes, which
  // looks indistinguishable from the app having hung. Only applies to the
  // "wasm" provider: WebGPU dispatch is already off the main thread, and
  // proxying it too has been observed to make session creation spin forever
  // instead of completing.
  ort.env.wasm.proxy = device.provider === "wasm";
  // onnxruntime-web's own default caps threads at min(hardwareConcurrency/2, 4)
  // to be conservative on shared/mobile hardware; this app already requires
  // cross-origin isolation (see astro.config.mjs) for ffmpeg's multi-threaded
  // core, so the same SharedArrayBuffer-backed thread pool is available here
  // too — use every core the machine offers instead of leaving most of them idle.
  if (device.provider === "wasm") {
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
  }
  return ort.InferenceSession.create(buffer, {
    executionProviders: [device.provider],
    graphOptimizationLevel: "all",
  });
}

/**
 * PHASE 14 — PERFORMANCE. Frees a session's underlying WASM heap allocation
 * / GPU buffers. Every adapter's `unload()` must call this instead of just
 * dropping its own `session` reference — `InferenceSession` isn't a plain
 * JS object GC can reclaim on its own; onnxruntime-web only actually frees
 * the native-side memory once `.release()` resolves. Fire-and-forget by
 * design: `unload()` itself stays synchronous (MattingModel's interface
 * contract), and a caller unloading a model to free memory has no further
 * use for this promise — logged rather than thrown so a release failure
 * can't surface as an unhandled rejection.
 */
export function releaseInferenceSession(session: ort.InferenceSession): void {
  session.release().catch((err) => console.error("Failed to release inference session:", err));
}

export { ort };
