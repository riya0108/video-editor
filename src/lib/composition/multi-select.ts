import { rectsIntersect, type Rect } from "./matrix";
import type { ResolvedFrame } from "./resolve";
import { alignDelta, type Alignment } from "./align";

/**
 * MULTI-SELECTION helpers — pure. A multi-selection is just a set of clip
 * ids (TimelineEngine's Selection); "group" geometry is derived on demand
 * from the members' visible bounds and never stored, so there's no group
 * object that could drift out of sync with its members.
 */

export function unionBounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Normalizes a drag rectangle given by two corners (any direction). */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Layers whose visible bounds touch the marquee, front-most first. */
export function marqueeHits(frame: ResolvedFrame, marquee: Rect): string[] {
  return frame.layers
    .filter((l) => rectsIntersect(l.bounds, marquee))
    .map((l) => l.clipId)
    .reverse();
}

/**
 * Align several layers. Target "selection" = the union of their bounds
 * (classic align-to-each-other: "align left" moves everyone to the left-most
 * edge); otherwise an explicit rect (canvas / safe zone). Returns per-clip
 * translations, omitting clips that don't need to move.
 */
export function alignMany(items: readonly { clipId: string; bounds: Rect }[], target: Rect | "selection", alignment: Alignment): Record<string, { dx: number; dy: number }> {
  const t = target === "selection" ? unionBounds(items.map((i) => i.bounds)) : target;
  const out: Record<string, { dx: number; dy: number }> = {};
  if (!t) return out;
  for (const i of items) {
    const d = alignDelta(i.bounds, t, alignment);
    if (d.dx !== 0 || d.dy !== 0) out[i.clipId] = d;
  }
  return out;
}
