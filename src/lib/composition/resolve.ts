import { clipTimelineEnd, isTrimmableContent, type Clip, type ClipKind } from "../timeline/clip";
import { allTracks, type TimelineModel } from "../timeline/model";
import { normalizeShapeSpec, normalizeSvgSpec, type SvgSpec } from "../timeline/shape-style";
import { defaultClipVisual, normalizeTextStyle, type BlendMode, type ClipVisual, type FitMode, type ShapeSpec, type TextStyle } from "../timeline/visual";
import { compose, rectsIntersect, rotateDegrees, scale, transformedBounds, translate, type Matrix2D, type Rect } from "./matrix";
import { layoutText, type TextLayout, type TextMeasurer } from "./text-layout";

/**
 * SCENE RESOLUTION — turns (timeline, frame) into a flat, ordered list of
 * fully-computed layers: which source frame, what matrix, what crop, what
 * opacity/blend/matte. Pure and deterministic; no canvas, no media.
 *
 * This is the ONE place layout is decided. Both the preview renderer and the
 * final renderer draw a ResolvedFrame, so they cannot disagree about where
 * anything is — preview only differs in resolution, sampling quality and
 * frame-exactness, never in geometry. See COMPOSITION_ARCHITECTURE.md §4.
 */

/** Intrinsic pixel size of a sourced asset (video frame / image), as decoded. */
export interface SourceInfo {
  width: number;
  height: number;
}

export interface ResolveContext {
  getSourceInfo(sourceId: string): SourceInfo | undefined;
  measurer: TextMeasurer;
  /**
   * Transient visual overrides keyed by clip id — e.g. a layer mid-drag in the
   * preview, so the gesture renders live without pushing an undo entry per
   * pointermove. Never used by the final renderer.
   */
  visualOverrides?: Readonly<Record<string, ClipVisual>>;
}

export type LayerContent =
  | { type: "media"; sourceId: string; sourceFrame: number; still: boolean }
  | { type: "text"; layout: TextLayout; style: TextStyle }
  | { type: "shape"; shape: ShapeSpec }
  /** Embedded SVG: rasterized by the renderer at the exact pixel size it's drawn at (lib/composition/svg-raster.ts). */
  | { type: "svg"; svg: SvgSpec };

export interface ResolvedLayer {
  clipId: string;
  trackId: string;
  kind: ClipKind;
  content: LayerContent;
  /** Content-space size: source pixels for media, composition pixels for text/shapes. */
  width: number;
  height: number;
  /** The fitted box (composition px, before the user transform's scale) — width/height controls are box x scale. */
  box: { width: number; height: number };
  /** Maps content-space pixels -> composition pixels. */
  matrix: Matrix2D;
  /** Visible region, content-space pixels (crop applied). */
  crop: Rect;
  opacity: number;
  blendMode: BlendMode;
  matte?: { sourceId: string; sourceFrame: number; invert: boolean };
  /** Axis-aligned composition-pixel bounds of the visible (cropped) region. */
  bounds: Rect;
  visual: ClipVisual;
}

export interface ResolvedFrame {
  frame: number;
  width: number;
  height: number;
  background: string;
  /** Paint order: index 0 is drawn first (backmost). */
  layers: ResolvedLayer[];
  /** Sources referenced by an active clip whose size isn't known yet (still loading, or missing) — those layers are omitted. */
  missingSources: string[];
}

/** Size of the box a source is fitted to in the composition, before the user transform. */
export function fitBox(srcW: number, srcH: number, compW: number, compH: number, fit: FitMode): { width: number; height: number } {
  switch (fit) {
    case "none":
      return { width: srcW, height: srcH };
    case "fill":
      return { width: compW, height: compH };
    case "cover": {
      const k = Math.max(compW / srcW, compH / srcH);
      return { width: srcW * k, height: srcH * k };
    }
    case "contain":
    default: {
      const k = Math.min(compW / srcW, compH / srcH);
      return { width: srcW * k, height: srcH * k };
    }
  }
}

