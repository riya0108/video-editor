import { applyToPoint, type Matrix2D, type Point } from "../composition/matrix";
import type { Mask } from "./model";

/**
 * MASK GEOMETRY (MASK_COMPOSITING_ARCHITECTURE.md §3). Every mask shape
 * becomes ONE closed polygon in the layer's CONTENT space (pixels), which the
 * renderer maps through layer matrix x render scale. One geometry function
 * feeds both the canvas clip fast path and the software rasterizer, so they
 * can never disagree about where an edge is.
 *
 * Curves (ellipse, rounded corners, freeform) are flattened adaptively:
 * `pxScale` is content px -> render px, so a mask drawn small in a preview
 * uses few segments and the same mask at export resolution uses more — the
 * chord error stays under ~0.25 render px either way.
 */

const MAX_CHORD_ERROR_PX = 0.25;

/** Segments needed to flatten an arc of `radiusPx` (render px) spanning `angle` radians within the chord error. */
function arcSegments(radiusPx: number, angle: number): number {
  if (!(radiusPx > MAX_CHORD_ERROR_PX)) return 1;
  const step = 2 * Math.acos(1 - MAX_CHORD_ERROR_PX / radiusPx);
  return Math.max(1, Math.min(256, Math.ceil(angle / step)));
}

/** Unit-box (0..1) outline of the shape, in box-local pixel offsets from the box center (w, h = box size in content px). */
function localOutline(mask: Mask, w: number, h: number, pxScale: number): Point[] {
  switch (mask.type) {
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      const n = Math.max(12, arcSegments(Math.max(rx, ry) * pxScale, 2 * Math.PI));
      return Array.from({ length: n }, (_, k) => {
        const a = (2 * Math.PI * k) / n;
        return { x: rx * Math.cos(a), y: ry * Math.sin(a) };
      });
    }
    case "rectangle": {
      const r = Math.min(mask.roundness * Math.min(w, h), w / 2, h / 2);
      const hx = w / 2;
      const hy = h / 2;
      if (!(r > 0)) {
        return [
          { x: -hx, y: -hy },
          { x: hx, y: -hy },
          { x: hx, y: hy },
          { x: -hx, y: hy },
        ];
      }
      const n = arcSegments(r * pxScale, Math.PI / 2);
      const out: Point[] = [];
      const corners = [
        { cx: hx - r, cy: -hy + r, a0: -Math.PI / 2 },
        { cx: hx - r, cy: hy - r, a0: 0 },
        { cx: -hx + r, cy: hy - r, a0: Math.PI / 2 },
        { cx: -hx + r, cy: -hy + r, a0: Math.PI },
      ];
      for (const c of corners) {
        for (let k = 0; k <= n; k++) {
          const a = c.a0 + (Math.PI / 2) * (k / n);
          out.push({ x: c.cx + r * Math.cos(a), y: c.cy + r * Math.sin(a) });
        }
      }
      return out;
    }
    case "polygon":
      return (mask.points ?? []).map((p) => ({ x: (p.x - 0.5) * w, y: (p.y - 0.5) * h }));
    case "freeform": {
      // A smooth closed curve THROUGH the drawn points (centripetal-free uniform Catmull-Rom) — what distinguishes a
      // freeform stroke from a straight-edged polygon. Each segment is subdivided by its length in render px.
      const pts = (mask.points ?? []).map((p) => ({ x: (p.x - 0.5) * w, y: (p.y - 0.5) * h }));
      const n = pts.length;
      if (n < 3) return pts;
      const out: Point[] = [];
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = pts[(i + 2) % n];
        const segs = Math.max(1, Math.min(32, Math.ceil((Math.hypot(p2.x - p1.x, p2.y - p1.y) * pxScale) / 6)));
        for (let s = 0; s < segs; s++) {
          const t = s / segs;
          const t2 = t * t;
          const t3 = t2 * t;
          out.push({
            x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      return out;
    }
  }
}

/** The mask outline in the layer's content space (pixels), as a closed polygon. */
export function maskContentPolygon(mask: Mask, contentW: number, contentH: number, pxScale = 1): Point[] {
  const w = mask.width * contentW;
  const h = mask.height * contentH;
  const cx = mask.x * contentW;
  const cy = mask.y * contentH;
  const rad = (mask.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return localOutline(mask, w, h, pxScale).map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }));
}

/** Geometric mean of a matrix's axis scales — how many target px one content px spans (used for feather/expansion/curve density). */
export function matrixPixelScale(m: Matrix2D): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/** The mask outline in render space (content -> layer matrix x render scale = `m`). */
export function maskRenderPolygon(mask: Mask, contentW: number, contentH: number, m: Matrix2D): Point[] {
  return maskContentPolygon(mask, contentW, contentH, matrixPixelScale(m)).map((p) => applyToPoint(m, p));
}

/** The 4 corners of the mask's box in content space (for on-canvas handles), clockwise from top-left. */
export function maskBoxCorners(mask: Mask, contentW: number, contentH: number): Point[] {
  const box: Mask = { ...mask, type: "rectangle", roundness: 0 };
  return maskContentPolygon(box, contentW, contentH);
}

/** Mask path points (polygon/freeform vertices) in content space — the editable control points. */
export function maskControlPoints(mask: Mask, contentW: number, contentH: number): Point[] {
  if (!mask.points) return [];
  const asPolygon: Mask = { ...mask, type: "polygon" };
  return maskContentPolygon(asPolygon, contentW, contentH);
}

/** Inverse of maskControlPoints for one point: a content-space position -> normalized box coordinates (for vertex drags). */
export function contentToMaskBox(mask: Mask, contentW: number, contentH: number, p: Point): Point {
  const w = mask.width * contentW;
  const h = mask.height * contentH;
  const dx = p.x - mask.x * contentW;
  const dy = p.y - mask.y * contentH;
  const rad = (-mask.rotation * Math.PI) / 180;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { x: w > 0 ? lx / w + 0.5 : 0.5, y: h > 0 ? ly / h + 0.5 : 0.5 };
}

/** Even-odd agnostic point-in-polygon by NONZERO winding — the rule both render paths fill with. */
export function pointInPolygon(poly: readonly Point[], p: Point): boolean {
  let winding = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) winding++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) winding--;
  }
  return winding !== 0;
}
