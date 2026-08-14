// Shared by both the "Add text" and captions drawtext filters: turns a
// freely-dragged anchor point (x/y as a percent of the frame, from the
// preview's drag UI) into ffmpeg drawtext x/y expressions, clamped so the
// text box never runs off the edge of the frame.
const EDGE_MARGIN = 16;

export function positionExprs(xPercent: number, yPercent: number): { x: string; y: string } {
  const xFrac = (xPercent / 100).toFixed(4);
  const yFrac = (yPercent / 100).toFixed(4);
  return {
    x: `max(${EDGE_MARGIN}\\,min(w-text_w-${EDGE_MARGIN}\\,w*${xFrac}-text_w/2))`,
    y: `max(${EDGE_MARGIN}\\,min(h-text_h-${EDGE_MARGIN}\\,h*${yFrac}-text_h/2))`,
  };
}
