/**
 * Live approximation of ffmpeg's blurred-background reframe (`split` +
 * `avgblur=sizeX=40:sizeY=40` + `overlay`): draws `source` cover-fit and
 * blurred across the whole stage, then draws it again contain-fit and sharp
 * on top. `blurPx` should already be scaled to the destination canvas size
 * by the caller — ffmpeg's `sizeX=40` is a fixed pixel radius at export
 * resolution, which would look barely visible (or excessive) at arbitrary
 * preview sizes if reused literally.
 */
export function drawBgBlurFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  stage: { width: number; height: number },
  box: { width: number; height: number },
  blurPx: number,
) {
  if (sourceW <= 0 || sourceH <= 0 || stage.width <= 0 || stage.height <= 0) return;

  // Background: cover-fit, blurred.
  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  const coverScale = Math.max(stage.width / sourceW, stage.height / sourceH);
  const cw = sourceW * coverScale;
  const ch = sourceH * coverScale;
  ctx.drawImage(source, (stage.width - cw) / 2, (stage.height - ch) / 2, cw, ch);
  ctx.restore();

  // Foreground: contain-fit (matches FramedVideoStage's own `box` math), sharp.
  const left = (stage.width - box.width) / 2;
  const top = (stage.height - box.height) / 2;
  ctx.drawImage(source, left, top, box.width, box.height);
}
