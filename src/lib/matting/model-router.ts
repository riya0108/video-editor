import { rankModels, type MatteRequest, type RoutedModel } from "./router";
import type { MattingModel, MediaKind, RequestSubjectHint, DeviceSupport } from "./types";
import { createLogger, type MattingLogger } from "./pipeline/logger";

/**
 * INTELLIGENT MODEL ROUTER — Phase 8. Builds on router.ts's existing
 * eligibility filter + subject/media scoring (rankModels/selectModel) —
 * reused here, not reimplemented — and adds the resource- and difficulty-
 * aware layer the brief asks for: resolution, subject count, background
 * complexity, transparency/hair indicators, device capability, and
 * performance constraints, reduced to a full routing decision (selected
 * model + processing/refinement/fallback strategy), with every decision
 * logged.
 *
 * Explicit boundary: this router is a DECISION engine given signals, not a
 * signal-EXTRACTION engine. `RoutingRequest` accepts backgroundComplexity,
 * transparencyIndicators, hairDetailIndicators, subjectCount, and motion as
 * already-known inputs — the same way router.ts already treats `subject`
 * and `hasBackgroundPlate` as caller-supplied hints rather than something it
 * classifies from raw pixels itself. A future caller could derive several of
 * these from this app's own analysis modules (e.g. hairDetailIndicators from
 * hair-detector.ts's detectHairCandidates, or transparencyIndicators from
 * media-analysis.ts), but that wiring is out of this phase's scope.
 *
 * PRODUCTION READINESS (H6): confirmed via repo-wide import search that
 * NOTHING on the shipped path (pipeline/remove-background.ts, the actual
 * production model-selection loop, or pipeline/video-cutout.ts, the actual
 * shipped video path) imports this class. It's exercised only by its own
 * test suite and by src/lib/matting/video/'s temporal engine, which is
 * itself not imported by any production path either. Treat "difficulty-
 * aware routing" as tested-in-isolation code, not a shipped feature, until
 * something in pipeline/ actually calls ModelRouter.route().
 */

export type DeviceTier = "low-end" | "mid-range" | "high-end";

export interface DeviceCapability {
  tier: DeviceTier;
  webgpuAvailable: boolean;
  /** Rough available system/GPU memory in MB, if known. Omitted (not guessed) when unknown. */
  approxMemoryMb?: number;
}

export type BackgroundComplexity = "simple" | "complex" | "unknown";
export type MotionLevel = "none" | "low" | "high";

export interface PerformanceConstraints {
  maxLatencyMs?: number;
  maxMemoryMb?: number;
}

export interface RoutingRequest {
  media: MediaKind;
  width: number;
  height: number;
  /** Detected subject type — see RequestSubjectHint in types.ts; "unknown" is a legitimate, honest value. */
  subjectHint: RequestSubjectHint;
  /** Number of distinct subjects detected in frame. 1 is the common case; the router treats >1 as an extra difficulty signal (most matting models, and this app's own refinement pipeline, are tuned around a single dominant subject). */
  subjectCount: number;
  backgroundComplexity: BackgroundComplexity;
  /** Whether a clean, subject-free background plate is available for this shot — passed straight through to router.ts's eligibility check. */
  hasBackgroundPlate: boolean;
  /** Whether the subject itself plausibly needs real partial-opacity rendering (glass, smoke, sheer fabric) rather than a mostly-binary cutout. */
  transparencyIndicators: boolean;
  /** Video only — ignored for images. Informs temporal-model preference and frame-sampling strategy. */
  motion: MotionLevel;
  /** Whether fine hair/fur boundary detail is expected to matter for this subject. */
  hairDetailIndicators: boolean;
  device: DeviceCapability;
  performanceConstraints?: PerformanceConstraints;
  /** See MatteRequest.allowNonCommercial in router.ts — defaults to false. */
  allowNonCommercial?: boolean;
}

/**
 * The router's OWN editorial performance ranking for each known model —
 * deliberately NOT part of MattingModelCapabilities itself (that would mean
 * every adapter claiming something about its own resource cost; this is the
 * router's judgment about tradeoffs between models, kept separate). 1
 * (lightest) .. 5 (heaviest) — based on known model architecture (e.g. a
 * temporal/recurrent matting network costs more per frame than a
 * lightweight per-frame segmenter, and a higher native input resolution
 * costs more than a lower one), NOT a benchmarked measurement — stated
 * plainly rather than dressed up as more precise than it is. A model
 * missing from this table gets DEFAULT_PERFORMANCE_PROFILE (a neutral
 * mid-range assumption) instead of an error, so this table never needs to
 * be exhaustively kept in sync with every future adapter to keep working.
 */
