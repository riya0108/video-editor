import type { BlendMode, ShapeSpec } from "../timeline/visual";
import { imageSourceSize } from "./frame-provider";
import { multiply, scale as scaleMatrix, type Matrix2D, type Rect } from "./matrix";
import type { ResolvedFrame, ResolvedLayer } from "./resolve";
import { cssFont, graphemes, lineBaseline, lineX, supportsLetterSpacing } from "./text-layout";
import type { ShadowFields } from "../timeline/shape-style";
import { svgRasterSize } from "../graphics/svg";
import { applyEffects, bytesToFloat, effectsSpill, floatToBytes } from "../effects/process";
import { getTransitionDefinition } from "../transitions/registry";
import { CanvasTransitionPainter } from "./transition-painter";
import { maskRenderPolygon, matrixPixelScale } from "../masks/geometry";
import { MaskRasterCache, type RasterMask, type Region } from "../masks/raster";
import type { Mask } from "../masks/model";
import { decontaminate } from "../matting/pipeline/decontaminate";

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
 *
 * MASKS (MASK_COMPOSITING_ARCHITECTURE.md §4): a single crisp mask is a canvas
 * clip path — the layer stays vector/text/video and is drawn straight into
 * the frame, no extra raster. Anything softer (feather, expansion, partial
 * opacity, several masks) takes the isolated path: content -> matte ->
 * mask coverage (lib/masks/raster.ts) -> effects -> opacity + blend.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LayerPixels {
  image?: CanvasImageSource;
  matte?: CanvasImageSource;
}

export interface DrawOptions {
  renderScale: number;
  smoothing: ImageSmoothingQuality;
  /**
   * Same-size scratch contexts, created lazily by the caller. Slot 0 isolates matted / effected / soft-masked layers;
   * transitions use slots 1 (outgoing side), 2 (incoming side) and 3 (the transition's mix); slot 4 holds mask coverage
   * and slot 5 a luma matte being converted. Each slot is a distinct canvas.
   *
   * `readback` (default true): whether anything will read the surface's pixels back (getImageData). Surfaces that are
   * only drawn into and composited are asked for with false, so the renderer can give them a GPU-backed canvas: drawing
   * a decoded video frame into a CPU (willReadFrequently) canvas costs a GPU→CPU copy per frame
   * (PERFORMANCE_OPTIMIZATION_REPORT.md §4). The same (slot, readback) pair is always the same canvas.
   */
  getScratch: (slot?: number, readback?: boolean) => Ctx2D;
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
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  add: "lighter",
};

/** Mask rasters are cached across frames and renderers by exact inputs (see MaskRasterCache). */
const maskCache = new MaskRasterCache(16);

export type MaskPlan = { kind: "none" } | { kind: "clip"; mask: Mask; inverted: boolean } | { kind: "raster" };

/**
 * How a layer's masks are applied. "clip" = one crisp, full-strength mask: drawn as a canvas clip path, no raster.
 * Inversion is only clipped for rectangles/ellipses (always simple shapes) — an inverted path that might
 * self-intersect goes through the rasterizer so its NONZERO fill is complemented exactly.
 */
export function maskPlanFor(layer: ResolvedLayer): MaskPlan {
  const masks = layer.masks;
  if (masks.length === 0) return { kind: "none" };
  if (masks.length === 1) {
    const m = masks[0];
    // A lone subtract = everything but the shape (stack starts full); intersect/difference with one mask = the shape.
    const inverted = m.inverted !== (m.mode === "subtract");
    if (m.feather === 0 && m.expansion === 0 && m.opacity >= 1 && (!inverted || m.type === "rectangle" || m.type === "ellipse")) return { kind: "clip", mask: m, inverted };
  }
  return { kind: "raster" };
}

