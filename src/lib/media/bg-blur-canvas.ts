import type { BgFillMode, GradientDirection } from "../ffmpeg/editor-state";

export interface BgFillOptions {
  mode: BgFillMode;
  /** Already scaled to the destination canvas size by the caller — ffmpeg's
   * blur radius is a fixed pixel value at export resolution, which would
   * look wrong reused literally at arbitrary preview sizes. */
  blurPx: number;
  solidColor: string;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: GradientDirection;
}

function paintGradient(
  ctx: CanvasRenderingContext2D,
  stage: { width: number; height: number },
  direction: GradientDirection,
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
 * Live approximation of the editor's "fit onto a canvas, fill the rest"
 * reframe. Mirrors build-editor-command.ts's filter chain for each mode:
 * blur (`split` + `avgblur` + `overlay`), solid (`color` source), or
 * gradient (`geq`) — then draws `source` contain-fit and sharp on top.
 */
export function drawBgFillFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  stage: { width: number; height: number },
  box: { width: number; height: number },
  fill: BgFillOptions,
) {
  if (sourceW <= 0 || sourceH <= 0 || stage.width <= 0 || stage.height <= 0) return;

  if (fill.mode === "solid") {
    ctx.fillStyle = fill.solidColor;
    ctx.fillRect(0, 0, stage.width, stage.height);
  } else if (fill.mode === "gradient") {
    paintGradient(ctx, stage, fill.gradientDirection, fill.gradientFrom, fill.gradientTo);
  } else {
    ctx.save();
    ctx.filter = `blur(${fill.blurPx}px)`;
    const coverScale = Math.max(stage.width / sourceW, stage.height / sourceH);
    const cw = sourceW * coverScale;
    const ch = sourceH * coverScale;
    ctx.drawImage(source, (stage.width - cw) / 2, (stage.height - ch) / 2, cw, ch);
    ctx.restore();
  }

  // Foreground: contain-fit (matches FramedVideoStage's own `box` math), sharp.
  const left = (stage.width - box.width) / 2;
  const top = (stage.height - box.height) / 2;
  ctx.drawImage(source, left, top, box.width, box.height);
}
