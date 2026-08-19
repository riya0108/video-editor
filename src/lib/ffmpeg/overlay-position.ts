export type Anchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export const ANCHORS: { id: Anchor; label: string }[] = [
  { id: "top-left", label: "↖" },
  { id: "top", label: "↑" },
  { id: "top-right", label: "↗" },
  { id: "left", label: "←" },
  { id: "center", label: "•" },
  { id: "right", label: "→" },
  { id: "bottom-left", label: "↙" },
  { id: "bottom", label: "↓" },
  { id: "bottom-right", label: "↘" },
];

const MARGIN = 24;

/** Builds ffmpeg overlay x/y position expressions, plus matching CSS flex alignment for the live preview. */
export function anchorExpr(anchor: Anchor): { x: string; y: string; justify: string; align: string } {
  const [v, h] = anchor.includes("-") ? anchor.split("-") : [anchor, anchor];
  const isTop = v === "top";
  const isBottom = v === "bottom";
  const isLeft = h === "left" || anchor === "left";
  const isRight = h === "right" || anchor === "right";

  const x = isLeft ? `${MARGIN}` : isRight ? `main_w-overlay_w-${MARGIN}` : "(main_w-overlay_w)/2";
  const y = isTop ? `${MARGIN}` : isBottom ? `main_h-overlay_h-${MARGIN}` : "(main_h-overlay_h)/2";
  const justify = isLeft ? "start" : isRight ? "end" : "center";
  const align = isTop ? "start" : isBottom ? "end" : "center";
  return { x, y, justify, align };
}

const FREE_EDGE_MARGIN = 4;

/** Turns a freely-dragged anchor point (x/y as a percent of the frame, center-anchored) into ffmpeg overlay x/y expressions, clamped so the overlay never runs off the edge of the frame. */
export function freeOverlayExprs(xPercent: number, yPercent: number): { x: string; y: string } {
  const xFrac = (xPercent / 100).toFixed(4);
  const yFrac = (yPercent / 100).toFixed(4);
  return {
    x: `max(${FREE_EDGE_MARGIN}\\,min(main_w-overlay_w-${FREE_EDGE_MARGIN}\\,main_w*${xFrac}-overlay_w/2))`,
    y: `max(${FREE_EDGE_MARGIN}\\,min(main_h-overlay_h-${FREE_EDGE_MARGIN}\\,main_h*${yFrac}-overlay_h/2))`,
  };
}
