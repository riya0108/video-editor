import type { PaintOp, TransitionPainter, TransitionSide } from "./registry";

/**
 * Pure-JS TransitionPainter over premultiplied Float32 RGBA buffers. Same
 * contract as the Canvas 2D painter (lib/composition/transition-painter.ts) —
 * it exists so every transition's pixel output can be verified with exact
 * values in Node, and as a reference/CPU fallback implementation.
 * Resampling (offset/scale) is nearest-neighbour.
 */
export interface SoftwareSurface {
  width: number;
  height: number;
  /** Premultiplied RGBA, 0..1. */
  data: Float32Array;
}

export function createSurface(width: number, height: number): SoftwareSurface {
  return { width, height, data: new Float32Array(width * height * 4) };
}

/** Surface filled with a solid, straight-alpha color (r,g,b,a in 0..1). */
export function solidSurface(width: number, height: number, r: number, g: number, b: number, a = 1): SoftwareSurface {
  const s = createSurface(width, height);
  for (let i = 0; i < s.data.length; i += 4) {
    s.data[i] = r * a;
    s.data[i + 1] = g * a;
    s.data[i + 2] = b * a;
    s.data[i + 3] = a;
  }
  return s;
}

export function parseHexColor(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] : [0, 0, 0];
}

export class SoftwarePainter implements TransitionPainter {
  readonly out: SoftwareSurface;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly from: SoftwareSurface | null,
    private readonly to: SoftwareSurface | null,
    readonly renderScale = 1,
  ) {
    this.out = createSurface(width, height);
  }

  get hasFrom() {
    return this.from !== null;
  }

  get hasTo() {
    return this.to !== null;
  }

  draw(side: TransitionSide, opts: { alpha?: number; offsetX?: number; offsetY?: number; scale?: number; originX?: number; originY?: number; op?: PaintOp } = {}): void {
    const src = side === "from" ? this.from : this.to;
    if (!src) return;
    const alpha = Math.min(1, Math.max(0, opts.alpha ?? 1));
    if (alpha <= 0) return;
    const s = opts.scale ?? 1;
    const ox = opts.originX ?? this.width / 2;
    const oy = opts.originY ?? this.height / 2;
    const dx = opts.offsetX ?? 0;
    const dy = opts.offsetY ?? 0;
    const op = opts.op ?? "over";
    const d = this.out.data;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // Inverse map destination pixel center -> source pixel.
        const sx = Math.floor((x + 0.5 - dx - ox) / s + ox);
        const sy = Math.floor((y + 0.5 - dy - oy) / s + oy);
        if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
        const si = (sy * src.width + sx) * 4;
        const di = (y * this.width + x) * 4;
        const sa = src.data[si + 3] * alpha;
        for (let c = 0; c < 4; c++) {
          const sc = src.data[si + c] * alpha;
          if (op === "add") d[di + c] = Math.min(1, d[di + c] + sc);
          else if (op === "under") d[di + c] = d[di + c] + sc * (1 - d[di + 3]);
          else d[di + c] = sc + d[di + c] * (1 - sa);
        }
      }
    }
  }

  fill(color: string, alpha: number, op: "over" | "atop" = "over"): void {
    const [r, g, b] = parseHexColor(color);
    const a = Math.min(1, Math.max(0, alpha));
    const d = this.out.data;
    for (let i = 0; i < d.length; i += 4) {
      const da = d[i + 3];
      if (op === "atop") {
        d[i] = r * a * da + d[i] * (1 - a);
        d[i + 1] = g * a * da + d[i + 1] * (1 - a);
        d[i + 2] = b * a * da + d[i + 2] * (1 - a);
      } else {
        d[i] = r * a + d[i] * (1 - a);
        d[i + 1] = g * a + d[i + 1] * (1 - a);
        d[i + 2] = b * a + d[i + 2] * (1 - a);
        d[i + 3] = a + da * (1 - a);
      }
    }
  }

  maskLinear(axis: "x" | "y", from: number, to: number): void {
    const d = this.out.data;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const t = (axis === "x" ? x : y) + 0.5;
        const m = rampAt(t, from, to);
        const i = (y * this.width + x) * 4;
        for (let c = 0; c < 4; c++) d[i + c] *= m;
      }
    }
  }

  mixPixels(fn: (from: Uint8ClampedArray | null, to: Uint8ClampedArray | null, out: Uint8ClampedArray, width: number, height: number) => void): void {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    fn(this.from && toBytes(this.from), this.to && toBytes(this.to), out, this.width, this.height);
    const d = this.out.data;
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3] / 255;
      d[i] = (out[i] / 255) * a;
      d[i + 1] = (out[i + 1] / 255) * a;
      d[i + 2] = (out[i + 2] / 255) * a;
      d[i + 3] = a;
    }
  }

  /** Straight-alpha RGBA (0..1) of one output pixel. */
  pixel(x: number, y: number): [number, number, number, number] {
    const i = (y * this.width + x) * 4;
    const d = this.out.data;
    const a = d[i + 3];
    return a > 0 ? [d[i] / a, d[i + 1] / a, d[i + 2] / a, a] : [0, 0, 0, 0];
  }
}

/** 1 at `from`, 0 at `to`, linear between; a hard step when from === to. Shared definition for both painters. */
export function rampAt(t: number, from: number, to: number): number {
  if (from === to) return t < from ? 1 : 0;
  return Math.min(1, Math.max(0, (t - to) / (from - to)));
}

function toBytes(s: SoftwareSurface): Uint8ClampedArray {
  const out = new Uint8ClampedArray(s.width * s.height * 4);
  for (let i = 0; i < s.data.length; i += 4) {
    const a = s.data[i + 3];
    out[i] = a > 0 ? (s.data[i] / a) * 255 : 0;
    out[i + 1] = a > 0 ? (s.data[i + 1] / a) * 255 : 0;
    out[i + 2] = a > 0 ? (s.data[i + 2] / a) * 255 : 0;
    out[i + 3] = a * 255;
  }
  return out;
}
