import type { TimelineModel } from "../timeline/model";
import { createCanvas, ensureSize, get2d, type AnyCanvas } from "./canvas";
import { drawResolvedFrame, svgRasterSizeFor, type Ctx2D, type LayerPixels } from "./draw";
import type { FrameProvider } from "./frame-provider";
import { FINAL_PROFILE } from "./render-profile";
import { resolveFrame, type ResolvedFrame } from "./resolve";
import { cssFont, type TextMeasurer } from "./text-layout";
import { sharedSvgRasterizer, type SvgRasterizer } from "./svg-raster";

export class FinalRenderError extends Error {
  constructor(
    message: string,
    readonly frame: number,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "FinalRenderError";
  }
}

export interface FinalFrame {
  /** Exactly composition width x height (x outputScale). Owned by the renderer and overwritten by the next renderFrame() — consume (encode/copy) before rendering again. */
  canvas: AnyCanvas;
  resolved: ResolvedFrame;
}

/**
 * FINAL PATH. Always FINAL_PROFILE: full composition resolution, high-quality
 * resampling, the exact source frame for every media layer and matte, and
 * web fonts loaded before text is measured. Anything it can't satisfy is a
 * FinalRenderError — it never silently drops a layer the way preview may.
 *
 * Shares only resolveFrame() + drawResolvedFrame() with the preview path, so
 * export geometry is guaranteed identical to what the preview showed.
 */
export class FinalRenderer {
  private readonly canvas: AnyCanvas;
  private readonly ctx: Ctx2D;
  private readonly scratch = new Map<number, { canvas: AnyCanvas; ctx: Ctx2D }>();
  private readonly loadedFonts = new Set<string>();

  constructor(
    private readonly provider: FrameProvider,
    private readonly measurer: TextMeasurer,
    private readonly svg: SvgRasterizer = sharedSvgRasterizer(),
  ) {
    this.canvas = createCanvas(2, 2);
    this.ctx = get2d(this.canvas);
  }

  /**
   * `opts` (Phase 15, RENDER_ENGINE_ARCHITECTURE.md §3) — used by the render engine, never by preview:
   *  - outputScale: output pixels per composition pixel (an output preset of the composition's shape at another size,
   *    e.g. 2160×3840 from a 1080×1920 composition). Text, shapes and SVG are re-rasterized at that size; media is
   *    sampled from full-resolution source frames. Default 1.
   *  - mediaFrameOffset: added to every video/matte source frame, so a frame rendered at a different output rate
   *    samples media at the centre of its own output interval (see render/plan.ts). Default 0.
   * `frame` may be fractional (an output rate that differs from the project's).
   */
  async renderFrame(timeline: TimelineModel, frame: number, opts: { outputScale?: number; mediaFrameOffset?: number } = {}): Promise<FinalFrame> {
    const profile = FINAL_PROFILE;
    const scale = opts.outputScale ?? 1;
    if (!(scale > 0)) throw new FinalRenderError(`Invalid output scale ${scale}.`, frame);
    let resolved = this.resolve(timeline, frame, opts.mediaFrameOffset ?? 0);

    if (await this.ensureFonts(resolved)) {
      // Fonts just arrived: anything measured against a fallback font is stale — re-measure so wrapping/box sizes match the real glyphs.
      this.measurer.invalidate?.();
      resolved = this.resolve(timeline, frame, opts.mediaFrameOffset ?? 0);
    }
    if (resolved.missingSources.length > 0) {
      throw new FinalRenderError(`Frame ${frame}: source(s) not loaded: ${resolved.missingSources.join(", ")}.`, frame, resolved.missingSources);
    }

    const pixels = new Map<string, LayerPixels>();
    try {
      await Promise.all(
        resolved.layers.map(async (layer) => {
          const px: LayerPixels = {};
          if (layer.content.type === "media") {
            px.image = await this.provider.getExactFrame({ sourceId: layer.content.sourceId, sourceFrame: layer.content.sourceFrame, slotKey: layer.clipId });
          } else if (layer.content.type === "svg") {
            // Rasterized at exactly the output pixel size — vector-sharp in the export.
            const { width: rw, height: rh } = svgRasterSizeFor(layer, profile.scale * scale, "final");
            px.image = await this.svg.get(layer.content.svg, rw, rh);
          }
          if (layer.matte) {
            px.matte = await this.provider.getExactFrame({ sourceId: layer.matte.sourceId, sourceFrame: layer.matte.sourceFrame, slotKey: `${layer.clipId}#matte` });
          }
          pixels.set(layer.clipId, px);
        }),
      );
    } catch (e) {
      throw new FinalRenderError(`Frame ${frame}: could not produce a layer's pixels (media frame or SVG) — ${(e as Error).message}`, frame);
    }

    // Exactly composition size x output scale — never a preview scale.
    const outW = Math.round(resolved.width * scale);
    const outH = Math.round(resolved.height * scale);
    ensureSize(this.canvas, outW, outH);
    const stats = drawResolvedFrame(this.ctx, resolved, pixels, {
      renderScale: profile.scale * scale,
      smoothing: profile.smoothing,
      getScratch: (slot = 0, readback = true) => this.getScratch(slot, readback, outW, outH),
    });
    if (stats.skipped.length > 0) {
      throw new FinalRenderError(`Frame ${frame}: ${stats.skipped.length} layer(s) had no pixels.`, frame, stats.skipped);
    }
    return { canvas: this.canvas, resolved };
  }

