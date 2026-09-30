/**
 * Model-independent matting/segmentation interface — see
 * MATTE_IMPLEMENTATION_PLAN.md section 3 for the rationale. This phase
 * implements ONLY this abstraction layer plus the capability-aware router
 * (router.ts): no refinement/decontamination/QA pipeline, no editor UI
 * changes. Every model adapter (in ./models/) implements MattingModel.
 */

/**
 * Distinguishes a model that only produces a coarse foreground/background
 * confidence mask (still continuous 0-1, not necessarily binary — but not
 * trained or post-processed for fine boundary detail either) from one that
 * produces a true alpha matte suitable for hair/fur/motion-blur edges on its
 * own. This distinction is load-bearing: a "segmentation"-class output must
 * never be treated as a finished matte (see MatteOutput.producedBy and
 * router.ts's `requiresRefinement`) — U²-Net and MediaPipe's selfie
 * segmenter are "segmentation"; MODNet and BackgroundMattingV2 are
 * "matting". This is the "separate SEGMENTATION from MATTING" requirement.
 */
export type ModelClass = "segmentation" | "matting";

export type MediaKind = "image" | "video";

/**
 * What kind of subject a model is tuned/best-suited for. "general" covers
 * arbitrary objects/products; "known-background" isn't really a *subject*
 * so much as a shot condition (BackgroundMattingV2-style — the model needs a
 * captured empty-background plate, not just a subject-type preference), but
 * it's modeled here rather than as a separate axis because it's how the
 * router actually chooses between candidates.
 */
export type SubjectKind = "portrait" | "product" | "general" | "known-background";

/**
 * What a *request* can specify — a model always declares one or more real
 * SubjectKinds it's tuned for, but a caller often genuinely doesn't know the
 * subject in advance. "unknown" is an honest value, not a placeholder to be
 * embarrassed about: this app has no real subject/face classifier yet (see
 * MATTE_IMPLEMENTATION_PLAN.md section 21's known limitations), so pretending
 * otherwise would be exactly the kind of unsupported claim the project brief
 * warns against. The router degrades gracefully for "unknown" — see
 * router.ts's score() — rather than depending on this being accurate.
 */
export type RequestSubjectHint = SubjectKind | "unknown";

/** What a model needs beyond the current frame to run. */
export type RequiredInput = "frame" | "background-plate" | "previous-alpha" | "previous-frame";

export type DeviceSupport = "webgpu" | "wasm" | "gpu-delegate" | "cpu-delegate";

export interface ResolutionLimits {
  /** Native input resolution the model was trained/exported for — inputs are resized to this before inference. */
  nativeWidth: number;
  nativeHeight: number;
  /** Below this, upscaling before inference is expected to hurt quality more than it helps. Omitted when not meaningfully constrained. */
  minWidth?: number;
  minHeight?: number;
  /** Above this, a caller should tile (see src/lib/upscale/real-esrgan.ts's TILE/OVERLAP precedent) rather than resize down, if the model supports tiling. Omitted when the model doesn't support/need tiling. */
  maxWidth?: number;
  maxHeight?: number;
}

export interface LicenseInfo {
  /** SPDX identifier where one applies ("Apache-2.0", "MIT", "GPL-3.0"), or a short human name for a non-SPDX license. Mirrors MODEL_LICENSES.md — keep both in sync by hand when either changes. */
  id: string;
  commercialUse: boolean;
  redistributable: boolean;
  sourceUrl: string;
  /**
   * True for a copyleft license (e.g. GPL-3.0) whose restriction can't be
   * lifted by simply purchasing a commercial license the way BRIA's
   * RMBG-1.4 non-commercial restriction can — integrating copyleft-licensed
   * code into this proprietary bundle at all is the problem, not who paid
   * for it. router.ts treats this as an absolute exclusion with no
   * allowNonCommercial escape hatch, unlike a plain non-commercial license.
   * See MODEL_LICENSES.md's RVM entry.
   */
  copyleft?: boolean;
  /** Free-text caveat, e.g. "requires a paid BRIA license for commercial use." */
  notes?: string;
}

