import type { BlendMode, ShapeSpec } from "../timeline/visual";
import { imageSourceSize } from "./frame-provider";
import { multiply, scale as scaleMatrix, type Matrix2D, type Rect } from "./matrix";
import type { ResolvedFrame, ResolvedLayer } from "./resolve";
import { cssFont, graphemes, lineBaseline, lineX, supportsLetterSpacing } from "./text-layout";
import type { TextStyle } from "../timeline/text-style";

/**
 * DRAW CORE — rasterizes a ResolvedFrame with Canvas 2D. Shared verbatim by
 * PreviewRenderer and FinalRenderer; the only inputs that differ are
 * `renderScale`, `smoothing`, and which pixels were fetched for each layer.
 *
 * Alpha compositing: Canvas 2D composites premultiplied "source-over" (Porter-
 * Duff), so a layer's own alpha (transparent PNG/WebM, text antialiasing),
 * its opacity (globalAlpha) and its matte all combine multiplicatively, and
 * stacked semi-transparent layers accumulate correctly. A matted layer is
 * first isolated on a scratch canvas — content, then matte applied with
 * destination-in/out — and only THEN composited with opacity and blend mode,
 * so the matte can never cut into layers underneath it.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LayerPixels {
  image?: CanvasImageSource;
  matte?: CanvasImageSource;
}

export interface DrawOptions {
  renderScale: number;
  smoothing: ImageSmoothingQuality;
  /** Same-size scratch context for isolating matted layers. Created lazily by the caller. */
  getScratch: () => Ctx2D;
}

export interface DrawStats {
  drawn: number;
  /** Layers skipped because no pixels were available (preview only — final renders throw before getting here). */
  skipped: string[];
}

const BLEND_TO_COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  add: "lighter",
};

export function compositeOperationFor(mode: BlendMode): GlobalCompositeOperation {
  return BLEND_TO_COMPOSITE[mode];
}

function setMatrix(ctx: Ctx2D, m: Matrix2D) {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}

export function drawResolvedFrame(ctx: Ctx2D, frame: ResolvedFrame, pixels: ReadonlyMap<string, LayerPixels>, opts: DrawOptions): DrawStats {
  const { renderScale } = opts;
  const targetW = ctx.canvas.width;
  const targetH = ctx.canvas.height;
  const base = scaleMatrix(renderScale);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, targetW, targetH);
  if (frame.background !== "transparent") {
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, targetW, targetH);
  }

  const stats: DrawStats = { drawn: 0, skipped: [] };
  for (const layer of frame.layers) {
    const px = pixels.get(layer.clipId) ?? {};
    if (layer.content.type === "media" && !px.image) {
      stats.skipped.push(layer.clipId);
      continue;
    }
    const m = multiply(base, layer.matrix);

    if (layer.matte) {
      if (!px.matte) {
        stats.skipped.push(layer.clipId);
        continue;
      }
      const scratch = opts.getScratch();
      scratch.setTransform(1, 0, 0, 1, 0, 0);
      scratch.globalAlpha = 1;
      scratch.globalCompositeOperation = "source-over";
      scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
      applySmoothing(scratch, opts.smoothing);
      setMatrix(scratch, m);
      drawLayerContent(scratch, layer, px.image, m);
      // destination-in keeps content only where the matte has alpha (subject); destination-out removes it there instead (keeps background). Drawn over the same cropped content rect, so it aligns pixel-for-pixel regardless of matte resolution.
      scratch.globalCompositeOperation = layer.matte.invert ? "destination-out" : "destination-in";
      drawMediaCropped(scratch, px.matte, layer);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = compositeOperationFor(layer.blendMode);
      ctx.drawImage(scratch.canvas, 0, 0);
    } else {
      setMatrix(ctx, m);
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = compositeOperationFor(layer.blendMode);
      applySmoothing(ctx, opts.smoothing);
      drawLayerContent(ctx, layer, px.image, m);
    }
    stats.drawn++;
  }
  ctx.restore();
  return stats;
}

function applySmoothing(ctx: Ctx2D, quality: ImageSmoothingQuality) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = quality;
}

/** Draws in content space (the layer matrix `m` is already set on ctx). */
function drawLayerContent(ctx: Ctx2D, layer: ResolvedLayer, image: CanvasImageSource | undefined, m: Matrix2D) {
  const content = layer.content;
  switch (content.type) {
    case "media":
      if (image) drawMediaCropped(ctx, image, layer);
      return;
    case "text":
      withClip(ctx, layer.crop, () => drawText(ctx, layer, m));
      return;
    case "shape":
      withClip(ctx, layer.crop, () => drawShape(ctx, content.shape));
      return;
  }
}

/**
 * Crop without a clip path: copy only the crop sub-rectangle of the source
 * into the same sub-rectangle of content space. Avoids clip-path edge
 * antialiasing artifacts and reads fewer texels. The source rect is mapped
 * through the image's REAL size, so a downscaled proxy frame or a matte at a
 * different resolution than the source still lines up exactly.
 */
function drawMediaCropped(ctx: Ctx2D, image: CanvasImageSource, layer: ResolvedLayer) {
  const { width: iw, height: ih } = imageSourceSize(image);
  if (!(iw > 0 && ih > 0)) return;
  const kx = iw / layer.width;
  const ky = ih / layer.height;
  const c = layer.crop;
  ctx.drawImage(image, c.x * kx, c.y * ky, c.width * kx, c.height * ky, c.x, c.y, c.width, c.height);
}

function withClip(ctx: Ctx2D, rect: Rect, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  draw();
  ctx.restore();
}

type Ctx2DLS = Ctx2D & { letterSpacing?: string };

