import type { Rect } from "./matrix";

/**
 * ALIGNMENT — moves a layer so its VISIBLE bounds (crop and rotation
 * included) line up with a target rect: the composition, or a safe zone.
 * Returns a translation only; scale/rotation are untouched, so aligning is
 * a single, exactly reversible position edit.
 */
export type Alignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export const ALIGNMENTS: readonly Alignment[] = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

export function alignDelta(bounds: Rect, target: Rect, alignment: Alignment): { dx: number; dy: number } {
  switch (alignment) {
    case "left":
      return { dx: target.x - bounds.x, dy: 0 };
    case "hcenter":
      return { dx: target.x + target.width / 2 - (bounds.x + bounds.width / 2), dy: 0 };
    case "right":
      return { dx: target.x + target.width - (bounds.x + bounds.width), dy: 0 };
    case "top":
      return { dx: 0, dy: target.y - bounds.y };
    case "vcenter":
      return { dx: 0, dy: target.y + target.height / 2 - (bounds.y + bounds.height / 2) };
    case "bottom":
      return { dx: 0, dy: target.y + target.height - (bounds.y + bounds.height) };
  }
}
