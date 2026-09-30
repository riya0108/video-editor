import type { RawImage } from "@huggingface/transformers";
import { applyMaskForeground } from "../media/bg-removal-canvas";
import { loadSelfieSegmenter, segmentPersonMask } from "../media/selfie-segmenter";

/** Portrait/human matting model — outputs a single alpha mask isolating the person from the background. */
export const PERSON_SEGMENTATION_MODEL = "briaai/RMBG-1.4";

export interface CutoutFrame {
  /** Seconds from the start of the video (not the trim). */
  time: number;
  blob: Blob;
  url: string;
}

export interface CutoutProgress {
  phase: "downloading" | "processing";
  /** 0–1 */
  fraction: number;
}

export type Segmenter = (
  image: unknown,
) => Promise<{ mask: RawImage; label: string | null; score: number | null }[]>;

let cachedSegmenter: Promise<Segmenter> | null = null;

/**
 * RMBG-1.4's own config.json declares `"model_type": "SegformerForSemanticSegmentation"`
 * — a stray PyTorch class name left over from its custom `auto_map`-based
 * loading path in the *Python* transformers library, not a real registered
 * model_type keyword. transformers.js's pipeline() only dispatches by
 * model_type, so it can't map that string to any model class and throws
 * "Unsupported model type ... None of the candidate model classes support
 * this type" before ever touching the ONNX graph — this is an upstream
 * config quirk (see https://github.com/huggingface/transformers.js/issues/1107),
 * not something wrong with the weights, and other RMBG-1.4 ONNX mirrors
 * share the same config verbatim. The model's actual computation doesn't
 * read this field at all — it's purely a JS-side class-selection detail —
 * so fetching the real config and relabeling just that one field to
 * "isnet" (registered as a generic single-input/single-output segmentation
 * model, the same family RMBG-1.4 belongs to) lets it load through that
 * generic path instead, with everything else about the config untouched.
 */
async function loadRmbgConfig(modelId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://huggingface.co/${modelId}/resolve/main/config.json`);
  const config = await res.json();
  return { ...config, model_type: "isnet" };
}

/** Shared with other tools (e.g. passerby-track.ts) so the ~44MB RMBG-1.4 model is only ever downloaded once. */
export async function loadSegmenter(onProgress?: (p: CutoutProgress) => void): Promise<Segmenter> {
  if (cachedSegmenter) return cachedSegmenter;
  const promise = (async () => {
    const [{ pipeline }, config] = await Promise.all([
      import("@huggingface/transformers"),
      loadRmbgConfig(PERSON_SEGMENTATION_MODEL),
    ]);
    return pipeline("image-segmentation", PERSON_SEGMENTATION_MODEL, {
      dtype: "fp32",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see loadRmbgConfig's doc comment for why this override is needed
      config: config as any,
      progress_callback: (info: { status: string; progress?: number }) => {
        if (info.status === "progress_total" && typeof info.progress === "number") {
          onProgress?.({ phase: "downloading", fraction: info.progress / 100 });
        }
      },
    }) as unknown as Promise<Segmenter>;
  })();
  promise.catch(() => {
    if (cachedSegmenter === promise) cachedSegmenter = null;
  });
  cachedSegmenter = promise;
  return promise;
}

// Running a segmentation model on every frame of a real video, in-browser,
// would take minutes even for short clips — these bounds keep total inference
// calls (and therefore processing time) reasonable at the cost of some motion
// smoothness in the cutout layer, which ffmpeg later samples on/off with
// `enable=between(...)` the same way the rest of this app chains drawtext.
const MAX_FRAMES = 90;
const MIN_SAMPLE_FPS = 2;
const MAX_SAMPLE_FPS = 8;
const MAX_CUTOUT_WIDTH = 640;

export function pickCutoutSampleFps(durationSeconds: number): number {
  if (durationSeconds <= 0) return MAX_SAMPLE_FPS;
  const fps = MAX_FRAMES / durationSeconds;
  return Math.min(MAX_SAMPLE_FPS, Math.max(MIN_SAMPLE_FPS, fps));
}