export interface MattingModelCapabilities {
  modelId: string;
  modelClass: ModelClass;
  supportedMedia: MediaKind[];
  supportedSubjects: SubjectKind[];
  requiredInputs: RequiredInput[];
  /**
   * Every adapter normalizes its native output into this one shape (see
   * MatteOutput) — kept as an explicit capability field, not just assumed,
   * so a future model with a genuinely different native output (e.g. a
   * trimap rather than an alpha) has somewhere to declare that before
   * anything forces it through this shape.
   */
  outputType: "alpha-mask";
  resolutionLimits: ResolutionLimits;
  deviceSupport: DeviceSupport[];
  /**
   * True only for a model whose inference call maintains internal state
   * across frames that must be explicitly reset between unrelated clips
   * (a temporal/recurrent network, e.g. RVM's hidden state). A plain
   * per-frame segmenter run repeatedly on video is NOT temporal in this
   * sense — that's just `supportedMedia` including "video".
   */
  supportsTemporal: boolean;
  license: LicenseInfo;
}

export interface MatteImageInput {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Present only when the model's capabilities.requiredInputs includes "background-plate". */
  backgroundPlate?: CanvasImageSource;
}

export interface MatteVideoFrameInput extends MatteImageInput {
  /** Strictly increasing per-model-instance timestamp — same contract src/lib/media/selfie-segmenter.ts already uses; doesn't need to match the source video's own clock. */
  timestampMs: number;
}

/** Normalized output every adapter produces, regardless of what the underlying model natively returns. */
export interface MatteOutput {
  /** Continuous foreground confidence, 0-1, at the model's native output resolution. Resizing to source resolution is the caller's job — mirrors the existing division of labor in src/lib/media/bg-removal-canvas.ts's applyMaskForeground, which this phase does not change. */
  alpha: Float32Array;
  alphaWidth: number;
  alphaHeight: number;
  /**
   * Lets a caller holding only a MatteOutput (not the model it came from)
   * still know whether this needs mandatory refinement before use as a
   * final matte. Do NOT treat a "segmentation"-class output as a finished,
   * hair-capable alpha matte — see MATTE_IMPLEMENTATION_PLAN.md section 8
   * (not implemented in this phase; this field just carries the fact
   * forward so that pipeline can consume it later).
   */
  producedBy: {
    modelId: string;
    modelClass: ModelClass;
  };
}

export interface HealthCheckResult {
  ok: boolean;
  loaded: boolean;
  device?: DeviceSupport;
  error?: string;
}

/**
 * Common interface every matting/segmentation model adapter implements.
 * Capabilities a model doesn't support are simply absent (the corresponding
 * method is optional) rather than present-but-throwing — "do not force
 * every model to implement capabilities it does not support." Use
 * supportsImage/supportsVideo/isTemporal below to call these safely instead
 * of checking `typeof model.inferX === "function"` ad hoc everywhere.
 */
export interface MattingModel {
  readonly capabilities: MattingModelCapabilities;
  load(onProgress?: (fraction: number) => void): Promise<void>;
  unload(): void;
  isLoaded(): boolean;
  healthCheck(): Promise<HealthCheckResult>;
  /** Present only when capabilities.supportedMedia includes "image". */
  inferImage?(input: MatteImageInput): Promise<MatteOutput>;
  /** Present only when capabilities.supportedMedia includes "video". */
  inferVideo?(input: MatteVideoFrameInput): Promise<MatteOutput>;
  /** Present only when capabilities.supportsTemporal — clears internal recurrent state so a new clip doesn't inherit the previous one's motion history. */
  resetTemporalState?(): void;
}

type ImageCapableModel = MattingModel & { inferImage: (input: MatteImageInput) => Promise<MatteOutput> };
type VideoCapableModel = MattingModel & { inferVideo: (input: MatteVideoFrameInput) => Promise<MatteOutput> };
type TemporalModel = MattingModel & { resetTemporalState: () => void };

/** True (and narrows the type) only when the model both declares image support and actually implements inferImage — declaring one without the other is a bug in the adapter, not something callers should paper over. */
export function supportsImage(model: MattingModel): model is ImageCapableModel {
  return model.capabilities.supportedMedia.includes("image") && typeof model.inferImage === "function";
}

export function supportsVideo(model: MattingModel): model is VideoCapableModel {
  return model.capabilities.supportedMedia.includes("video") && typeof model.inferVideo === "function";
}

export function isTemporal(model: MattingModel): model is TemporalModel {
  return model.capabilities.supportsTemporal && typeof model.resetTemporalState === "function";
}
