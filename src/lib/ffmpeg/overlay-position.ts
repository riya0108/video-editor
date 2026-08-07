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
