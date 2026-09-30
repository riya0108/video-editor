/**
 * PRODUCTION READINESS (H6): this whole directory — dense per-frame
 * temporal video matting (scene-cut detection, motion-aware smoothing,
 * occlusion handling) and its own quality-analysis engine — is confirmed
 * (repo-wide import search) to have ZERO callers outside itself, its own
 * tests, and model-router.ts (also unwired — see that file's own note).
 * The shipped video AI-cutout path (pipeline/video-cutout.ts) runs each
 * sampled frame through the plain image pipeline independently instead,
 * with no temporal smoothing. Do not describe "temporal consistency" as a
 * shipped feature on the strength of this directory's own test coverage —
 * it isn't reachable from any real user request today.
 */
export {
  TemporalMattingEngine,
  DEFAULT_TEMPORAL_MATTING_OPTIONS,
  type TemporalMattingOptions,
  type TemporalFrameResult,
  type SerializedTemporalState,
} from "./temporal-matting-engine";
export {
  VideoMattingSession,
  type VideoMattingSessionOptions,
  type VideoMattingProgress,
  type VideoMattingCheckpoint,
  type VideoMattingSummary,
  type DecodedFrame,
  type EncodableFrame,
} from "./video-matting-session";
export { createVideoFrameSource, type VideoFrameSource, type VideoFrameSourceOptions } from "./frame-source";
export {
  TemporalMatteQualityEngine,
  TemporalInstabilityKind,
  DEFAULT_TEMPORAL_QUALITY_OPTIONS,
  type TemporalQualityOptions,
  type InstabilityEvent,
  type TemporalConsistencyMetrics,
  type TemporalMatteQualityReport,
} from "./temporal-quality-engine";
export {
  computeForegroundMask,
  computeHoleMask,
  computeBoundaryMask,
  computeTrimap,
  computeMotionMask,
  meanOf,
  computeAlphaFlickerScore,
  computeEdgeJitterScore,
  computeSilhouetteInstabilityScore,
  computeHairInstabilityScore,
  computeSuddenOpacityChanges,
  computeMaskPoppingScore,
  computeTemporalHolesScore,
  computeTemporalLeakageVolatility,
  type AlphaFlickerResult,
  type EdgeJitterResult,
  type SilhouetteInstabilityResult,
  type HairInstabilityResult,
  type SuddenOpacityChangeResult,
  type MaskPoppingResult,
  type TemporalHoleResult,
  type TemporalLeakageResult,
} from "./temporal-quality-signals";
