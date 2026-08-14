import type { EditorChromaKeyState } from "../ffmpeg/editor-state";

/** Longest side of the working canvas used for the per-pixel key pass — kept small since this only needs to look right on-screen, not be pixel-exact, and getImageData/putImageData cost scales with pixel count. */
const WORK_MAX_SIDE = 480;

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = parseInt(clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawCover(ctx: CanvasRenderingContext2D, source: CanvasImageSource, sw: number, sh: number, dw: number, dh: number) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2, (dh - h) / 2, w, h);
}

/**
 * Live approximation of ffmpeg's `colorkey=color:similarity:blend` filter,
 * composited over the configured replacement. Not pixel-identical to
 * ffmpeg's own colorkey math — this is a same-shape distance/blend formula
 * good enough to preview live at on-screen resolution.
 */
export function drawChromaKeyed(
  video: HTMLVideoElement,
  state: EditorChromaKeyState,
  replacementEl: HTMLImageElement | HTMLVideoElement | null,
  work: HTMLCanvasElement,
): HTMLCanvasElement {
  const naturalW = video.videoWidth || 1;
  const naturalH = video.videoHeight || 1;
  const scale = Math.min(1, WORK_MAX_SIDE / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));
  if (work.width !== w) work.width = w;
  if (work.height !== h) work.height = h;

  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) return work;

  // Background layer: solid color, or the replacement image/video cover-fit.
  ctx.globalCompositeOperation = "source-over";
  if (state.replace === "color" || !replacementEl) {
    ctx.fillStyle = state.replaceColorHex;
    ctx.fillRect(0, 0, w, h);
  } else {
    const rw = "videoWidth" in replacementEl ? replacementEl.videoWidth || w : replacementEl.naturalWidth || w;
    const rh = "videoWidth" in replacementEl ? replacementEl.videoHeight || h : replacementEl.naturalHeight || h;
    drawCover(ctx, replacementEl, rw, rh, w, h);
  }

  // Foreground: draw the video to a scratch region, key it, then composite over the background.
  const fg = document.createElement("canvas");
  fg.width = w;
  fg.height = h;
  const fgCtx = fg.getContext("2d", { willReadFrequently: true });
  if (!fgCtx) return work;
  fgCtx.drawImage(video, 0, 0, w, h);

  const [kr, kg, kb] = hexToRgb(state.colorHex);
  const imageData = fgCtx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const similarity = state.similarity;
  const blend = Math.max(state.blend, 0.0001);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.6729559300637; // sqrt(255^2*3)
    const alpha = Math.min(1, Math.max(0, (dist - similarity) / blend));
    data[i + 3] = Math.round(alpha * 255);
  }
  fgCtx.putImageData(imageData, 0, 0);

  ctx.drawImage(fg, 0, 0);
  return work;
}