/** Device-pixel raster size for an SVG layer drawn at `renderScale` (layer matrix x render scale, per axis). */
export function svgRasterSizeFor(layer: ResolvedLayer, renderScale: number, mode: "preview" | "final"): { width: number; height: number } {
  const fm = multiply(scaleMatrix(renderScale), layer.matrix);
  return svgRasterSize(layer.width, layer.height, Math.hypot(fm.a, fm.b), Math.hypot(fm.c, fm.d), mode);
}

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
  const layers = frame.layers;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.transition) {
      // Both sides of a pair are adjacent (from, then to) — consume them together.
      const partner = layer.transition.role === "from" && layers[i + 1]?.transition?.id === layer.transition.id ? layers[++i] : null;
      drawTransition(ctx, layer.transition.role === "from" ? layer : null, layer.transition.role === "to" ? layer : partner, pixels, opts, frame.frame, stats);
      continue;
    }
    const px = pixels.get(layer.clipId) ?? {};
    if (needsPixels(layer) && !px.image) {
      stats.skipped.push(layer.clipId);
      continue;
    }
    const m = multiply(base, layer.matrix);
    const plan = maskPlanFor(layer);

    if (layer.matte || layer.effects.length > 0 || plan.kind === "raster") {
      // ISOLATED-LAYER PATH: matte and/or effects. The layer is drawn alone on a scratch canvas, matted, processed by its
      // effect stack, and only then composited with opacity + blend — so neither the matte nor any effect can touch the
      // layers underneath. Same path for every layer kind (EFFECTS_ENGINE_ARCHITECTURE.md §1).
      if (layer.matte && !px.matte) {
        stats.skipped.push(layer.clipId);
        continue;
      }
      const scratch = opts.getScratch(0, readsBackIsolated(layer));
      renderLayerIsolated(scratch, layer, px, opts, frame.frame);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = compositeOperationFor(layer.blendMode);
      ctx.drawImage(scratch.canvas, 0, 0);
    } else {
      if (plan.kind === "clip") {
        ctx.save();
        clipToMask(ctx, layer, plan, m);
      }
      setMatrix(ctx, m);
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = compositeOperationFor(layer.blendMode);
      applySmoothing(ctx, opts.smoothing);
      drawLayerContent(ctx, layer, px.image, m);
      if (plan.kind === "clip") ctx.restore();
    }
    stats.drawn++;
  }
  ctx.restore();
  return stats;
}

/** Whether renderLayerIsolated reads the layer's own isolation surface back: effects and colour-decontaminated mattes do; mattes, luma mattes (converted on slot 5) and masks only draw and composite. */
export function readsBackIsolated(layer: ResolvedLayer): boolean {
  return layer.effects.length > 0 || (!!layer.matte && layer.matte.decontaminate && layer.matte.channel === "alpha" && !layer.matte.invert);
}

function needsPixels(layer: ResolvedLayer): boolean {
  return layer.content.type === "media" || layer.content.type === "svg";
}

function clearSurface(c: Ctx2D) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
}

/** Draws ONE layer alone onto a cleared, frame-sized surface: content -> matte -> masks -> effect stack (render-pixel space). Opacity/blend are left to the caller. */
function renderLayerIsolated(scratch: Ctx2D, layer: ResolvedLayer, px: LayerPixels, opts: DrawOptions, absFrame: number) {
  const m = multiply(scaleMatrix(opts.renderScale), layer.matrix);
  const plan = maskPlanFor(layer);
  clearSurface(scratch);
  applySmoothing(scratch, opts.smoothing);
  if (plan.kind === "clip") {
    scratch.save();
    clipToMask(scratch, layer, plan, m);
  }
  setMatrix(scratch, m);
  drawLayerContent(scratch, layer, px.image, m);
  if (plan.kind === "clip") scratch.restore();
  if (layer.matte && px.matte && layer.matte.decontaminate && layer.matte.channel === "alpha" && !layer.matte.invert) {
    applyDecontaminatedMatte(scratch, opts.getScratch(5), layer, px.matte, m, opts.renderScale);
  } else if (layer.matte && px.matte) {
    // destination-in keeps content only where the matte has alpha (subject); destination-out removes it there instead (keeps background). Drawn over the same cropped content rect, so it aligns pixel-for-pixel regardless of matte resolution.
    const matteImage = layer.matte.channel === "luma" ? lumaMatteSurface(opts.getScratch(5), layer, px.matte, m, opts.renderScale) : null;
    setMatrix(scratch, m);
    scratch.globalCompositeOperation = layer.matte.invert ? "destination-out" : "destination-in";
    if (matteImage) {
      scratch.setTransform(1, 0, 0, 1, 0, 0);
      scratch.drawImage(matteImage.canvas, 0, 0);
    } else drawMediaCropped(scratch, px.matte, layer);
  }
  if (plan.kind === "raster") applyRasterMasks(scratch, opts.getScratch(4), layer, m, opts.renderScale);
  if (layer.effects.length > 0) processLayerEffects(scratch, layer, opts.renderScale, absFrame);
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalAlpha = 1;
  scratch.globalCompositeOperation = "source-over";
}