export interface ModelPerformanceProfile {
  relativeComputeCost: number;
  relativeMemoryCost: number;
}

export const DEFAULT_PERFORMANCE_PROFILE: ModelPerformanceProfile = { relativeComputeCost: 3, relativeMemoryCost: 3 };

const MODEL_PERFORMANCE_PROFILES: Record<string, ModelPerformanceProfile> = {
  "mediapipe-selfie-segmenter": { relativeComputeCost: 1, relativeMemoryCost: 1 },
  "u2net": { relativeComputeCost: 2, relativeMemoryCost: 2 },
  "rmbg-1.4": { relativeComputeCost: 3, relativeMemoryCost: 3 },
  "modnet": { relativeComputeCost: 3, relativeMemoryCost: 3 },
  "background-matting-v2": { relativeComputeCost: 4, relativeMemoryCost: 4 },
  "rvm": { relativeComputeCost: 4, relativeMemoryCost: 3 },
};

export function getModelPerformanceProfile(modelId: string): ModelPerformanceProfile {
  return MODEL_PERFORMANCE_PROFILES[modelId] ?? DEFAULT_PERFORMANCE_PROFILE;
}

/** Latency budget (ms) below which a request counts as "tight" for both the resource-penalty and frame-sampling logic. An engineering judgment call (a few times a typical single-frame inference budget), not a measured threshold. */
const TIGHT_LATENCY_MS = 150;

const DEVICE_TIER_WEIGHT: Record<DeviceTier, number> = { "low-end": 3, "mid-range": 1.5, "high-end": 0.5 };
/** Scales every relativeComputeCost unit into a score-comparable penalty — chosen (see model-router.test.ts) so it meaningfully outweighs router.ts's own +5 matting-class bonus on a low-end device, but not on a high-end one. */
const COST_PENALTY_UNIT = 1.5;

/**
 * 0 (trivial) .. 1 (very difficult) — "DIFFICULT CASE" isn't a label a
 * caller asserts; it's computed here from the actual signals given, so a
 * request that merely *claims* difficulty without real evidence can't force
 * a stronger model/more refinement.
 */
export function computeDifficultyScore(request: RoutingRequest): number {
  let score = 0;
  if (request.motion === "high") score += 0.3;
  else if (request.motion === "low") score += 0.1;
  if (request.hairDetailIndicators) score += 0.25;
  if (request.backgroundComplexity === "complex") score += 0.25;
  if (request.transparencyIndicators) score += 0.15;
  if (request.subjectCount > 1) score += 0.15;
  return Math.min(1, score);
}

/** Extra credit for a "matting"-class model specifically on the signals it's genuinely better suited to than a plain segmenter — boundary-aware training helps most exactly where these indicators say it matters. */
function computeQualityBonus(routed: RoutedModel, request: RoutingRequest): number {
  if (routed.model.capabilities.modelClass !== "matting") return 0;
  let bonus = 0;
  if (request.hairDetailIndicators) bonus += 3;
  if (request.backgroundComplexity === "complex") bonus += 2;
  if (request.transparencyIndicators) bonus += 2;
  return bonus;
}

/**
 * "Do not automatically use the largest model": the concrete mechanism is
 * this penalty, not a special-cased "if biggest, reject" rule. A heavier
 * model's cost is weighed against device tier and any explicit latency/
 * memory constraint, relieved somewhat by genuine difficulty (a hard case
 * is worth spending more compute on, even on modest hardware) — see
 * model-router.test.ts for the low-end-device and difficult-case scenarios
 * this balance is tuned against.
 */
function computeResourcePenalty(profile: ModelPerformanceProfile, request: RoutingRequest, difficultyScore: number): number {
  const tightLatency = request.performanceConstraints?.maxLatencyMs !== undefined && request.performanceConstraints.maxLatencyMs < TIGHT_LATENCY_MS;
  // An explicit tight latency budget is treated as an independent, strong
  // signal — additive on top of the device-tier weight, not a small
  // multiplier riding on it — so a caller who explicitly says "this needs
  // to be fast" gets that honored even on high-end hardware that would
  // otherwise happily afford the heavier model.
  const tierWeight = DEVICE_TIER_WEIGHT[request.device.tier] + (tightLatency ? 4 : 0);
  const memoryConstrained =
    request.performanceConstraints?.maxMemoryMb !== undefined && profile.relativeMemoryCost >= 4 && request.performanceConstraints.maxMemoryMb < 512;
  const memoryPenalty = memoryConstrained ? profile.relativeMemoryCost * COST_PENALTY_UNIT : 0;
  const difficultyRelief = 1 - 0.4 * difficultyScore;
  return profile.relativeComputeCost * tierWeight * difficultyRelief * COST_PENALTY_UNIT + memoryPenalty;
}

