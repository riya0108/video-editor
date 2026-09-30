export { TrimapLabel, buildTrimap, buildFineDetailMask, DEFAULT_TRIMAP_OPTIONS, DEFAULT_FINE_DETAIL_OPTIONS, type TrimapOptions, type FineDetailOptions } from "./trimap";
export { normalizeAlpha } from "./normalize";
export { contractExpandAlpha, shiftEdgeAlpha } from "./shape-ops";
export { smoothAlpha, featherAlpha, antiAliasAlpha, type SmoothOptions } from "./smoothing-ops";
export { applyAlphaContrast } from "./contrast";
export { labelConnectedComponents, type ConnectedComponents } from "./connected-components";
export { cleanupHolesAndIslands, DEFAULT_CLEANUP_OPTIONS, type CleanupOptions, type CleanupResult } from "./cleanup";
export {
  refineAlphaMatte,
  DEFAULT_REFINEMENT_PARAMS,
  type RefinementParams,
  type PartialRefinementParams,
  type RefineAlphaMatteResult,
} from "./pipeline";
export {
  detectHairCandidates,
  expandUnknownAroundCandidates,
  dilateBinaryMask,
  DEFAULT_HAIR_DETECTION_OPTIONS,
  DEFAULT_EXPAND_UNKNOWN_OPTIONS,
  type HairDetectionOptions,
  type HairDetectionResult,
  type ExpandUnknownOptions,
} from "./hair-detector";
export {
  refineFineDetail,
  DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
  type FineDetailRefineOptions,
  type FineDetailRefineResult,
} from "./fine-detail-refiner";
export {
  HairRefinementEngine,
  DEFAULT_HAIR_REFINEMENT_OPTIONS,
  type HairRefinementOptions,
  type PartialHairRefinementOptions,
  type HairRefinementResult,
} from "./hair-refinement";
export {
  ColourDecontaminationEngine,
  DEFAULT_DECONTAMINATION_OPTIONS,
  rgbSaturation,
  isScreenLikeColor,
  type DecontaminationOptions,
  type DecontaminationResult,
} from "./decontamination-engine";
export { EdgeCategory, EDGE_CATEGORY_NAMES, getEdgeRefinementGuidance, type EdgeRefinementGuidance } from "./edge-category";
export type { EdgeClassifier, EdgeClassifierInput, EdgeClassificationMap } from "./edge-classifier";
export {
  computeAlphaGradientMagnitude,
  computeLocalDensity,
  computeStructureTensorAnisotropy,
  computeChromaticity,
  computeLocalAlphaRange,
  computeAlphaOscillationDensity,
  chromaticityDistance,
  estimateNearbyForegroundColor,
  type Chromaticity,
} from "./edge-signals";
export {
  ClassicalEdgeClassifier,
  DEFAULT_CLASSICAL_EDGE_CLASSIFIER_OPTIONS,
  type ClassicalEdgeClassifierOptions,
} from "./classical-edge-classifier";
export { EdgeAnalysisEngine, type EdgeAnalysisResult } from "./edge-analysis-engine";
export { computeStrokeCoverage, type Point, type BrushStampOptions, type StrokeCoverage } from "./brush-stamp";
export {
  ManualRefinementEngine,
  BrushMode,
  DEFAULT_BRUSH_OPTIONS,
  type BrushOptions,
  type DirtyRegion,
  type SerializedManualRefinementLayer,
} from "./manual-refinement-engine";
export {
  compositePreview,
  renderEdgePreview,
  PreviewBackgroundMode,
  DEFAULT_PREVIEW_OPTIONS,
  DEFAULT_EDGE_PREVIEW_OPTIONS,
  type PreviewOptions,
  type PreviewBuffer,
  type EdgePreviewOptions,
} from "./preview-compositor";
export { MattePreviewEngine, type GeneratedMatte, type MattePreviewStats } from "./matte-preview-engine";
export {
  DEFAULT_VIEWPORT_STATE,
  imageToScreen,
  screenToImage,
  clampZoom,
  zoomAt,
  pan,
  type ViewportState,
  type ScreenPoint,
  type ImagePoint,
} from "./viewport";
export {
  boundingBoxOfPixels,
  analyzeEdgeSmoothness,
  analyzeEdgeContinuity,
  analyzeHalos,
  analyzeHolesAndIslands,
  analyzeHairPreservation,
  analyzeAlphaDiscontinuity,
  analyzeColourContamination,
  analyzeResolutionAdequacy,
  type EdgeSmoothnessResult,
  type EdgeContinuityResult,
  type HaloResult,
  type HoleIslandAnalysis,
  type HairPreservationResult,
  type AlphaDiscontinuityResult,
  type ContaminationResult,
  type ResolutionAdequacyResult,
} from "./matte-quality-signals";
export {
  MatteQualityEngine,
  DEFAULT_MATTE_QUALITY_OPTIONS,
  RecommendedAction,
  type MatteQualityReport,
  type MatteQualityOptions,
  type MatteQualityDetails,
} from "./matte-quality-engine";
