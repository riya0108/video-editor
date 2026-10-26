import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { TimelineModel } from "../timeline/model";
import type { FinalRenderer } from "../composition";

/**
 * GIF EXPORT — renders the timeline (or a span of it) through the FINAL renderer, the same pixels as the video
 * export, scaled down, and encodes an animated GIF in the browser with gifenc (MIT). Each frame gets its own
 * 256-color palette (sharper than one global palette); a transparent composition background exports as GIF
 * transparency (1-bit, as the format allows).
 */

export interface GifOptions {
  startSec: number;
  endSec: number;
  fps: number;
  width: number;
  /** 0 = loop forever. */
  loop: boolean;
}

export const GIF_LIMITS = { maxSeconds: 30, maxWidth: 960, fps: [8, 10, 12, 15, 20, 24] as const };

export async function exportGif(timeline: TimelineModel, renderer: FinalRenderer, opts: GifOptions, onProgress: (f: number) => void, signal?: AbortSignal): Promise<Blob> {
  const { width: cw, height: ch, background } = timeline.composition;
  const width = Math.min(GIF_LIMITS.maxWidth, Math.max(16, Math.round(opts.width / 2) * 2));
  const scale = width / cw;
  const height = Math.max(2, Math.round((ch * scale) / 2) * 2);
  const span = Math.max(0, Math.min(GIF_LIMITS.maxSeconds, opts.endSec - opts.startSec));
  const count = Math.max(1, Math.round(span * opts.fps));
  const transparent = background === "transparent";
  const format = transparent ? "rgba4444" : "rgb565";
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const delay = 1000 / opts.fps;
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const frame = Math.min(Math.round((opts.startSec + i / opts.fps) * timeline.frameRate), Math.max(0, Math.round(opts.endSec * timeline.frameRate) - 1));
    const { canvas: src } = await renderer.renderFrame(timeline, frame, { outputScale: scale });
    g.clearRect(0, 0, width, height);
    g.drawImage(src as CanvasImageSource, 0, 0, width, height);
    const { data } = g.getImageData(0, 0, width, height);
    const palette = quantize(data, 256, transparent ? { format, oneBitAlpha: true } : { format });
    const index = applyPalette(data, palette, format);
    const tIndex = transparent ? palette.findIndex((p) => p[3] === 0) : -1;
    // Exact timing: GIF delays are in 1/100 s, so spread the rounding error over frames.
    const d = Math.round(((i + 1) * delay) / 10) * 10 - Math.round((i * delay) / 10) * 10;
    gif.writeFrame(index, width, height, { palette, delay: d, repeat: opts.loop ? 0 : -1, transparent: tIndex >= 0, transparentIndex: Math.max(0, tIndex), dispose: transparent ? 2 : -1 });
    onProgress((i + 1) / count);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: "image/gif" });
}
