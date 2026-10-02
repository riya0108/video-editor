import { applyVisualPatch, type ClipVisual } from "../timeline/visual";
import type { ShapeSpec, SvgSpec } from "../timeline/shape-style";
import { normalizeShapeSpec, normalizeSvgSpec } from "../timeline/shape-style";
import type { ClipEdit } from "../timeline/operations";
import { boxToComp, isCornerHandle, resizeFromHandle, type BoxSize, type HandleId } from "../composition/transform-tools";
import type { Point } from "../composition/matrix";

/**
 * GRAPHIC-AWARE RESIZE (GRAPHICS_ENGINE_ARCHITECTURE.md §3). Same pattern as
 * text (lib/text/text-transform.ts): reuse the generic Phase 5 handle math,
 * but apply the result to the graphic's OWN width/height instead of the
 * transform scale — so a resized rectangle keeps its stroke width, corner
 * radius and arrowheads at their authored size (nothing gets stretched), and
 * an SVG is re-rasterized sharp at its new size.
 *
 * Corners keep aspect by default (Shift frees) like every other layer;
 * line/arrow ignore vertical resizing (their thickness is the stroke). The
 * position is re-solved so the opposite edge/corner (or the anchor, with
 * fromAnchor) stays exactly where it was.
 */

const HANDLE_UV: Record<HandleId, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};
const OPPOSITE: Record<HandleId, HandleId> = { nw: "se", n: "s", ne: "sw", e: "w", se: "nw", s: "n", sw: "ne", w: "e" };

export type GraphicSpec = { kind: "shape"; shape: ShapeSpec } | { kind: "svg"; svg: SvgSpec };

export interface GraphicResizeInput {
  graphic: GraphicSpec;
  visual: ClipVisual;
  box: BoxSize;
  handle: HandleId;
  pointer: Point;
  /** Shift held: corners free the aspect (corners keep it by default). */
  freeAspect: boolean;
  fromAnchor: boolean;
}

export interface GraphicResizeResult {
  edit: ClipEdit;
  box: BoxSize;
  visual: ClipVisual;
}

export function graphicResize(input: GraphicResizeInput): GraphicResizeResult {
  const { visual, box, handle, graphic } = input;
  const isLine = graphic.kind === "shape" && (graphic.shape.type === "line" || graphic.shape.type === "arrow");
  const keepAspect = isLine ? false : isCornerHandle(handle) !== input.freeAspect;
  const generic = resizeFromHandle(visual, box, handle, input.pointer, { keepAspect, fromAnchor: input.fromAnchor });
  const rx = generic.transform.scaleX / visual.transform.scaleX;
  const ry = isLine ? 1 : generic.transform.scaleY / visual.transform.scaleY;
  const width = Math.max(1, box.width * rx);
  const height = Math.max(1, box.height * ry);

  let edit: ClipEdit;
  let nextBox: BoxSize;
  if (graphic.kind === "shape") {
    const shape = normalizeShapeSpec({ ...graphic.shape, width, height });
    nextBox = { width: shape.width, height: shape.height };
    edit = { content: { shape: { width: shape.width, height: shape.height } } };
  } else {
    const svg = normalizeSvgSpec({ ...graphic.svg, width, height }) ?? graphic.svg;
    nextBox = { width: svg.width, height: svg.height };
    edit = { content: { svg: { width: svg.width, height: svg.height } } };
  }

  const [pu, pv] = input.fromAnchor ? [visual.transform.anchorX, visual.transform.anchorY] : HANDLE_UV[OPPOSITE[handle]];
  const before = boxToComp(visual, box, { x: pu * box.width, y: pv * box.height });
  const unshifted = boxToComp(visual, nextBox, { x: pu * nextBox.width, y: pv * nextBox.height });
  const nextVisual = applyVisualPatch(visual, { transform: { x: visual.transform.x + (before.x - unshifted.x), y: visual.transform.y + (before.y - unshifted.y) } });
  edit.visual = { transform: { x: nextVisual.transform.x, y: nextVisual.transform.y } };
  return { edit, box: nextBox, visual: nextVisual };
}
