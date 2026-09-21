// Shared by both the "Add text" and captions drawtext filters: turns a
// freely-dragged anchor point (x/y as a percent of the frame, from the
// preview's drag UI) into ffmpeg drawtext x/y expressions, clamped so the
// text box never runs off the edge of the frame.
const EDGE_MARGIN = 16;

/**
 * The video's own content rect within the current filter-graph frame, in
 * pixels — equal to the whole frame when no "resize for a platform" canvas
 * is applied, or the inner contain-fitted rect (excluding the
 * letterbox/pillarbox padding `applyResizeCanvas` adds) when it is. Anchor
 * percentages are always resolved against this rect rather than the raw
 * frame, so a burned-in element lands exactly where the live preview shows
 * it — the preview's own `box` (FramedVideoStage.tsx) is the same
 * contain-fit of the same pre-resize dimensions into the same target
 * canvas.
 */
export interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function positionExprs(xPercent: number, yPercent: number, box?: ContentBox): { x: string; y: string } {
  const xFrac = (xPercent / 100).toFixed(4);
  const yFrac = (yPercent / 100).toFixed(4);
  const boxX = box ? box.x.toFixed(2) : "0";
  const boxY = box ? box.y.toFixed(2) : "0";
  const boxW = box ? box.w.toFixed(2) : "w";
  const boxH = box ? box.h.toFixed(2) : "h";
  return {
    x: `max(${boxX}+${EDGE_MARGIN}\\,min(${boxX}+${boxW}-text_w-${EDGE_MARGIN}\\,${boxX}+${boxW}*${xFrac}-text_w/2))`,
    y: `max(${boxY}+${EDGE_MARGIN}\\,min(${boxY}+${boxH}-text_h-${EDGE_MARGIN}\\,${boxY}+${boxH}*${yFrac}-text_h/2))`,
  };
}
