import type { Point } from "../composition/matrix";
import type { MaskMode } from "./model";

/**
 * MASK RASTERIZER (MASK_COMPOSITING_ARCHITECTURE.md §4). Pure JS, no canvas —
 * so preview and final render produce the same coverage for the same inputs,
 * and every edge/feather/expansion/combination rule is unit-tested in Node
 * with exact pixel values.
 *
 * Only used when a mask actually NEEDS a raster (feather, expansion, partial
 * opacity, several masks, or inversion of a path that may self-intersect).
 * A single crisp mask is drawn by the canvas clip fast path instead (draw.ts)
 * and never touches this module.
 *
 *  1. Scanline coverage — exact horizontal span coverage x 5 vertical
 *     sub-scanlines, NONZERO winding (the same fill rule as canvas clip()).
 *  2. Expansion/feather — a SUB-PIXEL signed distance field: an exact
 *     Euclidean nearest-feature transform (Felzenszwalb & Huttenlocher) to
 *     the antialiased edge pixels, each carrying its own offset from the
 *     true edge (signedDistanceField), then a profile:
 *     expansion moves the edge (round joins, exact for any shape), feather is
 *     a smoothstep ramp of that width centered on the moved edge.
 *  3. Inversion, opacity, then combination into the running result:
 *     add = union (a + c - ac), subtract = a(1 - c), intersect = ac,
 *     difference = |a - c|. A stack whose FIRST mask subtracts or intersects
 *     starts from a full layer (After Effects behavior), otherwise from empty.
 */

export interface RasterMask {
  /** Closed polygon, render-space pixels. */
  polygon: readonly Point[];
  mode: MaskMode;
  inverted: boolean;
  /** Render px. */
  feather: number;
  /** Render px (+ grows, - shrinks). */
  expansion: number;
  opacity: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SUBSAMPLES = 5;
/** Below 1/2048 of a pixel = numerically empty (well under one 8-bit alpha step). */
const COVERAGE_EPSILON = 1 / 2048;

/**
 * Anti-aliased coverage (0..1) of a polygon over `region`, nonzero winding.
 * Exact horizontally (fractional span ends), SUBSAMPLES rows vertically.
 */
export function polygonCoverage(polygon: readonly Point[], region: Region): Float32Array {
  const { x: rx, y: ry, width: w, height: h } = region;
  const out = new Float32Array(w * h);
  const n = polygon.length;
  if (n < 3 || w <= 0 || h <= 0) return out;
  // Edges in region-local coordinates, skipping horizontal ones (they never cross a scanline).
  const ex0: number[] = [];
  const ey0: number[] = [];
  const ex1: number[] = [];
  const ey1: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    if (!Number.isFinite(a.x + a.y + b.x + b.y)) return out;
    if (a.y === b.y) continue;
    ex0.push(a.x - rx);
    ey0.push(a.y - ry);
    ex1.push(b.x - rx);
    ey1.push(b.y - ry);
    minY = Math.min(minY, a.y - ry, b.y - ry);
    maxY = Math.max(maxY, a.y - ry, b.y - ry);
  }
  const rowStart = Math.max(0, Math.floor(minY));
  const rowEnd = Math.min(h, Math.ceil(maxY));
  const wS = 1 / SUBSAMPLES;
  const cell = new Float32Array(w + 1); // partial-pixel coverage
  const diff = new Float32Array(w + 2); // full-pixel runs (difference array)
  const xs: number[] = [];
  const dirs: number[] = [];
  const order: number[] = [];
  for (let row = rowStart; row < rowEnd; row++) {
    cell.fill(0);
    diff.fill(0);
    let any = false;
    for (let s = 0; s < SUBSAMPLES; s++) {
      const sy = row + (s + 0.5) * wS;
      xs.length = 0;
      dirs.length = 0;
      for (let e = 0; e < ex0.length; e++) {
        const y0 = ey0[e];
        const y1 = ey1[e];
        // Half-open [min, max) so a vertex shared by two edges is counted exactly once.
        if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
          xs.push(ex0[e] + ((sy - y0) / (y1 - y0)) * (ex1[e] - ex0[e]));
          dirs.push(y1 > y0 ? 1 : -1);
        }
      }
      if (xs.length < 2) continue;
      order.length = xs.length;
      for (let k = 0; k < xs.length; k++) order[k] = k;
      order.sort((p, q) => xs[p] - xs[q]);
      let winding = 0;
      for (let k = 0; k < order.length - 1; k++) {
        winding += dirs[order[k]];
        if (winding === 0) continue;
        const xa = Math.max(0, Math.min(w, xs[order[k]]));
        const xb = Math.max(0, Math.min(w, xs[order[k + 1]]));
        if (xb <= xa) continue;
        any = true;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        if (ia === ib) {
          cell[ia] += (xb - xa) * wS;
        } else {
          cell[ia] += (ia + 1 - xa) * wS;
          diff[ia + 1] += wS;
          diff[ib] -= wS;
          if (ib < w) cell[ib] += (xb - ib) * wS;
        }
      }
    }
    if (!any) continue;
    let run = 0;
    const base = row * w;
    for (let x = 0; x < w; x++) {
      run += diff[x];
      const v = run + cell[x];
      // Snap float drift (the running sum leaves ~1e-8 residues far from any edge): an almost-empty or almost-full
      // pixel must read as exactly 0/1, or the distance field would mistake it for an edge.
      out[base + x] = v > 1 - COVERAGE_EPSILON ? 1 : v < COVERAGE_EPSILON ? 0 : v;
    }
  }
  return out;
}

