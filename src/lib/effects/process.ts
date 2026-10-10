import { getEffectDefinition, type EffectType } from "./registry";

/**
 * EFFECT KERNELS (EFFECTS_ENGINE_ARCHITECTURE.md §3). Pure CPU pixel
 * processing on a Float32 RGBA buffer, UNPREMULTIPLIED, values 0..1 —
 * portable, deterministic, and unit-testable with real pixel values.
 *
 * Effects run in list order. Spatial params are composition px, scaled by
 * `renderScale`, so a half-res preview looks like the full export. Spatial
 * filters (blur/sharpen/glow) work in PREMULTIPLIED space so transparent
 * edges never pick up dark fringes.
 */

export interface EvaluatedEffect {
  id: string;
  type: EffectType;
  params: Readonly<Record<string, number>>;
}

export interface EffectContext {
  width: number;
  height: number;
  renderScale: number;
  /** Absolute frame (grain is seeded by it, so scrubbing is stable). */
  frame: number;
  /** Region's top-left in render px — anchors noise to the composition, not the region. */
  originX: number;
  originY: number;
  /** The layer's own bounds inside the region (region px) — vignette is relative to the layer, not the canvas. */
  layerRect: { x: number; y: number; width: number; height: number };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function bytesToFloat(src: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 255;
  return out;
}

export function floatToBytes(src: Float32Array, out: Uint8ClampedArray): void {
  for (let i = 0; i < src.length; i++) out[i] = Math.round(clamp01(src[i]) * 255);
}

/** Total composition-px spill of an effect stack (how far processing must extend beyond the layer bounds). */
export function effectsSpill(effects: readonly EvaluatedEffect[]): number {
  let s = 0;
  for (const e of effects) s += getEffectDefinition(e.type)?.spill?.(e.params) ?? 0;
  return s;
}

// --- color -----------------------------------------------------------------

function perPixel(buf: Float32Array, fn: (r: number, g: number, b: number, i: number) => void) {
  for (let i = 0; i < buf.length; i += 4) if (buf[i + 3] > 0) fn(buf[i], buf[i + 1], buf[i + 2], i);
}

function setRgb(buf: Float32Array, i: number, r: number, g: number, b: number) {
  buf[i] = clamp01(r);
  buf[i + 1] = clamp01(g);
  buf[i + 2] = clamp01(b);
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

// sRGB <-> linear via LUTs (exposure runs per pixel per channel).
const LUT_N = 4096;
const TO_LIN = new Float32Array(LUT_N + 1);
const TO_SRGB = new Float32Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  const c = i / LUT_N;
  TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  TO_SRGB[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
const lut = (table: Float32Array, v: number) => table[Math.round(clamp01(v) * LUT_N)];

// --- spatial ---------------------------------------------------------------

/** Box sizes for 3 successive box blurs approximating a Gaussian of std-dev sigma (Kovesi). */
function boxesForGauss(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/**
 * One box pass along an axis over a 4-channel premultiplied buffer. O(pixels) for any radius.
 * Samples outside the region REPLICATE the edge pixel. Around a small layer the region's border is transparent spill
 * padding, so replication still reads "transparent"; where the region was clamped at the canvas edge (e.g. a
 * full-frame video), the border is real content, and replication continues it instead of fading the frame edge to
 * transparent.
 */
export function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  // PERFORMANCE_OPTIMIZATION_REPORT.md §3: every channel's running sum sees exactly the same additions in the same order
  // as the straightforward per-channel loop (kept as the reference in perf/kernels.test.ts), so the output is
  // bit-identical — only the memory walk changed: four channels per step, and the vertical pass runs row by row (one
  // accumulator per column) instead of striding down columns.
  const norm = 1 / (2 * r + 1);
  if (horizontal) {
    const last = w - 1;
    for (let line = 0; line < h; line++) {
      const base = line * w * 4;
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let k = -r; k <= r; k++) {
        const o = base + (k < 0 ? 0 : k > last ? last : k) * 4;
        a0 += src[o];
        a1 += src[o + 1];
        a2 += src[o + 2];
        a3 += src[o + 3];
      }
      for (let k = 0; k < w; k++) {
        const o = base + k * 4;
        dst[o] = a0 * norm;
        dst[o + 1] = a1 * norm;
        dst[o + 2] = a2 * norm;
        dst[o + 3] = a3 * norm;
        const kin = k + r + 1;
        const kout = k - r;
        const i = base + (kin > last ? last : kin) * 4;
        const j = base + (kout < 0 ? 0 : kout) * 4;
        a0 += src[i] - src[j];
        a1 += src[i + 1] - src[j + 1];
        a2 += src[i + 2] - src[j + 2];
        a3 += src[i + 3] - src[j + 3];
      }
    }
    return;
  }
  const row = w * 4;
  const last = h - 1;
  const acc = new Float64Array(row);
  for (let k = -r; k <= r; k++) {
    const o = (k < 0 ? 0 : k > last ? last : k) * row;
    for (let x = 0; x < row; x++) acc[x] += src[o + x];
  }
  for (let k = 0; k < h; k++) {
    const o = k * row;
    const kin = k + r + 1;
    const kout = k - r;
    const i = (kin > last ? last : kin) * row;
    const j = (kout < 0 ? 0 : kout) * row;
    for (let x = 0; x < row; x++) {
      dst[o + x] = acc[x] * norm;
      acc[x] += src[i + x] - src[j + x];
    }
  }
}

function premultiply(buf: Float32Array) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    buf[i] *= a;
    buf[i + 1] *= a;
    buf[i + 2] *= a;
  }
}

