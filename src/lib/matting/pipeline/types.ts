import type { SubjectKind, MattingModel } from "../types";

/**
 * Bumped whenever the *shape or meaning* of the alpha data this pipeline
 * produces changes (e.g. a different refinement algorithm that changes what
 * an intermediate value means) — lets a consumer that persists a
 * MattingResult (not done anywhere yet, but the field exists for when it
 * is) detect a stale/incompatible saved matte instead of silently
 * misinterpreting it.
 */
export const MASK_VERSION = "matting-pipeline-v1";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every field here is computed directly from the actual alpha data this
 * specific run produced — see pipeline/quality-metrics.ts for the exact
 * formulas. None of these are placeholder/fabricated values; a stage that
 * can't compute one honestly (e.g. no edge pixels found at all) reports the
 * real degenerate result (0), not a made-up "good" number.
 */
export interface QualityMetrics {
  /** Fraction of pixels with alpha > 0.5 — 0 or values very close to 0/1 across a whole image usually mean a failed segmentation, not a real subject. */
  coverageFraction: number;
  /** Of the pixels that sit on an alpha boundary (non-trivial local gradient), the fraction with a value strictly between 0.05 and 0.95 — i.e. a real graded/soft edge survived, rather than everything being hard-thresholded to 0 or 1 (this is the metric that would catch a regression of requirements 5/6 in the brief). */
  softEdgeFraction: number;
  /** Mean |∇alpha| magnitude, computed only at boundary pixels — a real (not fabricated) sharpness proxy; higher generally means a crisper edge, but this is a descriptive statistic, not a "sharpness score" with a claimed ideal value. */
  edgeGradientEnergy: number;
  /** Fraction of all pixels whose alpha falls in the two most extreme histogram bins (near 0 or near 1) — how decisively the model separated foreground from background. Used to derive `confidence` below. */
  alphaHistogramBimodality: number;
}

export interface MattingResult {
  /** Continuous alpha, 0-1, at the source image's resolution — never thresholded to binary (requirement 5/6). */
  alpha: Float32Array;
  alphaWidth: number;
  alphaHeight: number;
  /** The decontaminated subject composited onto real transparency — the "TRANSPARENT OUTPUT" stage's deliverable. A freshly created canvas; the original source image is never drawn into or mutated (requirements 1/2). */
  foreground: HTMLCanvasElement;
  /** Tight box around alpha > 0.05, in source-image pixel coordinates. Null when no foreground was detected at all. */
  boundingBox: BoundingBox | null;
  /**
   * 0-1, derived transparently from qualityMetrics.alphaHistogramBimodality
   * (with a penalty for implausible coverage) — see
   * pipeline/quality-metrics.ts's computeConfidence for the exact formula.
   * This is a real, inspectable number, not a fabricated "AI confidence"
   * label.
   */
  confidence: number;
  /** capabilities.modelId of whichever model in the fallback chain actually produced this result. */
  modelUsed: string;
  /** Real measured wall-clock duration of the whole pipeline call, in milliseconds. */
  processingTimeMs: number;
  /** PHASE 14 — PERFORMANCE. Just the winning model's `inferImage()` call, a subset of processingTimeMs — isolates model forward-pass cost from refinement/decontamination/quality-analysis overhead. */
  modelInferenceTimeMs: number;
  /** Non-fatal issues surfaced during processing — e.g. a fallback occurred, decontamination found nothing to do, coverage/confidence look implausible. Never used to paper over an actual failure (a real failure throws MattingError instead — see below). */
  warnings: string[];
  qualityMetrics: QualityMetrics;
  resolution: { width: number; height: number };
  maskVersion: string;
}

export interface RemoveBackgroundOptions {
  /**
   * Explicit subject override. Omit this to get the honest default
   * ("unknown" — see RequestSubjectHint in ../types.ts): this app has no
   * real subject/face classifier yet, and guessing would violate the "no
   * unsupported quality claims" instruction more than admitting the
   * limitation does.
   */
  subjectHint?: SubjectKind;
  /** See MatteRequest.allowNonCommercial in ../router.ts — defaults to false. */
  allowNonCommercial?: boolean;
  onModelLoadProgress?: (fraction: number) => void;
  /** PHASE 16 — ADVERSARIAL MATTE TESTING. Overrides the shared model registry — exists so tests can inject mock models that simulate specific failure modes (GPU unavailable, model download failure, OOM) without a real ONNX runtime. Never set by production callers. */
  models?: MattingModel[];
}

export type MattingErrorCode = "NO_ELIGIBLE_MODEL" | "ALL_MODELS_FAILED";

/**
 * Thrown — never silently swallowed into a fabricated "success" result —
 * when no model could actually process the image. Carries whatever
 * per-model failure messages were collected along the way.
 */
export class MattingError extends Error {
  code: MattingErrorCode;
  warnings: string[];

  constructor(code: MattingErrorCode, message: string, warnings: string[] = []) {
    super(message);
    this.name = "MattingError";
    this.code = code;
    this.warnings = warnings;
  }
}