const INF = 1e20;

/**
 * 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) over f[offset + k*stride], in place, also
 * carrying WHICH feature each position's minimum came from (src -> idx), so the 2-D pass can return nearest features.
 */
function edt1d(f: Float64Array, src: Int32Array, offset: number, stride: number, n: number, d: Float64Array, v: Int32Array, z: Float64Array, idx: Int32Array) {
  // f uses a large FINITE "infinity" (so arithmetic stays finite); the envelope bounds z use real infinities, which
  // guarantees the inner loop stops at k = 0.
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[offset + q * stride] + q * q;
    let s = (fq - (f[offset + v[k] * stride] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (fq - (f[offset + v[k] * stride] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[offset + v[k] * stride];
    idx[q] = src[offset + v[k] * stride];
  }
  for (let q = 0; q < n; q++) {
    f[offset + q * stride] = d[q];
    src[offset + q * stride] = idx[q];
  }
}

/** For every pixel: squared distance to, and linear index of, the nearest pixel where `feature[i]` is 1 (INF / -1 when there is none). */
export function nearestFeatureTransform(feature: Uint8Array, w: number, h: number): { d2: Float64Array; nearest: Int32Array } {
  const f = new Float64Array(w * h);
  const src = new Int32Array(w * h);
  for (let i = 0; i < f.length; i++) {
    f[i] = feature[i] ? 0 : INF;
    src[i] = feature[i] ? i : -1;
  }
  const len = Math.max(w, h);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 2);
  const idx = new Int32Array(len);
  for (let x = 0; x < w; x++) edt1d(f, src, x, w, h, d, v, z, idx);
  for (let y = 0; y < h; y++) edt1d(f, src, y * w, 1, w, d, v, z, idx);
  return { d2: f, nearest: src };
}

/** Squared distance from every pixel to the nearest pixel where `feature[i]` is 1 (INF when there is none). */
export function squaredDistanceTransform(feature: Uint8Array, w: number, h: number): Float64Array {
  return nearestFeatureTransform(feature, w, h).d2;
}

/** Smooth edge profile: coverage for signed distance `sd` (px, negative inside) of an edge with `feather` px softness. */
export function edgeProfile(sd: number, feather: number): number {
  if (feather < 1) {
    const c = 0.5 - sd; // 1px antialiasing ramp
    return c <= 0 ? 0 : c >= 1 ? 1 : c;
  }
  const t = 0.5 - sd / feather;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Extra pixels around a region that can still influence it (an edge out there may be grown/feathered into view). */
export function influenceMargin(m: Pick<RasterMask, "feather" | "expansion">): number {
  return Math.ceil(Math.max(0, m.expansion) + Math.max(1, m.feather) / 2 + 2);
}

/**
 * Signed distance (px, + outside) from a pixel's center to a straight edge crossing it, given the pixel's coverage
 * and the edge normal — the exact inverse of box-filtered coverage (Gustavson & Strand, "Anti-aliased Euclidean
 * distance transform", 2011). Reduces to 0.5 - coverage for axis-aligned edges.
 */
export function coverageToEdgeDistance(c: number, nx: number, ny: number): number {
  let a = Math.abs(nx);
  let b = Math.abs(ny);
  if (a < b) [a, b] = [b, a];
  if (b < 1e-9) return 0.5 - c;
  const a1 = (0.5 * b) / a;
  if (c < a1) return 0.5 * (a + b) - Math.sqrt(2 * a * b * c);
  if (c < 1 - a1) return (0.5 - c) * a;
  return -0.5 * (a + b) + Math.sqrt(2 * a * b * (1 - c));
}

/**
 * Sub-pixel signed distance field from antialiased coverage (negative inside). Every EDGE PIXEL knows where the real
 * edge is near it:
 *  - a partially covered pixel: an edge LINE whose normal is the Sobel gradient of coverage and whose offset from
 *    the center is the exact inverse of box-filtered coverage (coverageToEdgeDistance);
 *  - a hard 0/1 boundary: the actual pixel side it shares with the opposite class (a unit segment — exact for
 *    pixel-aligned shapes, corners included).
 * Every other pixel finds its NEAREST edge pixel (exact Euclidean nearest-feature transform) and measures to the edge
 * geometry of it and its 8 neighbouring edge pixels — so a grown/feathered edge lands where the real edge is (within
 * ~0.12 px on straight edges at any angle, tested), not on the pixel grid.
 */
export function signedDistanceField(cov: Float32Array, w: number, h: number): Float32Array {
  const feature = new Uint8Array(w * h);
  // Edge geometry per feature: a segment E ± T (T = 0 for a point), in pixel-center coordinates.
  const ex = new Float32Array(w * h);
  const ey = new Float32Array(w * h);
  const tx = new Float32Array(w * h);
  const ty = new Float32Array(w * h);
  // Partial pixels: inward unit normal (0,0 = unknown -> distance to the edge point).
  const nxIn = new Float32Array(w * h);
  const nyIn = new Float32Array(w * h);
  let any = false;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : cov[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = cov[i];
      if (c > 0 && c < 1) {
        feature[i] = 1;
        any = true;
        // Edge normal from a Sobel 3x3 gradient of coverage (accurate orientation on antialiased slanted edges;
        // out-of-range neighbours read as this pixel). The gradient points INTO the shape.
        const v = (dx: number, dy: number) => {
          const a = at(x + dx, y + dy);
          return a < 0 ? c : a;
        };
        const gx = v(1, -1) + 2 * v(1, 0) + v(1, 1) - v(-1, -1) - 2 * v(-1, 0) - v(-1, 1);
        const gy = v(-1, 1) + 2 * v(0, 1) + v(1, 1) - v(-1, -1) - 2 * v(0, -1) - v(1, -1);
        const len = Math.hypot(gx, gy);
        ex[i] = x;
        ey[i] = y;
        if (len > 1e-6) {
          // How far the center is OUTSIDE the edge (negative = inside), from coverage and the edge's angle.
          const e = coverageToEdgeDistance(c, gx / len, gy / len);
          nxIn[i] = gx / len;
          nyIn[i] = gy / len;
          ex[i] = x + nxIn[i] * e;
          ey[i] = y + nyIn[i] * e;
        }
        continue;
      }
      // Hard edge: a full pixel touching an empty one (4-neighbourhood) — the shared side is the edge.
      const opposite = c >= 1 ? 0 : 1;
      let best = -1;
      const sides = [
        [x - 1, y, -1, 0],
        [x + 1, y, 1, 0],
        [x, y - 1, 0, -1],
        [x, y + 1, 0, 1],
      ] as const;
      for (let k = 0; k < 4; k++) if (at(sides[k][0], sides[k][1]) === opposite) best = k;
      if (best >= 0) {
        feature[i] = 1;
        any = true;
        const [, , nx, ny] = sides[best];
        ex[i] = x + nx * 0.5;
        ey[i] = y + ny * 0.5;
        tx[i] = ny * 0.5;
        ty[i] = nx * 0.5;
      }
    }
  }
  const out = new Float32Array(w * h);
  if (!any) {
    // No edge anywhere: all inside or all outside.
    out.fill(cov.length && cov[0] >= 0.5 ? -INF : INF);
    return out;
  }
  const { nearest } = nearestFeatureTransform(feature, w, h);
  // Distance from pixel center (px, py) to feature f's local edge piece.
  const edgeDistance = (f: number, px: number, py: number): number => {
    if (nxIn[f] !== 0 || nyIn[f] !== 0) {
      // Partial edge pixel: its edge LINE, over that pixel's span; past the span, the edge point itself.
      const dx = px - ex[f];
      const dy = py - ey[f];
      const along = Math.abs(dx * -nyIn[f] + dy * nxIn[f]);
      return along <= 0.75 ? Math.abs(dx * nxIn[f] + dy * nyIn[f]) : Math.hypot(dx, dy);
    }
    // Hard edge: the pixel side segment E ± T (or a point when T = 0).
    const ax = ex[f] - tx[f];
    const ay = ey[f] - ty[f];
    const sx = tx[f] * 2;
    const sy = ty[f] * 2;
    const ss = sx * sx + sy * sy;
    const t = ss > 0 ? Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / ss)) : 0;
    return Math.hypot(px - (ax + sx * t), py - (ay + sy * t));
  };
  for (let i = 0; i < out.length; i++) {
    const q = nearest[i];
    const px = i % w;
    const py = (i - px) / w;
    // The nearest edge pixel by CENTER isn't always the one whose edge piece is nearest: take the minimum over it and
    // its 8 neighbouring edge pixels (the local edge), which is exact for straight edges at any angle.
    const qx = q % w;
    const qy = (q - qx) / w;
    let dist = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = qy + oy;
      if (yy < 0 || yy >= h) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = qx + ox;
        if (xx < 0 || xx >= w) continue;
        const f = yy * w + xx;
        if (feature[f]) dist = Math.min(dist, edgeDistance(f, px, py));
      }
    }
    out[i] = cov[i] >= 0.5 ? -dist : dist;
  }
  return out;
}

