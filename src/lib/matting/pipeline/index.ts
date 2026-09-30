export { removeBackgroundFromImage } from "./remove-background";
export { analyzeMedia, type MediaAnalysis } from "./media-analysis";
export { resizeAlphaBilinear } from "./alpha-resize";
export { guidedFilterAlpha, boxBlur } from "./guided-filter";
export { refineEdgeBand, DEFAULT_EDGE_REFINE_OPTIONS, type EdgeRefineOptions } from "./edge-refine";
export { decontaminate, DEFAULT_DECONTAMINATE_OPTIONS, type DecontaminateOptions, type DecontaminateResult } from "./decontaminate";
export { computeQualityMetrics, computeConfidence } from "./quality-metrics";
export { computeBoundingBox } from "./bounding-box";
export { drawSourceToRgba, compositeTransparentForeground } from "./dom-io";
export { createLogger, createCollectingLogger, createNullLogger, type MattingLogger, type LogEntry, type LogLevel } from "./logger";
export {
  MASK_VERSION,
  MattingError,
  type MattingResult,
  type MattingErrorCode,
  type QualityMetrics,
  type BoundingBox,
  type RemoveBackgroundOptions,
} from "./types";
