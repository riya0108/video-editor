/**
 * 2D AFFINE MATRIX — the same [a b c d e f] layout Canvas 2D's
 * setTransform() takes, so a resolved layer matrix can be handed to the
 * renderer with no conversion:
 *
 *   | a c e |   x' = a*x + c*y + e
 *   | b d f |   y' = b*x + d*y + f
 *   | 0 0 1 |
 *
 * `multiply(m, n)` means "apply n first, then m" (standard column-vector
 * composition), so a layer matrix reads right-to-left in the order the
 * operations happen to a point.
 */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Readonly<Matrix2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function translate(tx: number, ty: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scale(sx: number, sy: number = sx): Matrix2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Clockwise in a y-down space (the canvas convention). */
export function rotateDegrees(degrees: number): Matrix2D {
  const r = (degrees * Math.PI) / 180;
  // Snap exact quarter turns so a 90°/180° rotation produces exact 0/±1 coefficients, not 6e-17 — keeps pixel-aligned layers pixel-aligned.
  const cos = snapUnit(Math.cos(r));
  const sin = snapUnit(Math.sin(r));
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function snapUnit(v: number): number {
  const EPS = 1e-12;
  if (Math.abs(v) < EPS) return 0;
  if (Math.abs(v - 1) < EPS) return 1;
  if (Math.abs(v + 1) < EPS) return -1;
  return v;
}

/** Returns m·n — apply `n` first, then `m`. */
export function multiply(m: Matrix2D, n: Matrix2D): Matrix2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** compose(A, B, C) = A·B·C — C is applied to a point first. */
export function compose(...matrices: Matrix2D[]): Matrix2D {
  return matrices.reduce((acc, m) => multiply(acc, m), { ...IDENTITY });
}

export function determinant(m: Matrix2D): number {
  return m.a * m.d - m.b * m.c;
}

/** Null for a singular matrix (zero-area layer) — callers treat that as "not hittable / not drawable", never divide by zero. */
export function invert(m: Matrix2D): Matrix2D | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function applyToPoint(m: Matrix2D, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** The 4 corners of `rect` mapped through `m`, in TL, TR, BR, BL order — the drawable quad of a rotated layer. */
export function transformRect(m: Matrix2D, rect: Rect): [Point, Point, Point, Point] {
  return [
    applyToPoint(m, { x: rect.x, y: rect.y }),
    applyToPoint(m, { x: rect.x + rect.width, y: rect.y }),
    applyToPoint(m, { x: rect.x + rect.width, y: rect.y + rect.height }),
    applyToPoint(m, { x: rect.x, y: rect.y + rect.height }),
  ];
}

/** Axis-aligned bounding box of `rect` after `m` — used for culling and dirty-region math. */
export function transformedBounds(m: Matrix2D, rect: Rect): Rect {
  const pts = transformRect(m, rect);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
}