/**
 * One mask's coverage over `region` (before inversion/opacity). Crisp masks are pure scanline coverage; feathered or
 * expanded ones go through the sub-pixel signed distance field, computed over the region grown by the influence
 * margin so edges just outside the region are still accounted for.
 */
export function shapeCoverage(m: Pick<RasterMask, "polygon" | "feather" | "expansion">, region: Region): Float32Array {
  if (m.feather <= 0 && m.expansion === 0) return polygonCoverage(m.polygon, region);
  const pad = influenceMargin(m) + Math.ceil(Math.max(0, -m.expansion));
  const big: Region = { x: region.x - pad, y: region.y - pad, width: region.width + pad * 2, height: region.height + pad * 2 };
  const cov = polygonCoverage(m.polygon, big);
  const sdf = signedDistanceField(cov, big.width, big.height);
  const out = new Float32Array(region.width * region.height);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      out[y * region.width + x] = edgeProfile(sdf[(y + pad) * big.width + (x + pad)] - m.expansion, m.feather);
    }
  }
  return out;
}

/** Initial value of the running result: a stack that starts by subtracting/intersecting carves from a FULL layer. */
export function stackStartsFull(masks: readonly Pick<RasterMask, "mode">[]): boolean {
  return masks.length > 0 && (masks[0].mode === "subtract" || masks[0].mode === "intersect");
}

