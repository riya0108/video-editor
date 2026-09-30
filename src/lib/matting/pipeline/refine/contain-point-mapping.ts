/**
 * MANUAL MATTE REFINEMENT — maps a pointer event's screen coordinates to
 * image-space (buffer pixel) coordinates for a canvas rendered with CSS
 * `object-fit: contain`. Pulled out of RefineMattePanel.tsx as a pure,
 * DOM-construction-free function (only reads plain numeric properties off
 * `canvas`/`rect`, never calls into the DOM itself) so the letterbox-fit
 * math has real, fast unit coverage rather than only being verifiable live.
 *
 * PRODUCTION READINESS (H2): whenever the canvas's intrinsic (buffer)
 * aspect ratio doesn't match its CSS box's aspect ratio — which happens for
 * any portrait-oriented image/video in a normal-width desktop panel, since
 * the box here is capped by a `max-h` — `object-contain` letterboxes the
 * rendered content inside the box. `rect` (from `getBoundingClientRect()`)
 * describes the full box, not the visible content, so scaling pointer
 * coordinates directly against `rect` used to silently mispositions every
 * brush stroke on exactly those images. This function inverts that fit.
 */
export interface ContainBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export function mapPointIntoContainedCanvas(
  clientX: number,
  clientY: number,
  rect: ContainBox,
  canvas: CanvasSize,
): { x: number; y: number } {
  const canvasAspect = canvas.width / canvas.height;
  const boxAspect = rect.width / rect.height;

  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (canvasAspect > boxAspect) {
    // Content is wider (relative to its height) than the box — letterboxed top/bottom.
    contentHeight = rect.width / canvasAspect;
    offsetY = (rect.height - contentHeight) / 2;
  } else {
    // Content is taller (relative to its width) than the box — letterboxed left/right.
    contentWidth = rect.height * canvasAspect;
    offsetX = (rect.width - contentWidth) / 2;
  }

  const scaleX = canvas.width / contentWidth;
  const scaleY = canvas.height / contentHeight;
  const x = (clientX - rect.left - offsetX) * scaleX;
  const y = (clientY - rect.top - offsetY) * scaleY;
  return {
    x: Math.min(canvas.width, Math.max(0, x)),
    y: Math.min(canvas.height, Math.max(0, y)),
  };
}
