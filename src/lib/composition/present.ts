import type { ViewportState } from "../matting/pipeline/refine/viewport";
import type { AnyCanvas } from "./canvas";
import { createCanvas, get2d } from "./canvas";
import type { Size } from "./viewport";

/**
 * Puts a rendered preview raster on screen through the viewport: pasteboard,
 * transparency checkerboard, the raster, and a frame border. Editing chrome
 * (handles, guides, rulers, safe zones) is drawn on top by overlay.ts. Both
 * are screen-space only and can never end up in a final render.
 */
export interface PresentOptions {
  viewport: ViewportState;
  composition: Size;
  /** CSS size of the screen canvas. */
  view: Size;
  devicePixelRatio: number;
  /** Show a checkerboard behind the composition (transparent background). */
  checkerboard: boolean;
  pasteboard: string;
}

/** Above this many screen px per preview px, switch to nearest-neighbour so pixel inspection shows real pixels rather than a blur. */
const PIXELATE_ABOVE = 3;

let checkerTile: AnyCanvas | null = null;
function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!checkerTile) {
    checkerTile = createCanvas(16, 16);
    const t = get2d(checkerTile);
    t.fillStyle = "#d4d4d8";
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = "#f4f4f5";
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
  }
  return ctx.createPattern(checkerTile as CanvasImageSource, "repeat");
}

export function presentPreview(ctx: CanvasRenderingContext2D, raster: CanvasImageSource & { width: number; height: number }, opts: PresentOptions): void {
  const { viewport: vp, composition: comp, devicePixelRatio: dpr } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = opts.pasteboard;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Composition rectangle in device pixels.
  const x = vp.panX * dpr;
  const y = vp.panY * dpr;
  const w = comp.width * vp.zoom * dpr;
  const h = comp.height * vp.zoom * dpr;

  if (opts.checkerboard) {
    const pattern = checkerPattern(ctx);
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(x, y, w, h);
    }
  }

  const magnification = w / raster.width;
  ctx.imageSmoothingEnabled = magnification <= PIXELATE_ABOVE;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(raster, x, y, w, h);

  // Thin frame so the composition edge is visible against a similar pasteboard color.
  ctx.strokeStyle = "rgba(127,127,127,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w) + 1, Math.round(h) + 1);
}