/**
 * Hard ceiling on how many cutout frames ever become separate ffmpeg inputs
 * at export time, independent of `pickCutoutSampleFps`'s duration-based
 * heuristic above (which alone can't guarantee a small count — e.g. a long
 * clip pushed to the fps floor still multiplies out to well over 100
 * frames). This matters because export gives each sampled frame its own
 * `-loop 1` ffmpeg input, and this build's core-mt wasm ffmpeg only has a
 * small, fixed pthread pool (hardwareConcurrency+4, patched in
 * scripts/copy-ffmpeg-core.mjs) — each simultaneously-open looped input
 * holds one of those threads for the *entire run* (they never hit EOF to
 * free it), so once open inputs outnumber the pool, the remaining ones wait
 * forever for a thread that's never coming back: a silent, permanent hang,
 * not an error. Confirmed empirically: 8 cutout inputs on an 8-core (pool
 * size 12) machine exported fine; 24 hung indefinitely at 0% with no
 * console error. Reserving a few threads for the main video input, encoder,
 * and filtergraph bookkeeping keeps this safely under the pool on any
 * device, including low-core ones ffmpeg-core sizes down to a pool of ~8.
 */
function maxSafeCutoutInputs(): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(4, Math.min(cores - 2, 12));
}

/** Evenly thins `times` down to `cap` entries (keeping the first and last) when it's already longer — cheaper and simpler than re-deriving a slower fps after the fact. */
function capSampleTimes(times: number[], cap: number): number[] {
  if (times.length <= cap) return times;
  if (cap <= 1) return [times[0]];
  const result: number[] = [];
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * (times.length - 1)) / (cap - 1));
    result.push(times[idx]);
  }
  return result;
}

export function waitForSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
  });
}

/**
 * Shared scaffolding for both cutout strategies below: works out a safe,
 * capped set of sample times, seeks `video` to each one, draws it into a
 * fresh per-frame canvas at the (possibly downscaled) working resolution,
 * and hands that canvas to `produceBlob` to actually run the segmentation
 * model and return the cut-out PNG. Keeping this here means the sampling/
 * seeking/cap/progress logic — and its safety margin against ffmpeg's
 * pthread pool (see `maxSafeCutoutInputs`) — only has to be right in one
 * place. Exported so src/lib/matting/pipeline/video-cutout.ts can reuse the
 * exact same sampling behavior for its router-driven alternative to
 * generateSubjectCutouts below.
 *
 * PHASE 14 — PERFORMANCE (frame pipelining / CPU-GPU overlap). Frame i+1's
 * seek+draw (native, hardware-accelerated video decode) starts as soon as
 * frame i's canvas snapshot is taken, running concurrently with frame i's
 * `produceBlob` inference (CPU/GPU compute) instead of waiting for it —
 * decode and inference use different hardware resources, so this overlap
 * is close to free. Deliberately capped at one in-flight `produceBlob` call
 * at a time rather than true unbounded concurrency: most onnxruntime-web
 * sessions aren't documented as safe for concurrent `.run()` calls on the
 * same session, and each frame already gets its OWN freshly-allocated
 * canvas specifically so the overlapping seek/draw for the next frame can
 * never race with (or corrupt) the still-in-flight inference reading the
 * previous frame's canvas.
 */