export interface ProcessingStrategy {
  /** Resolution to actually run inference at — clamped into the model's own resolutionLimits, then reduced further for a constrained device/latency budget. Never below the model's own native resolution. */
  targetWidth: number;
  targetHeight: number;
  /** True when the request resolution exceeds the model's own declared max and a tile-then-stitch approach (this app's existing real-esrgan.ts precedent) is more appropriate than a single resize. */
  recommendTiling: boolean;
  /** Video only — a constrained device/latency budget samples frames rather than running every one, mirroring this app's existing sparse-sampling precedent (person-cutout.ts). Always "every-frame" for images. */
  frameSampling: "every-frame" | "sparse";
  /** The model's own first declared device backend that's actually usable given the request's device capability, or null if none of its declared backends apply — the adapter's own internal fallback still governs what actually runs. */
  preferredDevice: DeviceSupport | null;
}

export interface RefinementStrategy {
  /** Phase 2's refineAlphaMatte — always recommended when the selected model's output requiresRefinement (a "segmentation"-class result), or when the case is difficult enough to warrant a second look even from a matting-class model. */
  runAlphaRefinement: boolean;
  /** Phase 3's HairRefinementEngine. */
  runHairRefinement: boolean;
  /** Phase 4's ColourDecontaminationEngine. */
  runColourDecontamination: boolean;
  /** Phase 5's EdgeAnalysisEngine — targeted refinement guidance for a difficult or refinement-requiring case, instead of uniform treatment. */
  runEdgeAnalysis: boolean;
  /** Scales refinement parameters (e.g. Phase 2/3's own radius/strength options) — "light" for an easy, high-confidence case, "aggressive" for a difficult one. */
  intensity: "light" | "standard" | "aggressive";
}

export interface FallbackStrategy {
  /** The rest of the eligible, ranked candidates, in order — ready to try if the primary selection fails outright or a later MatteQualityEngine (Phase 7) report recommends AlternativeModel. */
  alternativeModels: RoutedModel[];
  maxAttempts: number;
  /** Mirrors Phase 7's RecommendedAction vocabulary so a MatteQualityReport can drive this directly. */
  triggerOn: ("model-failure" | "low-confidence" | "low-quality")[];
}

export interface RoutingDecision {
  selected: RoutedModel | null;
  /** Null only when `selected` is null — there's nothing to plan processing for. */
  processingStrategy: ProcessingStrategy | null;
  refinementStrategy: RefinementStrategy;
  fallbackStrategy: FallbackStrategy;
  difficultyScore: number;
  /** Human-readable trace of why this decision was made — in addition to (not instead of) the structured log entry every call to `route()` emits. */
  reasoning: string[];
}

function buildProcessingStrategy(model: MattingModel, request: RoutingRequest): ProcessingStrategy {
  const limits = model.capabilities.resolutionLimits;
  let targetWidth = request.width;
  let targetHeight = request.height;
  if (limits.maxWidth) targetWidth = Math.min(targetWidth, limits.maxWidth);
  if (limits.maxHeight) targetHeight = Math.min(targetHeight, limits.maxHeight);
  if (limits.minWidth) targetWidth = Math.max(targetWidth, limits.minWidth);
  if (limits.minHeight) targetHeight = Math.max(targetHeight, limits.minHeight);

  const tightLatency = request.performanceConstraints?.maxLatencyMs !== undefined && request.performanceConstraints.maxLatencyMs < TIGHT_LATENCY_MS;
  if (request.device.tier === "low-end" || tightLatency) {
    targetWidth = Math.max(limits.nativeWidth, Math.round(targetWidth * 0.75));
    targetHeight = Math.max(limits.nativeHeight, Math.round(targetHeight * 0.75));
  }

  const recommendTiling = !!(limits.maxWidth && request.width > limits.maxWidth) || !!(limits.maxHeight && request.height > limits.maxHeight);

  const preferredDevice =
    model.capabilities.deviceSupport.find((d) => (d === "webgpu" ? request.device.webgpuAvailable : true)) ?? model.capabilities.deviceSupport[0] ?? null;

  const frameSampling: "every-frame" | "sparse" =
    request.media === "video" && (request.device.tier === "low-end" || tightLatency) ? "sparse" : "every-frame";

  return { targetWidth, targetHeight, recommendTiling, frameSampling, preferredDevice };
}

