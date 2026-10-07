import { isTrimmableContent, type Clip } from "../timeline/clip";
import type { FrameRequest } from "./frame-provider";
import type { SequenceFrame } from "./frame-sequence";

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
 * Images get one matte. Video gets mattes at sampled source frames across the
 * clip's range (sample-and-hold in between — the same sparse policy as the
 * engine's own video cutout path); a frame the engine fails on is skipped,
 * never faked, and if every frame fails the whole call throws.
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
  /** Video: matte samples per second of clip (default 6). Every sample is a full engine run. */
  samplesPerSecond?: number;
  signal?: AbortSignal;
  onProgress?: (p: { phase: "model" | "frames"; done: number; total: number; modelFraction?: number }) => void;
  /** Injected in tests; production uses the real pipeline (loaded lazily so the editor doesn't pay for it until used). */
  matteFn?: MatteFn;
  /** Turns an alpha buffer into a drawable matte image (default: a canvas). Injected in tests (no DOM in Node). */
  toImage?: (rgba: Uint8ClampedArray, width: number, height: number) => CanvasImageSource & { width: number; height: number };
}

export type GeneratedMatte = { kind: "still"; image: CanvasImageSource & { width: number; height: number }; report: MatteReport } | { kind: "sequence"; frames: SequenceFrame<CanvasImageSource & { width: number; height: number }>[]; report: MatteReport };

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

/** Source frames to matte for a video clip: evenly spaced over [in, out), always including the first and last. */
export function sampleFrames(sourceIn: number, sourceOut: number, fps: number, samplesPerSecond: number): number[] {
  const last = sourceOut - 1;
  if (last <= sourceIn) return [sourceIn];
  const step = Math.max(1, Math.round(fps / Math.max(0.1, samplesPerSecond)));
  const out: number[] = [];
  for (let f = sourceIn; f < last; f += step) out.push(f);
  out.push(last);
  return out;
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
  const toImage = opts.toImage ?? defaultToImage;
  const frames = isTrimmableContent(c) ? sampleFrames(c.sourceInFrame, c.sourceOutFrame, opts.fps, opts.samplesPerSecond ?? 6) : [0];
  const report: MatteReport = { framesRequested: frames.length, framesMatted: 0, framesFailed: 0, modelsUsed: [], meanConfidence: 0, warnings: [] };
  const out: SequenceFrame<CanvasImageSource & { width: number; height: number }>[] = [];
  let lastError: unknown = null;
  let confSum = 0;

  for (let i = 0; i < frames.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("Background removal cancelled.", "AbortError");
    opts.onProgress?.({ phase: "frames", done: i, total: frames.length });
    const image = await provider.getExactFrame({ sourceId, sourceFrame: frames[i], slotKey: `${clip.id}#bgmatte` });
    const { width, height } = frameSize(image, info);
    try {
      const r = await matteFn(image, width, height, (f) => opts.onProgress?.({ phase: "model", done: i, total: frames.length, modelFraction: f }));
      out.push({ frame: frames[i], image: toImage(alphaToMatteRgba(r.alpha, r.alphaWidth, r.alphaHeight), r.alphaWidth, r.alphaHeight) });
      report.framesMatted++;
      confSum += r.confidence;
      if (!report.modelsUsed.includes(r.modelUsed)) report.modelsUsed.push(r.modelUsed);
      for (const w of r.warnings) if (!report.warnings.includes(w)) report.warnings.push(w);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      report.framesFailed++;
      lastError = e;
    }
  }
  opts.onProgress?.({ phase: "frames", done: frames.length, total: frames.length });
  if (out.length === 0) {
    const reason = lastError instanceof Error ? lastError.message : "no frame could be processed";
    throw new MatteGenerationError(`Background removal failed: ${reason}`);
  }
  report.meanConfidence = confSum / report.framesMatted;
  // All samples must share one size for the sequence source; the engine returns alpha at source resolution, so they do.
  if (!isTrimmableContent(c)) return { kind: "still", image: out[0].image, report };
  return { kind: "sequence", frames: out, report };
}
