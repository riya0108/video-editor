import { clampZoom, pan, zoomAt, imageToScreen, screenToImage, type ViewportState } from "../matting/pipeline/refine/viewport";
import { applyToPoint, invert, rectContains, transformRect, type Point } from "./matrix";
import type { ResolvedFrame, ResolvedLayer } from "./resolve";

/**
 * COORDINATE SYSTEMS (see COMPOSITION_ARCHITECTURE.md §1):
 *
 *   content space      a layer's own pixels (source px, or comp px for text/shapes)
 *        | layer.matrix
 *   composition space  output pixels, origin top-left, y down — what ClipVisual is authored in
 *        | renderScale (preview: <= 1, final: exactly 1)
 *   render space       pixels of the canvas actually being rendered into
 *
 *   composition space
 *        | viewport (zoom, pan) — CSS pixels
 *   screen space       the preview element; x devicePixelRatio for its backing store
 *
 * The viewport is a pure display concern: it never changes what is rendered,
 * only where the rendered composition is presented. Zoom/pan math is reused
 * from the matte refinement viewport (same convention: screen = comp*zoom + pan).
 */

export type { ViewportState };
export { clampZoom, pan, zoomAt };

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
export const ZOOM_STEPS = [0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32] as const;

export interface Size {
  width: number;
  height: number;
}

export function compositionToScreen(p: Point, viewport: ViewportState): Point {
  return imageToScreen(p, viewport);
}

export function screenToComposition(p: Point, viewport: ViewportState): Point {
  return screenToImage(p, viewport);
}

/** Largest zoom that shows the whole composition inside `view` with `padding` CSS px on every side, centered. */
export function fitToScreen(comp: Size, view: Size, padding = 24): ViewportState {
  const availW = Math.max(1, view.width - padding * 2);
  const availH = Math.max(1, view.height - padding * 2);
  const zoom = clampZoom(Math.min(availW / comp.width, availH / comp.height), MIN_ZOOM, MAX_ZOOM);
  return { zoom, panX: (view.width - comp.width * zoom) / 2, panY: (view.height - comp.height * zoom) / 2 };
}

/** Centered at an exact zoom (e.g. "100%" = one composition pixel per CSS pixel). */
export function centerAtZoom(comp: Size, view: Size, zoom: number): ViewportState {
  const z = clampZoom(zoom, MIN_ZOOM, MAX_ZOOM);
  return { zoom: z, panX: (view.width - comp.width * z) / 2, panY: (view.height - comp.height * z) / 2 };
}

/** Next/previous preset zoom level, anchored at `anchor` (screen px). */
export function stepZoom(viewport: ViewportState, direction: 1 | -1, anchor: Point): ViewportState {
  const current = viewport.zoom;
  const next =
    direction > 0 ? ZOOM_STEPS.find((z) => z > current * 1.001) ?? MAX_ZOOM : [...ZOOM_STEPS].reverse().find((z) => z < current * 0.999) ?? MIN_ZOOM;
  return zoomAt(viewport, anchor, next, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Keeps at least `margin` CSS px of the composition on screen, so a fling
 * can't lose the canvas entirely (a real failure mode in the matte viewer —
 * see project memory: a stale viewport parked the image fully off-pane).
 */
export function constrainViewport(viewport: ViewportState, comp: Size, view: Size, margin = 48): ViewportState {
  const w = comp.width * viewport.zoom;
  const h = comp.height * viewport.zoom;
  const panX = Math.min(view.width - Math.min(margin, w), Math.max(Math.min(margin, w) - w, viewport.panX));
  const panY = Math.min(view.height - Math.min(margin, h), Math.max(Math.min(margin, h) - h, viewport.panY));
  return { ...viewport, panX, panY };
}

/** Topmost layer whose visible (cropped) region contains `compPoint`, or null. Exact for rotated/flipped/cropped layers — the test runs in each layer's own content space. */
export function hitTest(frame: ResolvedFrame, compPoint: Point): ResolvedLayer | null {
  for (let i = frame.layers.length - 1; i >= 0; i--) {
    const layer = frame.layers[i];
    // A clip shown past its own span by a transition (handle/held frame) isn't "there" to click.
    if (layer.transition?.outsideClip) continue;
    const inv = invert(layer.matrix);
    if (!inv) continue;
    if (rectContains(layer.crop, applyToPoint(inv, compPoint))) return layer;
  }
  return null;
}

/** Composition-space corners (TL, TR, BR, BL) of a layer's visible region — what the preview outlines for selection. */
export function layerQuad(layer: ResolvedLayer): [Point, Point, Point, Point] {
  return transformRect(layer.matrix, layer.crop);
}

/** Composition-space position of a layer's anchor point. */
export function layerAnchor(layer: ResolvedLayer): Point {
  return { x: layer.visual.transform.x, y: layer.visual.transform.y };
}