function unpremultiply(buf: Float32Array) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    if (a > 1e-6) {
      buf[i] = clamp01(buf[i] / a);
      buf[i + 1] = clamp01(buf[i + 1] / a);
      buf[i + 2] = clamp01(buf[i + 2] / a);
    } else buf[i] = buf[i + 1] = buf[i + 2] = 0;
  }
}

/** Gaussian-approximating blur of a PREMULTIPLIED buffer, sigma in render px. Returns a new buffer. */
export function blurPremultiplied(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  let a: Float32Array = src.slice();
  if (sigma < 0.3) return a;
  let b = new Float32Array(src.length);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) / 2;
    if (r < 1) continue;
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  return a;
}

/** Deterministic hash -> [-1, 1] (integer lattice + frame + seed). */
function noise(x: number, y: number, frame: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + frame * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h | 0;
}

// --- the kernels -----------------------------------------------------------

type Kernel = (buf: Float32Array, p: Readonly<Record<string, number>>, ctx: EffectContext, effectId: string) => Float32Array;

const KERNELS: Record<EffectType, Kernel> = {
  brightness: (buf, p) => (perPixel(buf, (r, g, b, i) => setRgb(buf, i, r + p.amount, g + p.amount, b + p.amount)), buf),
  contrast: (buf, p) => {
    const k = 1 + p.amount;
    perPixel(buf, (r, g, b, i) => setRgb(buf, i, (r - 0.5) * k + 0.5, (g - 0.5) * k + 0.5, (b - 0.5) * k + 0.5));
    return buf;
  },
  saturation: (buf, p) => {
    const s = 1 + p.amount;
    perPixel(buf, (r, g, b, i) => {
      const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
      setRgb(buf, i, y + (r - y) * s, y + (g - y) * s, y + (b - y) * s);
    });
    return buf;
  },
  exposure: (buf, p) => {
    const k = Math.pow(2, p.stops);
    perPixel(buf, (r, g, b, i) => setRgb(buf, i, lut(TO_SRGB, lut(TO_LIN, r) * k), lut(TO_SRGB, lut(TO_LIN, g) * k), lut(TO_SRGB, lut(TO_LIN, b) * k)));
    return buf;
  },
  temperature: (buf, p) => {
    // Positive = warmer (more red, less blue) — white-balance style gains.
    const kr = 1 + 0.25 * p.amount;
    const kb = 1 - 0.25 * p.amount;
    perPixel(buf, (r, g, b, i) => setRgb(buf, i, r * kr, g, b * kb));
    return buf;
  },
  tint: (buf, p) => {
    // Positive = magenta (less green), negative = green.
    const kg = 1 - 0.25 * p.amount;
    perPixel(buf, (r, g, b, i) => setRgb(buf, i, r, g * kg, b));
    return buf;
  },
  blur: (buf, p, ctx) => {
    const sigma = (p.radius * ctx.renderScale) / 2;
    if (sigma < 0.3) return buf;
    premultiply(buf);
    const out = blurPremultiplied(buf, ctx.width, ctx.height, sigma);
    unpremultiply(out);
    return out;
  },
  sharpen: (buf, p, ctx) => {
    const sigma = (p.radius * ctx.renderScale) / 2;
    if (p.amount <= 0 || sigma < 0.3) return buf;
    premultiply(buf);
    const blurred = blurPremultiplied(buf, ctx.width, ctx.height, sigma);
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      for (let c = 0; c < 3; c++) buf[i + c] = Math.min(a, Math.max(0, buf[i + c] + p.amount * (buf[i + c] - blurred[i + c])));
    }
    unpremultiply(buf);
    return buf;
  },
  vignette: (buf, p, ctx) => {
    const { x, y, width, height } = ctx.layerRect;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const hw = Math.max(1, width / 2);
    const hh = Math.max(1, height / 2);
    const inner = p.size * Math.SQRT2; // size=1 -> no darkening inside the corners
    const soft = Math.max(0.01, p.softness);
    for (let py = 0; py < ctx.height; py++) {
      for (let px = 0; px < ctx.width; px++) {
        const i = (py * ctx.width + px) * 4;
        if (buf[i + 3] <= 0) continue;
        const d = Math.hypot((px + 0.5 - cx) / hw, (py + 0.5 - cy) / hh);
        const t = clamp01((d - inner) / soft);
        const v = 1 - p.amount * t * t * (3 - 2 * t); // smoothstep falloff
        buf[i] *= v;
        buf[i + 1] *= v;
        buf[i + 2] *= v;
      }
    }
    return buf;
  },
  grain: (buf, p, ctx, id) => {
    const cell = Math.max(1e-3, p.size); // composition px
    const seed = seedOf(id);
    for (let py = 0; py < ctx.height; py++) {
      // Noise lattice anchored in COMPOSITION space -> same pattern at preview and export scale.
      const gy = Math.floor((ctx.originY + py + 0.5) / ctx.renderScale / cell);
      for (let px = 0; px < ctx.width; px++) {
        const i = (py * ctx.width + px) * 4;
        if (buf[i + 3] <= 0) continue;
        const gx = Math.floor((ctx.originX + px + 0.5) / ctx.renderScale / cell);
        const n = noise(gx, gy, ctx.frame, seed) * p.amount * 0.25;
        setRgb(buf, i, buf[i] + n, buf[i + 1] + n, buf[i + 2] + n);
      }
    }
    return buf;
  },
  glow: (buf, p, ctx) => {
    if (p.intensity <= 0) return buf;
    // Bright-pass (premultiplied), soft knee above the threshold.
    const bright = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      if (a <= 0) continue;
      const y = LUMA[0] * buf[i] + LUMA[1] * buf[i + 1] + LUMA[2] * buf[i + 2];
      const k = clamp01((y - p.threshold) / Math.max(0.05, 1 - p.threshold));
      if (k <= 0) continue;
      bright[i] = buf[i] * a * k;
      bright[i + 1] = buf[i + 1] * a * k;
      bright[i + 2] = buf[i + 2] * a * k;
      bright[i + 3] = a * k;
    }
    const halo = blurPremultiplied(bright, ctx.width, ctx.height, Math.max(0.3, (p.radius * ctx.renderScale) / 2));
    premultiply(buf);
    for (let i = 0; i < buf.length; i += 4) {
      // Screen-add the halo (premultiplied), extending alpha beyond the layer's edges.
      for (let c = 0; c < 4; c++) {
        const g = clamp01(halo[i + c] * p.intensity);
        buf[i + c] = buf[i + c] + g - buf[i + c] * g;
      }
    }
    unpremultiply(buf);
    return buf;
  },
  opacity: (buf, p) => {
    for (let i = 3; i < buf.length; i += 4) buf[i] *= clamp01(p.amount);
    return buf;
  },
};

/** Runs the stack in order. Returns the (possibly new) buffer. */
export function applyEffects(buf: Float32Array, effects: readonly EvaluatedEffect[], ctx: EffectContext): Float32Array {
  let out = buf;
  for (const e of effects) out = KERNELS[e.type](out, e.params, ctx, e.id);
  return out;
}