export function combine(a: number, c: number, mode: MaskMode): number {
  switch (mode) {
    case "add":
      return a + c - a * c;
    case "subtract":
      return a * (1 - c);
    case "intersect":
      return a * c;
    case "difference":
      return Math.abs(a - c);
  }
}

/** The whole stack's coverage over `region`, 0..1 per pixel. */
export function rasterizeMasks(masks: readonly RasterMask[], region: Region): Float32Array {
  const size = region.width * region.height;
  const acc = new Float32Array(size);
  if (masks.length === 0) return acc.fill(1);
  if (stackStartsFull(masks)) acc.fill(1);
  for (const m of masks) {
    const cov = shapeCoverage(m, region);
    for (let i = 0; i < size; i++) {
      const c = (m.inverted ? 1 - cov[i] : cov[i]) * m.opacity;
      acc[i] = combine(acc[i], c, m.mode);
    }
  }
  return acc;
}

/**
 * Small LRU keyed by the exact inputs — a static mask on a playing video, or an unchanged mask while another layer is
 * edited, rasterizes once instead of every frame. Keys include the render-space polygon, so any change to the layer's
 * transform, the mask, or the render scale is a miss (never a stale hit).
 */
export class MaskRasterCache {
  private readonly entries = new Map<string, Float32Array>();
  constructor(private readonly capacity = 8) {}

  get(masks: readonly RasterMask[], region: Region): Float32Array {
    const key = cacheKey(masks, region);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const value = rasterizeMasks(masks, region);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}

function cacheKey(masks: readonly RasterMask[], r: Region): string {
  let k = `${r.x},${r.y},${r.width},${r.height}`;
  for (const m of masks) {
    k += `|${m.mode}${m.inverted ? "!" : ""}${m.feather.toFixed(3)},${m.expansion.toFixed(3)},${m.opacity.toFixed(4)}:`;
    for (const p of m.polygon) k += `${p.x.toFixed(2)},${p.y.toFixed(2)};`;
  }
  return k;
}