export async function sampleTrimmedFrames(
  video: HTMLVideoElement,
  {
    start,
    end,
    onProgress,
    produceBlob,
    signal,
  }: {
    start: number;
    end: number;
    onProgress?: (p: CutoutProgress) => void;
    produceBlob: (canvas: HTMLCanvasElement, index: number) => Promise<Blob | null>;
    /** PHASE 14 — checked between frames; stops scheduling new work but lets any already-in-flight `produceBlob` call finish (there's no way to interrupt an in-progress model inference). */
    signal?: AbortSignal;
  },
): Promise<CutoutFrame[]> {
  const duration = Math.max(0, end - start);
  if (duration <= 0 || video.videoWidth === 0) return [];

  const naturalW = video.videoWidth;
  const naturalH = video.videoHeight;
  const scale = Math.min(1, MAX_CUTOUT_WIDTH / naturalW);
  const outW = Math.max(2, Math.round((naturalW * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((naturalH * scale) / 2) * 2);

  const fps = pickCutoutSampleFps(duration);
  const step = 1 / fps;
  let times: number[] = [];
  for (let t = start; t < end; t += step) times.push(t);
  if (times.length === 0) times.push(start);
  times = capSampleTimes(times, maxSafeCutoutInputs());

  const drawFrame = (): HTMLCanvasElement | null => {
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = outW;
    frameCanvas.height = outH;
    const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
    if (!frameCtx) return null;
    frameCtx.drawImage(video, 0, 0, outW, outH);
    return frameCanvas;
  };

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();

  const frames: CutoutFrame[] = [];
  // The one in-flight produceBlob() call, paired with the timestamp it's
  // for — awaited right before the NEXT frame would otherwise start a
  // second one, so the seek/draw for frame i+1 always overlaps frame i's
  // inference instead of running after it.
  let pending: { t: number; work: Promise<Blob | null> } | null = null;

  const settlePending = async () => {
    if (!pending) return;
    const { t, work } = pending;
    pending = null;
    const blob = await work;
    if (blob) frames.push({ time: t, blob, url: URL.createObjectURL(blob) });
  };

  try {
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) break;
      const t = times[i];
      video.currentTime = t;
      await waitForSeek(video);
      const frameCanvas = drawFrame();

      await settlePending();
      onProgress?.({ phase: "processing", fraction: i / times.length });

      // Re-checked here, not just at the top of the loop: settlePending()
      // above just awaited a real, potentially slow model inference, which
      // is plenty of time for a cancel click to land — scheduling one more
      // frame's worth of work anyway (only to discard it) would make
      // cancellation lag by up to two full frames instead of stopping as
      // soon as the current one finishes.
      if (frameCanvas && !signal?.aborted) pending = { t, work: produceBlob(frameCanvas, i) };
    }
    await settlePending();
    if (!signal?.aborted) onProgress?.({ phase: "processing", fraction: 1 });
  } finally {
    video.currentTime = originalTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  return frames;
}

/**
 * Samples the trimmed range of `video` at a reduced fps, and for each sample
 * runs an in-browser person-segmentation model (MediaPipe's selfie
 * segmenter — see ../media/selfie-segmenter.ts; separate from `loadSegmenter`
 * above, which stays on RMBG-1.4 for this file's other, non-person-specific
 * callers) to cut the person out onto a transparent background. Used for the
 * live "behind a person" caption preview (nearest-sample lookup) and its
 * export overlay — deliberately kept on the small, fast, person-only model
 * since that feature is specifically about a person occluding text, and
 * needs to stay responsive as a live preview.
 */
export async function generatePersonCutouts(
  video: HTMLVideoElement,
  { start, end, onProgress, signal }: { start: number; end: number; onProgress?: (p: CutoutProgress) => void; signal?: AbortSignal },
): Promise<CutoutFrame[]> {
  onProgress?.({ phase: "downloading", fraction: 0 });
  const segmenter = await loadSelfieSegmenter();
  onProgress?.({ phase: "downloading", fraction: 1 });

  const work = document.createElement("canvas");
  return sampleTrimmedFrames(video, {
    start,
    end,
    onProgress,
    signal,
    produceBlob: async (canvas, i) => {
      const mask = segmentPersonMask(segmenter, canvas, i);
      if (!mask) return null;
      const cutout = applyMaskForeground(canvas, canvas.width, canvas.height, mask, work);
      return new Promise<Blob | null>((resolve) => cutout.toBlob(resolve, "image/png"));
    },
  });
}

/**
 * Same shape as `generatePersonCutouts`, but backed by RMBG-1.4 (`loadSegmenter`)
 * — the same general-purpose dichotomous segmentation model the still-image
 * "no green screen" mode already uses — instead of the person-only selfie
 * model. Used by the Remove Background tool's video AI mode so it can find
 * *any* subject (a hand, a product, a phone/laptop, a person) rather than
 * just people, matching what the image path already does.
 */
export async function generateSubjectCutouts(
  video: HTMLVideoElement,
  { start, end, onProgress, signal }: { start: number; end: number; onProgress?: (p: CutoutProgress) => void; signal?: AbortSignal },
): Promise<CutoutFrame[]> {
  const [segmenter, { RawImage }] = await Promise.all([loadSegmenter(onProgress), import("@huggingface/transformers")]);

  return sampleTrimmedFrames(video, {
    start,
    end,
    onProgress,
    signal,
    produceBlob: async (canvas) => {
      const output = await segmenter(canvas);
      let mask = output[0]?.mask;
      if (!mask) return null;
      if (mask.width !== canvas.width || mask.height !== canvas.height) {
        mask = await mask.resize(canvas.width, canvas.height);
      }
      mask.grayscale();
      const cutoutRaw = RawImage.fromCanvas(canvas).clone().rgba();
      cutoutRaw.putAlpha(mask);
      return (await cutoutRaw.toBlob("image/png")) as Blob;
    },
  });
}

export function revokeCutoutFrames(frames: CutoutFrame[]) {
  for (const f of frames) URL.revokeObjectURL(f.url);
}

/** Picks the sampled cutout frame closest in time — used for the live preview, which can't afford one inference per rendered frame. */
export function nearestCutoutFrame(frames: CutoutFrame[], time: number): CutoutFrame | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDist = Math.abs(frames[0].time - time);
  for (const f of frames) {
    const dist = Math.abs(f.time - time);
    if (dist < bestDist) {
      best = f;
      bestDist = dist;
    }
  }
  return best;
}
