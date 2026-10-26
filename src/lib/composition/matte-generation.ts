import { isTrimmableContent, type Clip } from "../timeline/clip";
import type { FrameRequest } from "./frame-provider";
import { MatteTrackBuilder, downsampleAlpha, matteStorageSize, type MatteChunk } from "./matte-track";

/**
 * BACKGROUND REMOVAL -> MATTE INPUT (MASK_COMPOSITING_ARCHITECTURE.md §7).
 *
 * The bridge between the existing professional matting engine
 * (lib/matting/pipeline: model routing, refinement, edge refinement,
 * decontamination, quality analysis) and the compositor's matte input. It
 * does NOT replace or re-implement any of that — it calls
 * `removeBackgroundFromImage` exactly as the Remove Background tool does,
 * with the same license-safe defaults, and turns each result's continuous
 * alpha into a matte source the compositor already knows how to apply
 * (ClipVisual.matte -> destination-in, aligned through the layer's crop).
 *
 * Non-destructive: the clip's own media is only read. The matte is a
 * separate source referenced by id, so it can be inverted, swapped,
 * combined with masks, or removed (one undo step) at any time.
 *
 * Images get one matte. Video gets ONE MATTE PER SOURCE FRAME across the clip's
 * range — no sampling, so a moving subject is cut out where it actually is on
 * every frame (sample-and-hold at 6 fps was measured at IoU 0.904 on hand
 * motion, RELEASE_BLOCKERS.md B-04). Video mattes are streamed into a compact
 * matte track (matte-track.ts: 8-bit alpha, ≤ 640 px long side, near-lossless,
 * chunked), so neither generation nor the result holds full-resolution RGBA
 * frames (B-05). A frame the engine fails on repeats the previous frame's matte
 * and is counted in the report (framesFailed) — never silently; if every frame
 * fails the whole call throws.
 */

/** What the generator needs from a frame source — MediaFrameProvider satisfies it. */
export interface MatteFrameSource {
  getSourceInfo(sourceId: string): { width: number; height: number } | undefined;
  getExactFrame(req: FrameRequest): Promise<CanvasImageSource>;
}

/** The slice of a MattingResult this bridge uses. */
export interface MatteAlpha {
  alpha: Float32Array;
  alphaWidth: number;
  alphaHeight: number;
  modelUsed: string;
  confidence: number;
  warnings: string[];
}

export type MatteFn = (source: CanvasImageSource, width: number, height: number, onModelLoadProgress?: (f: number) => void) => Promise<MatteAlpha>;

export interface GenerateMatteOptions {
  fps: number;
  signal?: AbortSignal;
  onProgress?: (p: { phase: "model" | "frames"; done: number; total: number; modelFraction?: number }) => void;
  /** Injected in tests; production uses the real pipeline (loaded lazily so the editor doesn't pay for it until used). */
  matteFn?: MatteFn;
  /** Images: turns the alpha into a drawable matte image (default: a canvas). Injected in tests (no DOM in Node). */
  toImage?: (rgba: Uint8ClampedArray, width: number, height: number) => CanvasImageSource & { width: number; height: number };
}

export type GeneratedMatte =
  | { kind: "still"; image: CanvasImageSource & { width: number; height: number }; report: MatteReport }
  /** Video: every source frame in [firstFrame, firstFrame + frameCount), as matte-track chunks. */
  | { kind: "track"; chunks: MatteChunk[]; width: number; height: number; firstFrame: number; frameCount: number; report: MatteReport };

/**
 * Longest video clip background removal accepts. Each frame is a full engine run (≈ 0.45 s for 720x1280 on WASM, so
 * 10 min ≈ 2.3 h) and the stored track grows ≈ 17 KB per frame (≈ 30 MB per minute at 30 fps).
 */
export const MAX_MATTE_CLIP_SECONDS = 10 * 60;

export interface MatteReport {
  framesRequested: number;
  framesMatted: number;
  framesFailed: number;
  modelsUsed: string[];
  /** Mean engine confidence over matted frames (the engine's own, inspectable number). */
  meanConfidence: number;
  warnings: string[];
}

export class MatteGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatteGenerationError";
  }
}

/** Stable source id for a clip's background-removal matte (per source + range, so a regenerated matte replaces it). */
export function matteSourceIdFor(clip: Clip): string {
  const c = clip.content;
  if (isTrimmableContent(c)) return `bgmatte:${c.source.sourceId}:${c.sourceInFrame}-${c.sourceOutFrame}`;
  if (c.source) return `bgmatte:${c.source.sourceId}`;
  throw new MatteGenerationError("Only video and image layers can have their background removed.");
}

/** Whether a clip has source pixels the matting engine can process (video/overlay/image/bitmap graphic). */
export function canRemoveBackground(clip: Clip): boolean {
  const c = clip.content;
  return isTrimmableContent(c) ? c.kind !== "audio" : !!c.source && !c.shape && !c.svg;
}

/** Continuous 0..1 alpha -> RGBA matte bytes (white, alpha = matte). Pure. */
export function alphaToMatteRgba(alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = alpha[i];
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.round((a > 1 ? 1 : a < 0 ? 0 : a) * 255);
  }
  return out;
}

