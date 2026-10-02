/**
 * PREVIEW vs FINAL — the only knobs that differ between the two render
 * paths. Geometry is never one of them (both draw the same ResolvedFrame).
 *
 * FINAL_PROFILE is frozen and is the only profile FinalRenderer accepts, so
 * no preview setting (a reduced scale, cheap smoothing, "use whatever frame
 * is decoded") can leak into an export. See COMPOSITION_ARCHITECTURE.md §6.
 */
export interface RenderProfile {
  readonly kind: "preview" | "final";
  /** Render pixels per composition pixel. */
  readonly scale: number;
  readonly smoothing: ImageSmoothingQuality;
  /** true: every media layer must show its exact source frame (await seeks). false: show the nearest frame already decoded. */
  readonly exactFrames: boolean;
  /** true: a missing source/frame/matte is an error. false: the layer is skipped and the frame still renders. */
  readonly strict: boolean;
}

export const FINAL_PROFILE: RenderProfile = Object.freeze({
  kind: "final",
  scale: 1,
  smoothing: "high",
  exactFrames: true,
  strict: true,
});

export type PreviewQuality = "auto" | "full" | "half" | "quarter";

export const PREVIEW_QUALITY_LABELS: Record<PreviewQuality, string> = {
  auto: "Auto",
  full: "Full",
  half: "1/2",
  quarter: "1/4",
};

/** Power-of-two steps keep the backing canvas from being reallocated on every tiny zoom change. */
const AUTO_STEPS = [1, 0.5, 0.25, 0.125] as const;

/**
 * "Auto" picks the smallest render scale that still has at least one render
 * pixel per physical screen pixel at the current zoom: a 4K composition
 * fitted into a 900px pane renders at 1/4, but zooming to 200% switches to
 * full. You never see preview-resolution softness that the screen could
 * actually display, and never pay for pixels it can't.
 */
export function autoPreviewScale(zoom: number, devicePixelRatio: number): number {
  const needed = zoom * devicePixelRatio;
  let chosen: number = AUTO_STEPS[0];
  for (const step of AUTO_STEPS) if (step >= needed) chosen = step;
  return chosen;
}

export function previewProfile(quality: PreviewQuality, zoom: number, devicePixelRatio: number, playing: boolean): RenderProfile {
  const scaleByQuality: Record<Exclude<PreviewQuality, "auto">, number> = { full: 1, half: 0.5, quarter: 0.25 };
  const scale = quality === "auto" ? autoPreviewScale(zoom, devicePixelRatio) : scaleByQuality[quality];
  return {
    kind: "preview",
    scale,
    // Cheaper resampling only while frames are flying by; a paused frame gets the good filter so inspecting a still is honest.
    smoothing: playing ? "low" : "high",
    exactFrames: false,
    strict: false,
  };
}

/** Render-target size for a composition at `scale`. Never below 2x2. */
export function renderSize(compWidth: number, compHeight: number, scale: number): { width: number; height: number } {
  return { width: Math.max(2, Math.round(compWidth * scale)), height: Math.max(2, Math.round(compHeight * scale)) };
}
