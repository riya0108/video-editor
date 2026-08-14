export type TextPositionPreset = "top" | "center" | "bottom";

// Quick-set buttons for the common spots — text/captions aren't limited to
// these (drag them anywhere in the preview), but they're a fast way to snap
// back to a standard placement.
export const POSITION_PRESETS: Record<TextPositionPreset, { x: number; y: number }> = {
  top: { x: 50, y: 12 },
  center: { x: 50, y: 50 },
  bottom: { x: 50, y: 90 },
};

export function isAtPositionPreset(x: number, y: number, preset: TextPositionPreset): boolean {
  const p = POSITION_PRESETS[preset];
  return Math.abs(x - p.x) < 1 && Math.abs(y - p.y) < 1;
}