function buildRefinementStrategy(routed: RoutedModel, difficultyScore: number, request: RoutingRequest): RefinementStrategy {
  const runAlphaRefinement = routed.requiresRefinement || difficultyScore > 0.3;
  const runEdgeAnalysis = routed.requiresRefinement || difficultyScore > 0.3;
  const intensity: "light" | "standard" | "aggressive" = difficultyScore > 0.6 ? "aggressive" : difficultyScore > 0.25 ? "standard" : "light";
  return {
    runAlphaRefinement,
    runHairRefinement: request.hairDetailIndicators,
    runColourDecontamination: request.transparencyIndicators || request.backgroundComplexity === "complex",
    runEdgeAnalysis,
    intensity,
  };
}

function emptyRefinementStrategy(): RefinementStrategy {
  return { runAlphaRefinement: false, runHairRefinement: false, runColourDecontamination: false, runEdgeAnalysis: false, intensity: "light" };
}

export class ModelRouter {
  constructor(private readonly logger: MattingLogger = createLogger()) {}

  /**
   * Routes one request against the given candidate model list. Reuses
   * router.ts's rankModels for eligibility (license, media, background-
   * plate) and its base subject/media/temporal scoring, then re-ranks by
   * this phase's resource- and difficulty-aware adjustments. Always emits
   * exactly one structured log entry describing the outcome — "log every
   * routing decision" is enforced here, not left to the caller to remember.
   */
  route(models: MattingModel[], request: RoutingRequest): RoutingDecision {
    const reasoning: string[] = [];
    const matteRequest: MatteRequest = {
      media: request.media,
      subject: request.subjectHint,
      hasBackgroundPlate: request.hasBackgroundPlate,
      allowNonCommercial: request.allowNonCommercial,
    };
    const baseRanking = rankModels(models, matteRequest);
    const difficultyScore = computeDifficultyScore(request);
    reasoning.push(`base eligibility found ${baseRanking.length} candidate(s)`, `difficulty score ${difficultyScore.toFixed(2)}`);

    this.logger.debug("model-router", "base ranking computed", {
      request,
      candidateIds: baseRanking.map((r) => r.model.capabilities.modelId),
      difficultyScore,
    });

    if (baseRanking.length === 0) {
      reasoning.push("no eligible model found for this request");
      const decision: RoutingDecision = {
        selected: null,
        processingStrategy: null,
        refinementStrategy: emptyRefinementStrategy(),
        fallbackStrategy: { alternativeModels: [], maxAttempts: 0, triggerOn: ["model-failure", "low-confidence", "low-quality"] },
        difficultyScore,
        reasoning,
      };
      this.logger.warn("model-router", "no eligible model found", { request, difficultyScore });
      return decision;
    }

    const adjusted = baseRanking
      .map((routed) => {
        const bonus = computeQualityBonus(routed, request);
        const penalty = computeResourcePenalty(getModelPerformanceProfile(routed.model.capabilities.modelId), request, difficultyScore);
        return { ...routed, score: routed.score + bonus - penalty };
      })
      .sort((a, b) => b.score - a.score);

    const selected = adjusted[0];
    const alternativeModels = adjusted.slice(1);
    reasoning.push(`selected ${selected.model.capabilities.modelId} (adjusted score ${selected.score.toFixed(2)})`);

    const processingStrategy = buildProcessingStrategy(selected.model, request);
    const refinementStrategy = buildRefinementStrategy(selected, difficultyScore, request);
    const fallbackStrategy: FallbackStrategy = {
      alternativeModels,
      maxAttempts: Math.min(3, alternativeModels.length + 1),
      triggerOn: ["model-failure", "low-confidence", "low-quality"],
    };

    const decision: RoutingDecision = { selected, processingStrategy, refinementStrategy, fallbackStrategy, difficultyScore, reasoning };

    this.logger.info("model-router", `routed to ${selected.model.capabilities.modelId}`, {
      request,
      selectedModelId: selected.model.capabilities.modelId,
      adjustedScore: selected.score,
      difficultyScore,
      processingStrategy,
      refinementStrategy,
      fallbackModelIds: alternativeModels.map((a) => a.model.capabilities.modelId),
      reasoning,
    });

    return decision;
  }
}
