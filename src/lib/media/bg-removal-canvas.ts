export type BgReplaceMode = "transparent" | "color" | "gradient" | "blur" | "image" | "video";
export type BgGradientDirection = "vertical" | "horizontal" | "diagonal";

export interface ChromaSettings {
  colorHex: string;
  /** 0-1, matches ffmpeg colorkey's similarity param. */
  similarity: number;
  /** 0-1, matches ffmpeg colorkey's blend param. */
  blend: number;
}

export interface BgReplaceSettings {
  mode: BgReplaceMode;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: BgGradientDirection;
  imageEl: HTMLImageElement | null;
  videoEl: HTMLVideoElement | null;
}

/** Eyedropper sampling for the "pick the backdrop color" control — works for a <video> frame or a still <img> alike, unlike sample-video-color.ts's video-only helper. */
export function sampleColorAt(source: CanvasImageSource, w: number, h: number, fx: number, fy: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#00ff00";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * canvas.height)));
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = parseInt(clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
) {
  if (sw <= 0 || sh <= 0) return;
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2, (dh - h) / 2, w, h);
}

function paintGradient(
  ctx: CanvasRenderingContext2D,
  stage: { width: number; height: number },
  direction: BgGradientDirection,
  from: string,
  to: string,
) {
  const { width: w, height: h } = stage;
  const grad =
    direction === "horizontal"
      ? ctx.createLinearGradient(0, 0, w, 0)
      : direction === "diagonal"
        ? ctx.createLinearGradient(0, 0, w, h)
        : ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Keys a source image/video frame against a chroma color, producing an RGBA
 * canvas that's transparent everywhere close to that color — the subject cut
 * out, background gone. Same distance/blend formula as the full Video
 * Editor's live chroma-key preview (chroma-key-canvas.ts), but standalone so
 * this tool's state shape doesn't have to match the editor's document model,
 * and reusable for a still image (not just a <video> element).
 */
export function keyChromaForeground(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  chroma: ChromaSettings,
  work: HTMLCanvasElement,
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(sourceW));
  const h = Math.max(1, Math.round(sourceH));
  if (work.width !== w) work.width = w;
  if (work.height !== h) work.height = h;

  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) return work;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);

  const [kr, kg, kb] = hexToRgb(chroma.colorHex);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const similarity = chroma.similarity;
  const blend = Math.max(chroma.blend, 0.0001);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.6729559300637; // sqrt(255^2*3)
    const alpha = Math.min(1, Math.max(0, (dist - similarity) / blend));
    data[i + 3] = Math.round(data[i + 3] * alpha);
  }
  ctx.putImageData(imageData, 0, 0);
  return work;
}

/** Paints just the replacement background layer — a no-op for "transparent" (leaves whatever's already on `ctx`, typically nothing) and for "blur" (which needs the original frame, see `drawBlurredBackdrop`). */
export function drawBgReplacement(
  ctx: CanvasRenderingContext2D,
  stage: { width: number; height: number },
  replace: BgReplaceSettings,
) {
  if (replace.mode === "color") {
    ctx.fillStyle = replace.color;
    ctx.fillRect(0, 0, stage.width, stage.height);
  } else if (replace.mode === "gradient") {
    paintGradient(ctx, stage, replace.gradientDirection, replace.gradientFrom, replace.gradientTo);
  } else if (replace.mode === "image" && replace.imageEl) {
    drawCover(ctx, replace.imageEl, replace.imageEl.naturalWidth, replace.imageEl.naturalHeight, stage.width, stage.height);
  } else if (replace.mode === "video" && replace.videoEl) {
    drawCover(ctx, replace.videoEl, replace.videoEl.videoWidth, replace.videoEl.videoHeight, stage.width, stage.height);
  }
}

/** Blurred, cover-fit copy of the *original* source frame — the "blur my real background" mode, as opposed to compositing onto something else. */
export function drawBlurredBackdrop(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  stage: { width: number; height: number },
  blurPx: number,
) {
  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  drawCover(ctx, source, sourceW, sourceH, stage.width, stage.height);
  ctx.restore();
}

/**
 * Full live-preview compositor: clears the canvas (so "transparent" mode
 * genuinely shows nothing — the checkerboard behind the canvas does the
 * rest), paints the chosen background layer, then draws the already-keyed
 * `foreground` (chroma-keyed or AI-cutout, alpha punched through) contain-fit
 * into `box`.
 */
export function compositeBgRemoval(
  ctx: CanvasRenderingContext2D,
  originalSource: CanvasImageSource,
  originalW: number,
  originalH: number,
  foreground: CanvasImageSource,
  stage: { width: number; height: number },
  box: { width: number; height: number },
  replace: BgReplaceSettings,
  blurPx: number,
) {
  ctx.clearRect(0, 0, stage.width, stage.height);
  if (replace.mode === "blur") {
    drawBlurredBackdrop(ctx, originalSource, originalW, originalH, stage, blurPx);
  } else {
    drawBgReplacement(ctx, stage, replace);
  }
  const left = (stage.width - box.width) / 2;
  const top = (stage.height - box.height) / 2;
  ctx.drawImage(foreground, left, top, box.width, box.height);
}