/** Render-space polygon path of one mask on `ctx` (device transform reset first). */
function maskPath(ctx: Ctx2D, layer: ResolvedLayer, mask: Mask, m: Matrix2D) {
  const poly = maskRenderPolygon(mask, layer.width, layer.height, m);
  for (let i = 0; i < poly.length; i++) {
    if (i === 0) ctx.moveTo(poly[i].x, poly[i].y);
    else ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
}

/** FAST PATH: clips the context to the mask (or its complement) — the caller wraps it in save()/restore(). */
function clipToMask(ctx: Ctx2D, layer: ResolvedLayer, plan: Extract<MaskPlan, { kind: "clip" }>, m: Matrix2D) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  if (plan.inverted) {
    // Complement of a simple shape: the whole surface plus the shape, filled even-odd.
    ctx.rect(-1, -1, ctx.canvas.width + 2, ctx.canvas.height + 2);
    maskPath(ctx, layer, plan.mask, m);
    ctx.clip("evenodd");
  } else {
    maskPath(ctx, layer, plan.mask, m);
    ctx.clip("nonzero");
  }
}

/** Integer render-px region a layer can paint into: its bounds (plus content shadow/stroke spill), clamped to the surface. */
export function layerPaintRegion(layer: ResolvedLayer, renderScale: number, surfaceW: number, surfaceH: number): Region | null {
  const spill = Math.ceil(contentSpill(layer) * matrixPixelScale(layer.matrix) * renderScale) + 1;
  const b = layer.bounds;
  const x0 = Math.max(0, Math.floor(b.x * renderScale) - spill);
  const y0 = Math.max(0, Math.floor(b.y * renderScale) - spill);
  const x1 = Math.min(surfaceW, Math.ceil((b.x + b.width) * renderScale) + spill);
  const y1 = Math.min(surfaceH, Math.ceil((b.y + b.height) * renderScale) + spill);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** How far (content px) a layer's own drawing reaches past its box: shadows and text stroke. */
function contentSpill(layer: ResolvedLayer): number {
  const c = layer.content;
  const shadow = (s: ShadowFields & { shadow?: boolean }) => (s.shadow ? s.shadowBlur * 2 + Math.max(Math.abs(s.shadowOffsetX), Math.abs(s.shadowOffsetY)) : 0);
  if (c.type === "text") return shadow(c.style) + (c.style.stroke ? c.style.strokeWidth : 0);
  if (c.type === "shape") return shadow(c.shape);
  if (c.type === "svg") return shadow(c.svg as ShadowFields & { shadow?: boolean });
  return 0;
}

/** The layer's masks as rasterizer inputs: render-space polygons, feather/expansion scaled from layer px to render px. */
export function rasterMasksFor(layer: ResolvedLayer, m: Matrix2D): RasterMask[] {
  const k = matrixPixelScale(m);
  return layer.masks.map((mask) => ({
    polygon: maskRenderPolygon(mask, layer.width, layer.height, m),
    mode: mask.mode,
    inverted: mask.inverted,
    feather: mask.feather * k,
    expansion: mask.expansion * k,
    opacity: mask.opacity,
  }));
}

/** RASTER PATH: multiplies the isolated layer by the masks' coverage (destination-in through a coverage surface). */
function applyRasterMasks(scratch: Ctx2D, coverageSurface: Ctx2D, layer: ResolvedLayer, m: Matrix2D, renderScale: number) {
  const region = layerPaintRegion(layer, renderScale, scratch.canvas.width, scratch.canvas.height);
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalAlpha = 1;
  if (!region) {
    clearSurface(scratch);
    return;
  }
  const coverage = maskCache.get(rasterMasksFor(layer, m), region);
  clearSurface(coverageSurface);
  const img = coverageSurface.createImageData(region.width, region.height);
  const d = img.data;
  for (let i = 0; i < coverage.length; i++) d[i * 4 + 3] = Math.round(coverage[i] * 255);
  coverageSurface.putImageData(img, region.x, region.y);
  // destination-in also clears everything OUTSIDE the drawn region — correct: the layer paints nothing out there.
  scratch.globalCompositeOperation = "destination-in";
  scratch.drawImage(coverageSurface.canvas, region.x, region.y, region.width, region.height, region.x, region.y, region.width, region.height);
  scratch.globalCompositeOperation = "source-over";
}

/** LUMA MATTE: draws the matte at the layer's placement, then turns its luminance (x its own alpha) into alpha. */
function lumaMatteSurface(surface: Ctx2D, layer: ResolvedLayer, matte: CanvasImageSource, m: Matrix2D, renderScale: number): Ctx2D {
  clearSurface(surface);
  setMatrix(surface, m);
  drawMediaCropped(surface, matte, layer);
  surface.setTransform(1, 0, 0, 1, 0, 0);
  const region = layerPaintRegion(layer, renderScale, surface.canvas.width, surface.canvas.height);
  if (!region) return surface;
  const img = surface.getImageData(region.x, region.y, region.width, region.height);
  lumaToAlpha(img.data);
  surface.putImageData(img, region.x, region.y);
  return surface;
}

/**
 * DECONTAMINATED MATTE: the matte drawn at the layer's placement, then the matting engine's colour-decontamination
 * stage (lib/matting/pipeline/decontaminate.ts — reused, not reimplemented) unmixes the background color out of the
 * soft edge using THIS frame's real pixels, and the result replaces the layer region: decontaminated RGB, alpha =
 * content alpha x (consistency-checked) matte alpha. Equivalent to destination-in everywhere the edge is clean.
 */
function applyDecontaminatedMatte(scratch: Ctx2D, matteSurface: Ctx2D, layer: ResolvedLayer, matte: CanvasImageSource, m: Matrix2D, renderScale: number) {
  const region = layerPaintRegion(layer, renderScale, scratch.canvas.width, scratch.canvas.height);
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalAlpha = 1;
  scratch.globalCompositeOperation = "source-over";
  if (!region) return clearSurface(scratch);
  clearSurface(matteSurface);
  applySmoothing(matteSurface, "high");
  setMatrix(matteSurface, m);
  drawMediaCropped(matteSurface, matte, layer);
  matteSurface.setTransform(1, 0, 0, 1, 0, 0);
  const content = scratch.getImageData(region.x, region.y, region.width, region.height);
  const matteData = matteSurface.getImageData(region.x, region.y, region.width, region.height).data;
  decontaminatedMatteInPlace(content.data, matteData, region.width, region.height);
  // Everything outside the region is outside the layer: clear it, as destination-in would.
  clearSurface(scratch);
  scratch.putImageData(content, region.x, region.y);
}

/** Pure core of the decontaminated matte (Node-tested): `content` (unpremultiplied RGBA, unmatted) is rewritten in place. */
export function decontaminatedMatteInPlace(content: Uint8ClampedArray, matte: Uint8ClampedArray, width: number, height: number): { pixelsDecontaminated: number; pixelsSuppressed: number } {
  const n = width * height;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = matte[i * 4 + 3] / 255;
  const r = decontaminate(content, alpha, width, height);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    content[o] = r.rgba[o];
    content[o + 1] = r.rgba[o + 1];
    content[o + 2] = r.rgba[o + 2];
    content[o + 3] = Math.round(content[o + 3] * r.alpha[i]);
  }
  return { pixelsDecontaminated: r.pixelsDecontaminated, pixelsSuppressed: r.pixelsSuppressed };
}

