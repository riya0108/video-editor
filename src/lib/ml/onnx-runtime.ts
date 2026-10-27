import * as ort from "onnxruntime-web";
import ortGlueUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";

// Not served from /public (unlike ffmpeg-core): the wasm loader uses a
// dynamic import() of its .mjs companion, which Vite's dev server refuses for
// files served from /public ("should not be imported from source code").
// Instead the glue is fetched as plain bytes (Vite `?url`, so it's
// self-hosted and version-matched in both dev and build) and handed to ORT
// as a blob: URL — see loadRuntimeFiles() for why it must be a blob.

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

/** Session creation hangs forever (rather than rejecting) when the runtime can't start, so cap it — generous, since a large model on a slow CPU legitimately takes a while to optimize. */
const CREATE_TIMEOUT_MS = 120_000;

let runtimeFiles: Promise<void> | null = null;

/**
 * Points ORT at a blob: copy of its Emscripten glue (+ the self-hosted .wasm).
 * With the multi-threaded build, the glue spawns its pthread pool via
 * `new Worker(import.meta.url)`; under the proxy that happens *inside* ORT's
 * proxy worker. Some Chromium builds (the Claude desktop app's built-in
 * browser, Electron) can't start a nested worker from an http(s) URL — the
 * nested worker fires `error` (which Emscripten never listens for) and
 * `InferenceSession.create` waits on the pool forever. Nested workers from
 * blob: URLs do start there, and a glue module imported from a blob: URL
 * has a blob: `import.meta.url`, so its pthreads do too. Harmless in
 * browsers where the plain URL already worked (real Chrome). Best effort:
 * if fetching the glue fails, ORT keeps its embedded defaults.
 */
function loadRuntimeFiles(): Promise<void> {
  runtimeFiles ??= (async () => {
    try {
      const res = await fetch(ortGlueUrl);
      if (!res.ok) throw new Error(`${res.status} ${res.url}`);
      const glue = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: "text/javascript" }));
      // Never revoked: the glue lazily spawns extra pthread workers from this URL for the lifetime of the page.
      ort.env.wasm.wasmPaths = { mjs: glue, wasm: new URL(ortWasmUrl, location.href).href };
    } catch (err) {
      console.warn("Couldn't load the ONNX runtime glue as a blob; using onnxruntime-web's defaults:", err);
    }
  })();
  return runtimeFiles;
}

/**
 * Whether ORT's wasm runtime was initialized behind its proxy worker. ORT
 * initializes once per page and then routes every later call by the
 * *current* `env.wasm.proxy` — flipping it after init sends calls to a
 * runtime that was never started ("worker not ready" / uninitialized wasm).
 * So the first session decides, and every later one must match.
 */
let proxied: boolean | null = null;

// The wasm backend is a single Emscripten instance and rejects overlapping
// create/run calls ("Session already started") — chain every one of them.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function createInferenceSession(
  buffer: Uint8Array,
  device: RuntimeDevice,
): Promise<ort.InferenceSession> {
  await loadRuntimeFiles();
  return serialized(async () => {
    // Proxy WASM (CPU) execution to a worker thread instead of running it
    // synchronously on the main thread — without this, a heavy model (e.g.
    // the upscale tool's RRDBNet super-resolution net) freezes the entire tab,
    // including its own progress bar, for as long as inference takes, which
    // looks indistinguishable from the app having hung. Only for the "wasm"
    // provider: WebGPU dispatch is already off the main thread, and proxying
    // it too has been observed to make session creation spin forever.
    proxied ??= device.provider === "wasm";
    let provider = device.provider;
    if (proxied && provider === "webgpu") {
      // The runtime is already committed to the proxy (see `proxied`), which
      // can't host WebGPU — run this session on the proxied CPU backend
      // instead. An fp16 variant isn't safe there (see RuntimeDevice).
      if (device.useFp16) {
        throw new Error("This model needs WebGPU, but another AI tool already started the CPU runtime on this page. Reload the page and try again.");
      }
      console.warn("ONNX runtime is already running on the CPU worker; creating this WebGPU session on WASM instead.");
      provider = "wasm";
    }
    ort.env.wasm.proxy = proxied;
    // onnxruntime-web's own default caps threads at min(hardwareConcurrency/2, 4)
    // to be conservative on shared/mobile hardware; this app already requires
    // cross-origin isolation (see astro.config.mjs) for ffmpeg's multi-threaded
    // core, so the same SharedArrayBuffer-backed thread pool is available here
    // too — use every core the machine offers instead of leaving most of them idle.
    // (Only read at init, so it's moot after the first session either way.)
    if (provider === "wasm") {
      ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    }
    const session = await withTimeout(
      ort.InferenceSession.create(buffer, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
      }),
      CREATE_TIMEOUT_MS,
      "The AI model didn't start. Reload the page and try again.",
    );
    // Callers run sessions directly, so route their run()/release() through the same queue.
    const run = session.run.bind(session) as (...args: unknown[]) => Promise<ort.InferenceSession.ReturnType>;
    const release = session.release.bind(session);
    session.run = ((...args: unknown[]) => serialized(() => run(...args))) as ort.InferenceSession["run"];
    session.release = () => serialized(release);
    return session;
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
