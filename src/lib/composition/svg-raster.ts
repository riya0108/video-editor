import { svgAtSize } from "../graphics/svg";
import type { SvgSpec } from "../timeline/shape-style";
import { createCanvas, get2d, type AnyCanvas } from "./canvas";

/**
 * SVG RASTERIZER (GRAPHICS_ENGINE_ARCHITECTURE.md §2). Turns an embedded SVG
 * into a bitmap AT THE PIXEL SIZE IT WILL BE DRAWN, so vector graphics stay
 * sharp at any zoom/scale — never "rasterize once at intrinsic size, then
 * scale the bitmap".
 *
 *  - peek(): preview. Synchronous: returns the exact size if cached, else the
 *    closest cached size (so the layer never blinks out), and schedules the
 *    exact size; listeners fire when it's ready so the preview redraws.
 *  - get(): final. Awaits the exact size. Rejects if the SVG can't decode.
 *
 * Decoding goes through <img>, where SVG can't execute script or load external
 * resources. Bounded LRU so long sessions don't accumulate bitmaps.
 */
type Entry = { canvas: AnyCanvas; width: number; height: number; lastUsed: number };

const MAX_ENTRIES = 64;

export class SvgRasterizer {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<AnyCanvas>>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private tick = 0;

  onReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private keyOf(spec: SvgSpec, w: number, h: number): string {
    return `${w}x${h}|${spec.tint ? spec.tintColor : "-"}|${spec.markup}`;
  }

  private baseKey(spec: SvgSpec): string {
    return `|${spec.tint ? spec.tintColor : "-"}|${spec.markup}`;
  }

  peek(spec: SvgSpec, w: number, h: number): CanvasImageSource | null {
    const key = this.keyOf(spec, w, h);
    const hit = this.cache.get(key);
    if (hit) {
      hit.lastUsed = ++this.tick;
      return hit.canvas;
    }
    if (!this.failed.has(key)) void this.get(spec, w, h).then(() => this.listeners.forEach((l) => l()), () => this.listeners.forEach((l) => l()));
    // Nearest available size of the same graphic, so zooming shows the previous raster until the sharp one lands.
    const base = this.baseKey(spec);
    let best: Entry | null = null;
    for (const [k, e] of this.cache) if (k.endsWith(base) && (!best || Math.abs(e.width - w) < Math.abs(best.width - w))) best = e;
    return best?.canvas ?? null;
  }

  get(spec: SvgSpec, w: number, h: number): Promise<AnyCanvas> {
    const key = this.keyOf(spec, w, h);
    const hit = this.cache.get(key);
    if (hit) {
      hit.lastUsed = ++this.tick;
      return Promise.resolve(hit.canvas);
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = this.rasterize(spec, w, h)
      .then((canvas) => {
        this.cache.set(key, { canvas, width: w, height: h, lastUsed: ++this.tick });
        this.evict();
        return canvas;
      })
      .catch((e) => {
        this.failed.add(key);
        throw e;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private evict() {
    if (this.cache.size <= MAX_ENTRIES) return;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, this.cache.size - MAX_ENTRIES);
    for (const [k] of oldest) this.cache.delete(k);
  }

  private async rasterize(spec: SvgSpec, w: number, h: number): Promise<AnyCanvas> {
    const markup = svgAtSize(spec.markup, w, h, { width: spec.intrinsicWidth, height: spec.intrinsicHeight });
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode().catch(() => {
        throw new Error("This SVG couldn't be rendered by the browser.");
      });
      const canvas = createCanvas(w, h);
      const ctx = get2d(canvas);
      ctx.drawImage(img, 0, 0, w, h);
      if (spec.tint) {
        // Recolor: keep the SVG's alpha, replace its color.
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = spec.tintColor;
        ctx.fillRect(0, 0, w, h);
      }
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** One per page — every renderer (preview and final) shares the cache. */
let shared: SvgRasterizer | null = null;
export function sharedSvgRasterizer(): SvgRasterizer {
  shared ??= new SvgRasterizer();
  return shared;
}
