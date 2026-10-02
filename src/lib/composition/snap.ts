import type { Guide } from "../timeline/model";
import type { Point, Rect } from "./matrix";

/**
 * 2D SNAPPING — pure. Targets are infinite lines (x = c or y = c) collected
 * from the composition (edges + center), safe-zone edges, ruler guides, and
 * other layers' visible bounds (edges + centers). A moving rect snaps any of
 * its own left/center/right (top/middle/bottom) features to the nearest
 * target per axis, independently, within a threshold. The threshold is in
 * COMPOSITION px and is derived by the caller from a screen-px tolerance
 * (tolerance / zoom), so snapping feels the same at every zoom level.
 *
 * Snapping only shapes the gesture's input; the stored values are plain
 * numbers like any other edit (nothing records "snapped to X").
 */

export type SnapSource = "canvas" | "safe" | "guide" | "layer";

export interface SnapLine {
  axis: "x" | "y";
  position: number;
  source: SnapSource;
  /** For layer targets: the span of the target layer along the other axis, so the drawn indicator can join the two objects. */
  span?: [number, number];
}

export interface SnapTargets {
  x: SnapLine[];
  y: SnapLine[];
}

export interface SnapTargetInput {
  composition: { width: number; height: number };
  guides?: readonly Guide[];
  safeRects?: readonly Rect[];
  /** Visible bounds of every OTHER layer (exclude the one being moved). */
  layerBounds?: readonly Rect[];
}

export function buildSnapTargets(input: SnapTargetInput): SnapTargets {
  const { width: W, height: H } = input.composition;
  const x: SnapLine[] = [0, W / 2, W].map((position) => ({ axis: "x" as const, position, source: "canvas" as const }));
  const y: SnapLine[] = [0, H / 2, H].map((position) => ({ axis: "y" as const, position, source: "canvas" as const }));
  for (const g of input.guides ?? []) (g.axis === "x" ? x : y).push({ axis: g.axis, position: g.position, source: "guide" });
  for (const r of input.safeRects ?? []) {
    x.push({ axis: "x", position: r.x, source: "safe" }, { axis: "x", position: r.x + r.width, source: "safe" });
    y.push({ axis: "y", position: r.y, source: "safe" }, { axis: "y", position: r.y + r.height, source: "safe" });
  }
  for (const r of input.layerBounds ?? []) {
    const ySpan: [number, number] = [r.y, r.y + r.height];
    const xSpan: [number, number] = [r.x, r.x + r.width];
    for (const position of [r.x, r.x + r.width / 2, r.x + r.width]) x.push({ axis: "x", position, source: "layer", span: ySpan });
    for (const position of [r.y, r.y + r.height / 2, r.y + r.height]) y.push({ axis: "y", position, source: "layer", span: xSpan });
  }
  return { x, y };
}

/** Priority when two targets are equally close: an explicit guide beats the canvas, which beats a safe zone, which beats another layer. */
const SOURCE_RANK: Record<SnapSource, number> = { guide: 0, canvas: 1, safe: 2, layer: 3 };

interface AxisSnap {
  delta: number;
  lines: SnapLine[];
}

function snapAxis(features: number[], lines: SnapLine[], threshold: number): AxisSnap | null {
  if (!(threshold > 0) || features.some((f) => !Number.isFinite(f))) return null;
  let best: { delta: number; dist: number; rank: number } | null = null;
  for (const f of features) {
    for (const l of lines) {
      const delta = l.position - f;
      const dist = Math.abs(delta);
      if (dist > threshold) continue;
      const rank = SOURCE_RANK[l.source];
      if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) <= 1e-9 && rank < best.rank)) best = { delta, dist, rank };
    }
  }
  if (!best) return null;
  // Report every line the snapped features now sit exactly on (e.g. left edge on a guide AND center on canvas center).
  const snapped = features.map((f) => f + best!.delta);
  const hit = lines.filter((l) => snapped.some((f) => Math.abs(l.position - f) < 1e-6));
  return { delta: best.delta, lines: hit };
}

export interface SnapResult {
  dx: number;
  dy: number;
  lines: SnapLine[];
}

/** Snap a rect (e.g. a moving layer's visible bounds) by its edges and center. Returns the extra offset to apply. */
export function snapRect(rect: Rect, targets: SnapTargets, threshold: number): SnapResult {
  const sx = snapAxis([rect.x, rect.x + rect.width / 2, rect.x + rect.width], targets.x, threshold);
  const sy = snapAxis([rect.y, rect.y + rect.height / 2, rect.y + rect.height], targets.y, threshold);
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, lines: [...(sx?.lines ?? []), ...(sy?.lines ?? [])] };
}

/** Snap one coordinate on one axis (e.g. a guide being dragged). */
export function snapValue(axis: "x" | "y", value: number, targets: SnapTargets, threshold: number): { value: number; lines: SnapLine[] } {
  const s = snapAxis([value], axis === "x" ? targets.x : targets.y, threshold);
  return { value: value + (s?.delta ?? 0), lines: s?.lines ?? [] };
}

/** Snap a single point (a resize handle, the anchor) to target lines. */
export function snapPoint(p: Point, targets: SnapTargets, threshold: number): { point: Point; lines: SnapLine[] } {
  const sx = snapAxis([p.x], targets.x, threshold);
  const sy = snapAxis([p.y], targets.y, threshold);
  return { point: { x: p.x + (sx?.delta ?? 0), y: p.y + (sy?.delta ?? 0) }, lines: [...(sx?.lines ?? []), ...(sy?.lines ?? [])] };
}

/** Rotation snapping: magnetic pull to the nearest multiple of `step` within `threshold` degrees. */
export function snapAngle(deg: number, step = 90, threshold = 3): number {
  const nearest = Math.round(deg / step) * step;
  return Math.abs(nearest - deg) <= threshold ? nearest : deg;
}
