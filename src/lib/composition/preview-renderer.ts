import type { TimelineModel } from "../timeline/model";
import type { ClipVisual } from "../timeline/visual";
import { createCanvas, ensureSize, get2d, type AnyCanvas } from "./canvas";
import { drawResolvedFrame, svgRasterSizeFor, type Ctx2D, type DrawStats, type LayerPixels } from "./draw";
import type { FrameProvider } from "./frame-provider";
import { renderSize, type RenderProfile } from "./render-profile";
import { resolveFrame, type ResolvedFrame } from "./resolve";
import type { TextMeasurer } from "./text-layout";
import { sharedSvgRasterizer, type SvgRasterizer } from "./svg-raster";

export interface PreviewRenderResult {
  resolved: ResolvedFrame;
  stats: DrawStats;
  renderMs: number;
  /** Size of the preview raster (composition size x profile.scale). */
  width: number;
  height: number;
  scale: number;
}

/**
 * PREVIEW PATH. Synchronous and never blocks on media: renders the current
 * frame at a reduced scale from whatever pixels the provider has decoded
 * right now. Owns its own canvases — nothing it allocates is shared with
 * FinalRenderer, so preview state can never bleed into an export.
 */
export class PreviewRenderer {
  private readonly canvas: AnyCanvas = createCanvas(2, 2);
  private readonly ctx: Ctx2D = get2d(this.canvas);
  private readonly scratch = new Map<number, { canvas: AnyCanvas; ctx: Ctx2D }>();

  constructor(
    private readonly provider: FrameProvider,
    private readonly measurer: TextMeasurer,
    private readonly svg: SvgRasterizer = sharedSvgRasterizer(),
  ) {}

  /** The most recently rendered preview raster (composition-shaped, preview-resolution). */
  get output(): AnyCanvas {
    return this.canvas;
  }

  render(timeline: TimelineModel, frame: number, profile: RenderProfile, visualOverrides?: Readonly<Record<string, ClipVisual>>): PreviewRenderResult {
    if (profile.kind !== "preview") throw new Error("PreviewRenderer only accepts preview profiles.");
    const t0 = performance.now();
    const resolved = resolveFrame(timeline, frame, {
      getSourceInfo: (id) => this.provider.getSourceInfo(id),
      measurer: this.measurer,
      visualOverrides,
    });

    const { width, height } = renderSize(resolved.width, resolved.height, profile.scale);
    ensureSize(this.canvas, width, height);
    // Effective scale after integer rounding of the raster size — use it (not profile.scale) so geometry lands on the same pixels the final render would, scaled.
    const renderScale = width / resolved.width;

    this.provider.beginPreviewFrame?.();
    const pixels = new Map<string, LayerPixels>();
    for (const layer of resolved.layers) {
      const px: LayerPixels = {};
      if (layer.content.type === "media") {
        px.image = this.provider.peekFrame({ sourceId: layer.content.sourceId, sourceFrame: layer.content.sourceFrame, slotKey: layer.clipId }) ?? undefined;
      } else if (layer.content.type === "svg") {
        const { width: rw, height: rh } = svgRasterSizeFor(layer, renderScale, "preview");
        px.image = this.svg.peek(layer.content.svg, rw, rh) ?? undefined;
      }
      if (layer.matte) {
        px.matte = this.provider.peekFrame({ sourceId: layer.matte.sourceId, sourceFrame: layer.matte.sourceFrame, slotKey: `${layer.clipId}#matte` }) ?? undefined;
      }
      pixels.set(layer.clipId, px);
    }
    this.provider.endPreviewFrame?.();

    const stats = drawResolvedFrame(this.ctx, resolved, pixels, {
      renderScale,
      smoothing: profile.smoothing,
      getScratch: (slot = 0, readback = true) => this.getScratch(slot, readback, width, height),
    });
    return { resolved, stats, renderMs: performance.now() - t0, width, height, scale: renderScale };
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
