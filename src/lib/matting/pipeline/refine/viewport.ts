/**
 * MANUAL MATTE REFINEMENT — Phase 6. Pure zoom/pan coordinate math for a
 * manual-refinement canvas. Deliberately has no DOM/canvas dependency — a
 * future canvas layer would call `imageToScreen`/`screenToImage` (e.g. to
 * turn a mouse event into an image-space brush point for
 * ManualRefinementEngine.applyStroke) and apply `zoom`/`panX`/`panY` as a
 * CSS/canvas transform; none of that rendering step is testable in a
 * headless suite, so it isn't implemented here — this module is the part
 * that is.
 */
export interface ViewportState {
  /** Scale factor — 1 = 100%. */
  zoom: number;
  /** Screen-space X offset: screenX = imageX * zoom + panX. */
  panX: number;
  /** Screen-space Y offset: screenY = imageY * zoom + panY. */
  panY: number;
}

export const DEFAULT_VIEWPORT_STATE: ViewportState = { zoom: 1, panX: 0, panY: 0 };

export interface ScreenPoint {
  x: number;
  y: number;
}
export interface ImagePoint {
  x: number;
  y: number;
}

export function imageToScreen(point: ImagePoint, viewport: ViewportState): ScreenPoint {
  return { x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY };
}

export function screenToImage(point: ScreenPoint, viewport: ViewportState): ImagePoint {
  return { x: (point.x - viewport.panX) / viewport.zoom, y: (point.y - viewport.panY) / viewport.zoom };
}

export function clampZoom(zoom: number, minZoom = 0.1, maxZoom = 32): number {
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

/**
 * Zooms to `newZoom` while keeping the image-space point currently under
 * `screenAnchor` fixed on screen — the standard "zoom toward the cursor"
 * behavior, rather than always zooming toward the canvas origin.
 */
export function zoomAt(viewport: ViewportState, screenAnchor: ScreenPoint, newZoom: number, minZoom = 0.1, maxZoom = 32): ViewportState {
  const zoom = clampZoom(newZoom, minZoom, maxZoom);
  const anchorInImage = screenToImage(screenAnchor, viewport);
  return {
    zoom,
    panX: screenAnchor.x - anchorInImage.x * zoom,
    panY: screenAnchor.y - anchorInImage.y * zoom,
  };
}

/** Pans by a screen-space delta (e.g. a drag's movementX/movementY). */
export function pan(viewport: ViewportState, dx: number, dy: number): ViewportState {
  return { ...viewport, panX: viewport.panX + dx, panY: viewport.panY + dy };
}