function defaultToImage(rgba: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new MatteGenerationError("Canvas 2D is not available.");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

const defaultMatteFn: MatteFn = async (source, width, height, onModelLoadProgress) => {
  const { removeBackgroundFromImage } = await import("../matting/pipeline");
  return removeBackgroundFromImage(source, width, height, { onModelLoadProgress });
};

/** Intrinsic size of a decoded frame (canvas/bitmap/video/image). */
function frameSize(img: CanvasImageSource, fallback: { width: number; height: number }): { width: number; height: number } {
  const v = img as { videoWidth?: number; naturalWidth?: number; width?: number; height?: number; videoHeight?: number; naturalHeight?: number };
  const width = v.videoWidth || v.naturalWidth || (typeof v.width === "number" ? v.width : 0) || fallback.width;
  const height = v.videoHeight || v.naturalHeight || (typeof v.height === "number" ? v.height : 0) || fallback.height;
  return { width, height };
}

export async function generateClipMatte(provider: MatteFrameSource, clip: Clip, opts: GenerateMatteOptions): Promise<GeneratedMatte> {
  if (!canRemoveBackground(clip)) throw new MatteGenerationError("Only video and image layers can have their background removed.");
  const c = clip.content;
  const sourceId = (c as { source: { sourceId: string } }).source.sourceId;
  const info = provider.getSourceInfo(sourceId);
  if (!info) throw new MatteGenerationError("The layer's media isn't loaded yet.");
  const matteFn = opts.matteFn ?? defaultMatteFn;
  const report: MatteReport = { framesRequested: 0, framesMatted: 0, framesFailed: 0, modelsUsed: [], meanConfidence: 0, warnings: [] };
  let lastError: unknown = null;
  let confSum = 0;
  const aborted = () => {
    if (opts.signal?.aborted) throw new DOMException("Background removal cancelled.", "AbortError");
  };
  /** One engine run; null when the engine failed on this frame (an abort is rethrown). */
  const matteOne = async (image: CanvasImageSource, i: number, total: number): Promise<MatteAlpha | null> => {
    const { width, height } = frameSize(image, info);
    try {
      const r = await matteFn(image, width, height, (f) => opts.onProgress?.({ phase: "model", done: i, total, modelFraction: f }));
      report.framesMatted++;
      confSum += r.confidence;
      if (!report.modelsUsed.includes(r.modelUsed)) report.modelsUsed.push(r.modelUsed);
      for (const w of r.warnings) if (!report.warnings.includes(w)) report.warnings.push(w);
      return r;
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      report.framesFailed++;
      lastError = e;
      return null;
    }
  };
  const failure = () => {
    const reason = lastError instanceof Error ? lastError.message : "no frame could be processed";
    return new MatteGenerationError(`Background removal failed: ${reason}`);
  };

  if (!isTrimmableContent(c)) {
    report.framesRequested = 1;
    aborted();
    opts.onProgress?.({ phase: "frames", done: 0, total: 1 });
    const image = await provider.getExactFrame({ sourceId, sourceFrame: 0, slotKey: `${clip.id}#bgmatte` });
    const r = await matteOne(image, 0, 1);
    opts.onProgress?.({ phase: "frames", done: 1, total: 1 });
    if (!r) throw failure();
    report.meanConfidence = confSum / report.framesMatted;
    const toImage = opts.toImage ?? defaultToImage;
    return { kind: "still", image: toImage(alphaToMatteRgba(r.alpha, r.alphaWidth, r.alphaHeight), r.alphaWidth, r.alphaHeight), report };
  }

  // VIDEO: every source frame of the clip, in order (the exact-frame decoder reads forward, one decode per frame).
  const first = c.sourceInFrame;
  const total = Math.max(1, c.sourceOutFrame - c.sourceInFrame);
  if (total / opts.fps > MAX_MATTE_CLIP_SECONDS) {
    throw new MatteGenerationError(`This clip is ${(total / opts.fps / 60).toFixed(1)} minutes long; background removal handles up to ${MAX_MATTE_CLIP_SECONDS / 60} minutes per clip. Split or trim it first.`);
  }
  report.framesRequested = total;
  // Sized from the engine's first alpha (it returns source resolution); every later frame is stored at that size.
  let builder: MatteTrackBuilder | null = null;
  /** Frames the engine failed on before any success — filled with the first good matte once there is one. */
  let leadingFailures = 0;
  for (let i = 0; i < total; i++) {
    aborted();
    opts.onProgress?.({ phase: "frames", done: i, total });
    const image = await provider.getExactFrame({ sourceId, sourceFrame: first + i, slotKey: `${clip.id}#bgmatte` });
    const r = await matteOne(image, i, total);
    if (!r) {
      if (!builder || !(await builder.repeatLast())) leadingFailures++;
      continue;
    }
    if (!builder) {
      const size = matteStorageSize(r.alphaWidth, r.alphaHeight);
      builder = new MatteTrackBuilder(size.width, size.height, first);
    }
    const alpha = downsampleAlpha(r.alpha, r.alphaWidth, r.alphaHeight, builder.width, builder.height);
    for (let k = 0; k <= leadingFailures; k++) await builder.push(alpha);
    leadingFailures = 0;
  }
  aborted();
  opts.onProgress?.({ phase: "frames", done: total, total });
  if (!builder) throw failure();
  report.meanConfidence = confSum / report.framesMatted;
  if (report.framesFailed > 0) report.warnings.push(`${report.framesFailed} of ${total} frames couldn't be processed and reuse the nearest processed frame's matte.`);
  return { kind: "track", chunks: await builder.finish(), width: builder.width, height: builder.height, firstFrame: first, frameCount: total, report };
}