/**
 * content px -> composition px, read right to left:
 *   1. scale content to the fitted box
 *   2. move the anchor point to the origin
 *   3. scale (with flips)
 *   4. rotate about the anchor
 *   5. move the anchor to (x, y)
 */
export function layerMatrix(contentW: number, contentH: number, boxW: number, boxH: number, visual: ClipVisual): Matrix2D {
  const t = visual.transform;
  return compose(
    translate(t.x, t.y),
    rotateDegrees(t.rotation),
    scale(t.scaleX * (t.flipX ? -1 : 1), t.scaleY * (t.flipY ? -1 : 1)),
    translate(-t.anchorX * boxW, -t.anchorY * boxH),
    scale(boxW / contentW, boxH / contentH),
  );
}

export function cropRect(contentW: number, contentH: number, visual: ClipVisual): Rect {
  const c = visual.crop;
  return {
    x: c.left * contentW,
    y: c.top * contentH,
    width: contentW * (1 - c.left - c.right),
    height: contentH * (1 - c.top - c.bottom),
  };
}

export function isClipActiveAt(clip: Clip, frame: number): boolean {
  return frame >= clip.timelineStart && frame < clipTimelineEnd(clip);
}

export function effectiveVisual(timeline: TimelineModel, clip: Clip, overrides?: Readonly<Record<string, ClipVisual>>): ClipVisual {
  return overrides?.[clip.id] ?? clip.visual ?? defaultClipVisual(timeline.composition.width, timeline.composition.height);
}

export function resolveFrame(timeline: TimelineModel, frame: number, ctx: ResolveContext): ResolvedFrame {
  const { width: compW, height: compH, background } = timeline.composition;
  const compRect: Rect = { x: 0, y: 0, width: compW, height: compH };
  const layers: ResolvedLayer[] = [];
  const missing = new Set<string>();

  // trackIds[0] is frontmost (model.ts) -> paint back-to-front by walking the list in reverse.
  const tracks = allTracks(timeline).reverse();
  for (const track of tracks) {
    if (!track.visible || track.kind === "audio") continue;
    // A track holds non-overlapping clips, so at most one is active per track per frame.
    const clipId = track.clipIds.find((id) => {
      const c = timeline.clips[id];
      return c !== undefined && isClipActiveAt(c, frame);
    });
    if (!clipId) continue;
    const clip = timeline.clips[clipId];
    const layer = resolveClip(timeline, clip, frame, ctx, missing);
    if (!layer) continue;
    // Culling: invisible or fully off-canvas layers cost nothing downstream.
    if (layer.opacity <= 0 || !rectsIntersect(layer.bounds, compRect)) continue;
    layers.push(layer);
  }

  return { frame, width: compW, height: compH, background, layers, missingSources: [...missing] };
}

/**
 * Resolves one clip regardless of whether it's on screen at the playhead —
 * for property panels and numeric controls, which need a clip's box size
 * even when it's off-canvas, hidden, culled, or not active at the current
 * frame. Evaluated at `frame` clamped into the clip's span.
 */
export function resolveClipLayer(timeline: TimelineModel, clipId: string, frame: number, ctx: ResolveContext): ResolvedLayer | null {
  const clip = timeline.clips[clipId];
  if (!clip || clip.content.kind === "audio") return null;
  const f = Math.min(Math.max(frame, clip.timelineStart), clipTimelineEnd(clip) - 1);
  return resolveClip(timeline, clip, f, ctx, new Set());
}

/**
 * Clip content objects are immutable (every edit makes a new one), so a
 * layout can be cached against the content object itself: it's rebuilt only
 * when that clip's text/style actually changes, or when the measurer's
 * generation bumps (a web font finished loading) — not every frame.
 */