/** In place over unpremultiplied RGBA bytes: alpha = Rec. 709 luma x alpha (white = keep), RGB cleared. */
export function lumaToAlpha(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i + 3] = Math.round((luma * d[i + 3]) / 255);
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
}

/**
 * TRANSITION PATH (TRANSITIONS_ARCHITECTURE.md §4). Each side is rendered in isolation exactly as it would be on its
 * own (matte, effects, and its opacity baked in), then the transition's registered compositor mixes the two through a
 * TransitionPainter, and the mix is composited at the track's z-position. Nothing here is specific to any transition
 * type — an unknown type falls back to a cut. A side with no pixels yet (preview still decoding) counts as skipped
 * and is treated as absent rather than drawn wrong.
 */
function drawTransition(ctx: Ctx2D, from: ResolvedLayer | null, to: ResolvedLayer | null, pixels: ReadonlyMap<string, LayerPixels>, opts: DrawOptions, absFrame: number, stats: DrawStats) {
  const info = (from ?? to)!.transition!;
  const side = (layer: ResolvedLayer | null, slot: number): Ctx2D | null => {
    if (!layer) return null;
    const px = pixels.get(layer.clipId) ?? {};
    if ((needsPixels(layer) && !px.image) || (layer.matte && !px.matte)) {
      stats.skipped.push(layer.clipId);
      return null;
    }
    // mixPixels-based transitions read the sides back too — correct on either kind of canvas, so that isn't predicted here.
    const surface = opts.getScratch(slot, readsBackIsolated(layer));
    renderLayerIsolated(surface, layer, px, opts, absFrame);
    if (layer.opacity < 1) {
      // Bake the layer's own opacity into its surface (exact: scales every premultiplied channel).
      surface.globalCompositeOperation = "destination-in";
      surface.fillStyle = `rgba(0,0,0,${layer.opacity})`;
      surface.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
      surface.globalCompositeOperation = "source-over";
    }
    stats.drawn++;
    return surface;
  };
  const a = side(from, 1);
  const b = side(to, 2);
  if (!a && !b) return;

  const mix = opts.getScratch(3, false);
  clearSurface(mix);
  applySmoothing(mix, opts.smoothing);
  const painter = new CanvasTransitionPainter(mix, a, b, opts.renderScale);
  const def = getTransitionDefinition(info.type);
  if (def) def.render(painter, { progress: info.progress, params: info.params, direction: info.direction, paired: info.paired, seed: info.seed });
  else painter.draw(info.progress < 0.5 ? "from" : "to");

  // Blend modes apply to the mix as a whole; when the two sides disagree the result composites normally.
  const blend = from && to ? (from.blendMode === to.blendMode ? from.blendMode : "normal") : (from ?? to)!.blendMode;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = compositeOperationFor(blend);
  ctx.drawImage(mix.canvas, 0, 0);
}

