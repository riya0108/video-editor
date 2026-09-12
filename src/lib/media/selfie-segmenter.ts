import { FilesetResolver, ImageSegmenter, type ImageSource } from "@mediapipe/tasks-vision";

// Same rationale as ../ml/onnx-runtime.ts: the wasm loader does a dynamic
// import() of its own .mjs companion, which Vite's dev server refuses for
// files served from /public — so the wasm bundle is fetched from jsdelivr
// (version-pinned to the installed package) instead of self-hosted.
const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

// Google's official "selfie segmenter" — a ~250KB MobileNet-based model
// built for exactly this: real-time person segmentation for background
// replacement, the same class of model behind Google Meet/Zoom virtual
// backgrounds. Self-hosted since it's tiny. Apache-2.0, safe for commercial
// use — unlike RMBG-1.4 (this app's other segmentation model), which is
// source-available/non-commercial only.
const MODEL_URL = "/models/selfie_segmenter.tflite";

export interface PersonMask {
  /** Foreground (person) confidence per pixel, 0-1. */
  data: Float32Array;
  width: number;
  height: number;
}

let cachedSegmenter: Promise<ImageSegmenter> | null = null;

async function createSegmenter(delegate: "GPU" | "CPU"): Promise<ImageSegmenter> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

/** Loads (and caches) the shared selfie-segmentation model — GPU delegate when available, falling back to CPU/wasm for environments without a working WebGL context. */
export function loadSelfieSegmenter(): Promise<ImageSegmenter> {
  if (cachedSegmenter) return cachedSegmenter;
  const promise = createSegmenter("GPU").catch(() => createSegmenter("CPU"));
  promise.catch(() => {
    if (cachedSegmenter === promise) cachedSegmenter = null;
  });
  cachedSegmenter = promise;
  return promise;
}

/**
 * Runs person segmentation on one video/canvas/image frame — synchronous
 * (matches FramedVideoStage's sync onDrawFrame loop, and the sequential
 * seek-per-frame export loop) since MediaPipe's own VIDEO-mode API is sync
 * when called without a callback. `timestampMs` only needs to strictly
 * increase between calls on the same segmenter instance — it doesn't need to
 * match the source video's own clock (the model is a plain per-frame
 * segmenter, not a temporal/recurrent one), so callers can use wall-clock
 * time or a synthetic frame counter, whichever is convenient.
 */
export function segmentPersonMask(segmenter: ImageSegmenter, source: ImageSource, timestampMs: number): PersonMask | null {
  const result = segmenter.segmentForVideo(source, Math.round(timestampMs));
  try {
    const mask = result.confidenceMasks?.[0];
    if (!mask) return null;
    return { data: mask.getAsFloat32Array(), width: mask.width, height: mask.height };
  } finally {
    result.close();
  }
}