  /** Sequential frame range [start, end) — the shape an encoder loop consumes. Sequential on purpose: exact seeks on one decoder are fastest in order. */
  async *renderRange(timeline: TimelineModel, start: number, end: number): AsyncGenerator<FinalFrame> {
    for (let f = start; f < end; f++) yield await this.renderFrame(timeline, f);
  }

  private resolve(timeline: TimelineModel, frame: number, mediaFrameOffset: number): ResolvedFrame {
    const resolved = resolveFrame(timeline, frame, { getSourceInfo: (id) => this.provider.getSourceInfo(id), measurer: this.measurer });
    if (mediaFrameOffset === 0) return resolved;
    return {
      ...resolved,
      layers: resolved.layers.map((l) => ({
        ...l,
        content: l.content.type === "media" && !l.content.still ? { ...l.content, sourceFrame: Math.max(0, l.content.sourceFrame + mediaFrameOffset) } : l.content,
        matte: l.matte ? { ...l.matte, sourceFrame: Math.max(0, l.matte.sourceFrame + mediaFrameOffset) } : l.matte,
      })),
    };
  }

  /** Returns true if any font was newly loaded. */
  private async ensureFonts(resolved: ResolvedFrame): Promise<boolean> {
    if (typeof document === "undefined" || !document.fonts) return false;
    const pending: Promise<unknown>[] = [];
    for (const layer of resolved.layers) {
      if (layer.content.type !== "text") continue;
      const font = cssFont(layer.content.style);
      if (this.loadedFonts.has(font)) continue;
      this.loadedFonts.add(font);
      const sample = layer.content.layout.lines.map((l) => l.text).join(" ");
      pending.push(document.fonts.load(font, sample || "A"));
    }
    if (pending.length === 0) return false;
    await Promise.all(pending);
    return true;
  }

  /** One canvas per (slot, readback) pair (0 = layer isolation, 1-3 = transitions, 4-5 = mask/matte work), allocated on first use; only readback surfaces are CPU-backed (willReadFrequently). */
  private getScratch(slot: number, readback: boolean, width: number, height: number): Ctx2D {
    const key = readback ? slot : -1 - slot;
    let s = this.scratch.get(key);
    if (!s) {
      const canvas = createCanvas(width, height);
      s = { canvas, ctx: get2d(canvas, { willReadFrequently: readback }) };
      this.scratch.set(key, s);
    }
    ensureSize(s.canvas, width, height);
    return s.ctx;
  }
}