/**
 * Runs a layer's effect stack over its region of the scratch canvas: the layer's render-space bounds, expanded by the
 * stack's spill (blur/glow/sharpen radius) and clamped to the canvas. Small layers stay cheap.
 */
function processLayerEffects(scratch: Ctx2D, layer: ResolvedLayer, renderScale: number, absFrame: number) {
  const spill = Math.ceil(effectsSpill(layer.effects) * renderScale) + 1;
  const b = layer.bounds;
  const x0 = Math.max(0, Math.floor(b.x * renderScale) - spill);
  const y0 = Math.max(0, Math.floor(b.y * renderScale) - spill);
  const x1 = Math.min(scratch.canvas.width, Math.ceil((b.x + b.width) * renderScale) + spill);
  const y1 = Math.min(scratch.canvas.height, Math.ceil((b.y + b.height) * renderScale) + spill);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  const img = scratch.getImageData(x0, y0, w, h);
  const out = applyEffects(bytesToFloat(img.data), layer.effects, {
    width: w,
    height: h,
    renderScale,
    frame: absFrame,
    originX: x0,
    originY: y0,
    layerRect: { x: b.x * renderScale - x0, y: b.y * renderScale - y0, width: b.width * renderScale, height: b.height * renderScale },
  });
  floatToBytes(out, img.data);
  scratch.putImageData(img, x0, y0);
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
      withClip(ctx, layer.crop, () => drawShape(ctx, content.shape, m));
      return;
    case "svg":
      if (!image) return;
      if (content.svg.shadow) applyShadow(ctx, content.svg, m);
      drawMediaCropped(ctx, image, layer);
      clearShadow(ctx);
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
function applyShadow(ctx: Ctx2D, style: ShadowFields, m: Matrix2D) {
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

/** Regular polygon inscribed in the box's ellipse, first vertex at the top. */
function polygonPath(ctx: Ctx2D, w: number, h: number, inset: number, sides: number) {
  const rx = Math.max(0, w / 2 - inset);
  const ry = Math.max(0, h / 2 - inset);
  for (let k = 0; k < sides; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / sides;
    const x = w / 2 + rx * Math.cos(a);
    const y = h / 2 + ry * Math.sin(a);
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Filled arrowhead triangle with its tip at (tipX, y), pointing in `dir` (+1 right, -1 left). */
function arrowHeadPath(ctx: Ctx2D, tipX: number, y: number, dir: 1 | -1, length: number, width: number) {
  ctx.moveTo(tipX, y);
  ctx.lineTo(tipX - dir * length, y - width / 2);
  ctx.lineTo(tipX - dir * length, y + width / 2);
  ctx.closePath();
}

/**
 * Vector shapes in content space (layer matrix already set; `m` is that full
 * matrix, for shadow mapping). Closed shapes keep their stroke INSIDE the box
 * (inset by half the stroke) so it's never clipped. Line/arrow run along the
 * box's center line; the shaft stops at each arrowhead's base so head and
 * shaft never overlap (no double shadow). Exactly one pass casts the shadow.
 */
function drawShape(ctx: Ctx2D, shape: ShapeSpec, m: Matrix2D) {
  const { width: w, height: h } = shape;
  const sw = shape.stroke ? shape.strokeWidth : 0;
  if (shape.shadow) applyShadow(ctx, shape, m);

  if (shape.type === "line" || shape.type === "arrow") {
    if (sw <= 0) return clearShadow(ctx);
    const y = h / 2;
    const headLen = shape.type === "arrow" ? Math.min(shape.headSize, w / 2) : 0;
    const startHead = shape.type === "arrow" && (shape.arrowHead === "start" || shape.arrowHead === "both");
    const endHead = shape.type === "arrow" && (shape.arrowHead === "end" || shape.arrowHead === "both");
    ctx.lineCap = "butt";
    ctx.lineWidth = sw;
    ctx.strokeStyle = shape.strokeColor;
    ctx.beginPath();
    ctx.moveTo(startHead ? headLen : 0, y);
    ctx.lineTo(endHead ? w - headLen : w, y);
    ctx.stroke();
    if (startHead || endHead) {
      ctx.fillStyle = shape.strokeColor;
      ctx.beginPath();
      if (endHead) arrowHeadPath(ctx, w, y, 1, headLen, shape.headSize);
      if (startHead) arrowHeadPath(ctx, 0, y, -1, headLen, shape.headSize);
      ctx.fill();
    }
    return clearShadow(ctx);
  }

  const inset = sw / 2;
  ctx.beginPath();
  if (shape.type === "ellipse") {
    ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2 - inset), Math.max(0, h / 2 - inset), 0, 0, Math.PI * 2);
  } else if (shape.type === "polygon") {
    polygonPath(ctx, w, h, inset, shape.sides);
  } else {
    const rw = Math.max(0, w - inset * 2);
    const rh = Math.max(0, h - inset * 2);
    const r = Math.min(shape.cornerRadius, rw / 2, rh / 2);
    if (r > 0) ctx.roundRect(inset, inset, rw, rh, r);
    else ctx.rect(inset, inset, rw, rh);
  }
  if (shape.fill) {
    ctx.fillStyle = shape.fillColor;
    ctx.fill();
    clearShadow(ctx); // the fill cast it; the stroke must not cast a second one
  }
  if (sw > 0) {
    ctx.strokeStyle = shape.strokeColor;
    ctx.lineWidth = sw;
    ctx.lineJoin = "miter";
    ctx.stroke();
  }
  clearShadow(ctx);
}