const shapeCache = new WeakMap<object, ShapeSpec>();
function cachedShape(raw: object): ShapeSpec {
  let s = shapeCache.get(raw);
  if (!s) shapeCache.set(raw, (s = normalizeShapeSpec(raw)));
  return s;
}

const layoutCache = new WeakMap<object, { measurer: TextMeasurer; generation: number; result: { layout: TextLayout; style: TextStyle } }>();

export function cachedTextLayout(content: { text?: string; textStyle?: unknown }, measurer: TextMeasurer): { layout: TextLayout; style: TextStyle } {
  const generation = measurer.generation ?? 0;
  const hit = layoutCache.get(content);
  if (hit && hit.measurer === measurer && hit.generation === generation) return hit.result;
  // Normalized defensively here too: a style from any source (old project, hand-edited file, a bug) renders with valid values instead of throwing mid-frame.
  const style = normalizeTextStyle(content.textStyle);
  const result = { layout: layoutText(content.text ?? "", style, measurer), style };
  layoutCache.set(content, { measurer, generation, result });
  return result;
}

function resolveClip(timeline: TimelineModel, clip: Clip, frame: number, ctx: ResolveContext, missing: Set<string>): ResolvedLayer | null {
  const visual = effectiveVisual(timeline, clip, ctx.visualOverrides);
  const { width: compW, height: compH } = timeline.composition;
  const c = clip.content;

  let content: LayerContent;
  let width: number;
  let height: number;
  let fit: FitMode = visual.fit;
  let sourceFrame = 0;

  if (isTrimmableContent(c)) {
    const info = ctx.getSourceInfo(c.source.sourceId);
    if (!info) {
      missing.add(c.source.sourceId);
      return null;
    }
    sourceFrame = c.sourceInFrame + (frame - clip.timelineStart);
    content = { type: "media", sourceId: c.source.sourceId, sourceFrame, still: false };
    ({ width, height } = info);
  } else if (c.kind === "text") {
    if (!c.text) return null;
    const { layout, style } = cachedTextLayout(c, ctx.measurer);
    content = { type: "text", layout, style };
    ({ width, height } = layout);
    fit = "none";
  } else if (c.kind === "graphic" && c.shape) {
    // Normalized defensively (old projects, hand-edited files): a bad shape renders with valid values instead of throwing mid-frame.
    const shape = cachedShape(c.shape);
    content = { type: "shape", shape };
    width = shape.width;
    height = shape.height;
    fit = "none";
  } else if (c.kind === "graphic" && c.svg) {
    const svg = normalizeSvgSpec(c.svg);
    if (!svg) return null;
    content = { type: "svg", svg };
    width = svg.width;
    height = svg.height;
    fit = "none";
  } else if (c.source) {
    const info = ctx.getSourceInfo(c.source.sourceId);
    if (!info) {
      missing.add(c.source.sourceId);
      return null;
    }
    content = { type: "media", sourceId: c.source.sourceId, sourceFrame: 0, still: true };
    ({ width, height } = info);
  } else {
    return null;
  }
  if (!(width > 0 && height > 0)) return null;

  let matte: ResolvedLayer["matte"];
  if (visual.matte) {
    if (!ctx.getSourceInfo(visual.matte.sourceId)) {
      // Drawing the layer unmatted would flash the removed background into the frame — omit it until the matte is known instead.
      missing.add(visual.matte.sourceId);
      return null;
    }
    matte = { sourceId: visual.matte.sourceId, sourceFrame, invert: visual.matte.invert };
  }

  const box = fitBox(width, height, compW, compH, fit);
  const matrix = layerMatrix(width, height, box.width, box.height, visual);
  const crop = cropRect(width, height, visual);
  return {
    clipId: clip.id,
    trackId: clip.trackId,
    kind: c.kind,
    content,
    width,
    height,
    box,
    matrix,
    crop,
    opacity: visual.opacity,
    blendMode: visual.blendMode,
    matte,
    bounds: transformedBounds(matrix, crop),
    visual,
  };
}