/**
 * Draws one run of text starting at (x, baseline) with left alignment. Letter
 * spacing uses the native `letterSpacing` property where available, otherwise
 * per-grapheme advances (same widths text-layout measured with).
 */
function drawRun(ctx: Ctx2D, text: string, x: number, y: number, letterSpacing: number, mode: "fill" | "stroke") {
  const paint = (t: string, px: number) => (mode === "fill" ? ctx.fillText(t, px, y) : ctx.strokeText(t, px, y));
  if (!letterSpacing) return paint(text, x);
  const c = ctx as Ctx2DLS;
  if (supportsLetterSpacing(ctx)) {
    c.letterSpacing = `${letterSpacing}px`;
    paint(text, x);
    c.letterSpacing = "0px";
    return;
  }
  let cx = x;
  for (const g of graphemes(text)) {
    paint(g, cx);
    cx += ctx.measureText(g).width + letterSpacing;
  }
}

/** Same convention as the layout measurer: spacing between glyphs, none after the last. */
function runWidth(ctx: Ctx2D, text: string, letterSpacing: number): number {
  if (!letterSpacing) return ctx.measureText(text).width;
  const g = graphemes(text);
  if (g.length === 0) return 0;
  if (supportsLetterSpacing(ctx)) {
    const c = ctx as Ctx2DLS;
    c.letterSpacing = `${letterSpacing}px`;
    const w = ctx.measureText(text).width - letterSpacing;
    c.letterSpacing = "0px";
    return w;
  }
  return g.reduce((s, ch) => s + ctx.measureText(ch).width, 0) + letterSpacing * Math.max(0, g.length - 1);
}

/** Draws every line once in `mode`; justified lines get their word gaps stretched to the content width. */
function drawLines(ctx: Ctx2D, layer: ResolvedLayer, mode: "fill" | "stroke") {
  if (layer.content.type !== "text") return;
  const { layout, style } = layer.content;
  layout.lines.forEach((line, i) => {
    if (!line.text) return;
    const y = lineBaseline(layout, i);
    const words = line.text.split(" ");
    if (style.textAlign === "justify" && !line.paragraphEnd && words.length > 1) {
      const widths = words.map((w) => runWidth(ctx, w, style.letterSpacing));
      const gap = (layout.contentWidth - widths.reduce((a, b) => a + b, 0)) / (words.length - 1);
      let x = style.padding;
      words.forEach((w, k) => {
        drawRun(ctx, w, x, y, style.letterSpacing, mode);
        x += widths[k] + gap;
      });
      return;
    }
    drawRun(ctx, line.text, lineX(layout, style, line), y, style.letterSpacing, mode);
  });
}

/**
 * Canvas shadow* properties are NOT transformed by the current matrix (they
 * live in raw canvas pixels). Map the layer-space offset through the full
 * render matrix and scale blur by its average scale, so the shadow rotates and
 * scales with the text — and is proportionally identical in a half-resolution
 * preview and the full-resolution export.
 */
function applyShadow(ctx: Ctx2D, style: TextStyle, m: Matrix2D) {
  ctx.shadowColor = style.shadowColor;
  ctx.shadowOffsetX = m.a * style.shadowOffsetX + m.c * style.shadowOffsetY;
  ctx.shadowOffsetY = m.b * style.shadowOffsetX + m.d * style.shadowOffsetY;
  ctx.shadowBlur = style.shadowBlur * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function clearShadow(ctx: Ctx2D) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * Text, in content space (layer matrix already set; `m` is that full matrix,
 * needed only for shadow mapping). Order: background box -> (shadow) stroke ->
 * fill. Exactly one pass casts the shadow, so stroke + fill never double it.
 */
function drawText(ctx: Ctx2D, layer: ResolvedLayer, m: Matrix2D) {
  if (layer.content.type !== "text") return;
  const { layout, style } = layer.content;

  if (style.background && style.backgroundOpacity > 0) {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * style.backgroundOpacity;
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    const r = Math.min(style.borderRadius, layout.width / 2, layout.height / 2);
    if (r > 0) ctx.roundRect(0, 0, layout.width, layout.height, r);
    else ctx.rect(0, 0, layout.width, layout.height);
    ctx.fill();
    ctx.globalAlpha = prevAlpha;
  }

  ctx.font = cssFont(style);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const stroke = style.stroke && style.strokeWidth > 0;
  if (style.shadow) applyShadow(ctx, style, m);
  if (stroke) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = style.strokeColor;
    // Stroke is centered on the outline; 2x width with the fill on top leaves exactly strokeWidth visible OUTSIDE the glyph.
    ctx.lineWidth = style.strokeWidth * 2;
    drawLines(ctx, layer, "stroke");
    clearShadow(ctx);
  }
  ctx.fillStyle = style.color;
  drawLines(ctx, layer, "fill");
  clearShadow(ctx);
}

function drawShape(ctx: Ctx2D, shape: ShapeSpec) {
  // Inset by half the stroke so the whole stroke sits inside the shape's box (otherwise its outer half is clipped by the crop rect).
  const inset = shape.stroke ? shape.strokeWidth / 2 : 0;
  const w = Math.max(0, shape.width - inset * 2);
  const h = Math.max(0, shape.height - inset * 2);
  ctx.beginPath();
  if (shape.type === "ellipse") {
    ctx.ellipse(shape.width / 2, shape.height / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape.cornerRadius > 0) {
    ctx.roundRect(inset, inset, w, h, Math.min(shape.cornerRadius, w / 2, h / 2));
  } else {
    ctx.rect(inset, inset, w, h);
  }
  if (shape.fill) {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  if (shape.stroke && shape.strokeWidth > 0) {
    ctx.strokeStyle = shape.stroke;
    ctx.lineWidth = shape.strokeWidth;
    ctx.stroke();
  }
}
