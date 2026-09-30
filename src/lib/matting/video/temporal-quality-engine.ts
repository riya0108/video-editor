import type { BoundingBox } from "../pipeline/types";
import { detectHairCandidates } from "../pipeline/refine/hair-detector";
import {
  computeTrimap,
  computeBoundaryMask,
  computeForegroundMask,
  computeHoleMask,
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
} from "./temporal-quality-signals";
import { rampToConfidence } from "../pipeline/refine/edge-signals";

/**
 * TEMPORAL QUALITY ANALYSIS — Phase 10. TemporalMatteQualityEngine analyzes
 * a SEQUENCE of already-produced alpha frames (however they were produced —
 * independent of whether Phase 9's TemporalMattingEngine was used) for
 * frame-to-frame consistency, mirroring Phase 7's MatteQualityEngine's "do
 * not fabricate scores" discipline across time instead of within one frame.
 *
 * The remediation workflow the brief specifies is implemented literally,
 * per detected instability:
 *   1. identify affected frame range   -> InstabilityEvent.frameRange
 *   2. identify affected region        -> InstabilityEvent.region
 *   3. attempt localized correction    -> a temporal MEDIAN filter (a real,
 *      standard technique for removing single-frame spikes/impulse noise —
 *      the temporal analogue of a spatial median filter — applied only
 *      within the flagged region, never the whole frame)
 *   4. re-evaluate                     -> the SAME metric, recomputed on
 *      the corrected region
 *   5. flag for human review if still unstable -> InstabilityEvent.needsHumanReview
 *
 * "Do not hide failures" / "expose the warning": every event this engine
 * raises is retained in the report's `events` list regardless of whether
 * correction resolved it — a resolved event is still visible (transparent
 * about what was changed), and an unresolved one is never silently dropped.
 * TemporalLeakage (metric 8) never attempts correction at all — smoothing a
 * multi-frame volatility trend isn't a sensible localized alpha edit, and
 * pretending otherwise would be exactly the kind of overclaiming this
 * project's brief warns against; it always goes straight to
 * needsHumanReview instead.
 */

export const enum TemporalInstabilityKind {
  AlphaFlicker = "alpha-flicker",
  EdgeJitter = "edge-jitter",
  SilhouetteInstability = "silhouette-instability",
  HairInstability = "hair-instability",
  SuddenOpacityChange = "sudden-opacity-change",
  MaskPopping = "mask-popping",
  TemporalHole = "temporal-hole",
  TemporalLeakage = "temporal-leakage",
}

export interface InstabilityEvent {
  kind: TemporalInstabilityKind;
  /** Inclusive frame index range this event spans. */
  frameRange: { start: number; end: number };
  region: BoundingBox;
  /** Measured severity (metric-specific derivation, always 0..1) that triggered this event. */
  severity: number;
  correctionAttempted: boolean;
  /** Only meaningful when correctionAttempted. */
  severityAfterCorrection: number | null;
  /** True only when correctionAttempted AND severityAfterCorrection dropped far enough. */
  resolved: boolean;
  /** Always true when !resolved — "do not hide failures". */
  needsHumanReview: boolean;
  message: string;
}

export interface TemporalConsistencyMetrics {
  alphaFlickerScore: number;
  edgeJitterScore: number;
  silhouetteInstabilityScore: number;
  hairInstabilityScore: number;
  suddenOpacityChangeScore: number;
  maskPoppingScore: number;
  temporalHoleScore: number;
  temporalLeakageScore: number;
}

export interface TemporalMatteQualityReport {
  framesAnalyzed: number;
  metrics: TemporalConsistencyMetrics;
  events: InstabilityEvent[];
  unresolvedEvents: InstabilityEvent[];
  overallTemporalQuality: number;
  needsReview: boolean;
  warnings: string[];
}

export interface TemporalQualityOptions {
  motionThreshold: number;
  alphaFlickerThreshold: number;
  edgeJitterThreshold: number;
  silhouetteInstabilityThreshold: number;
  hairInstabilityThreshold: number;
  suddenOpacityChangeThreshold: number;
  maskPoppingThreshold: number;
  temporalHoleThreshold: number;
  temporalLeakageThreshold: number;
  /** Rolling window size (frames) the temporal-leakage volatility metric is computed over. */
  leakageWindowSize: number;
  /** Whether to attempt localized correction at all — false skips straight to flagging every triggered event for human review (still never hidden). */
  attemptCorrection: boolean;
  /** A corrected severity must fall at or below (originalThreshold * resolutionFactor) to count as resolved. */
  resolutionFactor: number;
}

export const DEFAULT_TEMPORAL_QUALITY_OPTIONS: TemporalQualityOptions = {
  motionThreshold: 18,
  alphaFlickerThreshold: 0.05,
  edgeJitterThreshold: 0.15,
  silhouetteInstabilityThreshold: 0.3,
  hairInstabilityThreshold: 0.4,
  suddenOpacityChangeThreshold: 0.1,
  maskPoppingThreshold: 0.1,
  temporalHoleThreshold: 0.1,
  temporalLeakageThreshold: 0.3,
  leakageWindowSize: 5,
  attemptCorrection: true,
  resolutionFactor: 0.5,
};

interface FrameContext {
  frameIndex: number;
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  trimap: Uint8Array;
  boundaryMask: Uint8Array;
  foregroundMask: Uint8Array;
  holeMask: Uint8Array;
  hairMask: Uint8Array;
  foregroundArea: number;
}

function fullFrameRegion(width: number, height: number): BoundingBox {
  return { x: 0, y: 0, width, height };
}

function medianOf3(values: [number, number, number]): number {
  return [...values].sort((a, b) => a - b)[1];
}
function medianOf2(values: [number, number]): number {
  return (values[0] + values[1]) / 2;
}

/** The one, generic correction primitive every metric's remediation step uses — a temporal median filter, applied only within `region`. With a lookahead frame available it's a true 3-tap median (removes a single-frame spike while preserving a real, sustained change across two consecutive frames); without one, it degrades honestly to a 2-tap average. */
function applyTemporalMedianInRegion(
  previousAlpha: Float32Array,
  currentAlpha: Float32Array,
  nextAlpha: Float32Array | null,
  region: BoundingBox,
  width: number,
): Float32Array {
  const corrected = currentAlpha.slice();
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = y * width + x;
      corrected[i] = nextAlpha
        ? medianOf3([previousAlpha[i], currentAlpha[i], nextAlpha[i]])
        : medianOf2([previousAlpha[i], currentAlpha[i]]);
    }
  }
  return corrected;
}

function fractionMatchingInRegion(region: BoundingBox, width: number, test: (i: number) => boolean): number {
  let count = 0;
  let total = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      total++;
      if (test(x + y * width)) count++;
    }
  }
  return total > 0 ? count / total : 0;
}

export class TemporalMatteQualityEngine {
  private readonly options: TemporalQualityOptions;
  private buffer: FrameContext[] = [];
  private frameCounter = 0;
  private events: InstabilityEvent[] = [];
  private leakageHistory: number[] = [];
  private metricHistory = {
    alphaFlicker: [] as number[],
    edgeJitter: [] as number[],
    silhouette: [] as number[],
    hair: [] as number[],
    opacity: [] as number[],
    popping: [] as number[],
    holes: [] as number[],
    leakage: [] as number[],
  };

  constructor(overrides: Partial<TemporalQualityOptions> = {}) {
    this.options = { ...DEFAULT_TEMPORAL_QUALITY_OPTIONS, ...overrides };
  }

  private prepareContext(alpha: Float32Array, rgba: Uint8ClampedArray, width: number, height: number, frameIndex: number): FrameContext {
    const trimap = computeTrimap(alpha, width, height);
    const boundaryMask = computeBoundaryMask(trimap, width, height);
    const foregroundMask = computeForegroundMask(alpha);
    const holeMask = computeHoleMask(alpha, width, height);
    const { candidateMask: hairMask } = detectHairCandidates(alpha, rgba, width, height);
    let foregroundArea = 0;
    for (const v of foregroundMask) if (v) foregroundArea++;
    return { frameIndex, alpha, rgba, width, height, trimap, boundaryMask, foregroundMask, holeMask, hairMask, foregroundArea };
  }

  /** Call once per frame, in order. Maintains only a 3-frame rolling buffer internally (bounded memory, matching Phase 9's streaming discipline) — this is not "load the whole video", it's a small fixed-size lookahead window. */
  observeFrame(alpha: Float32Array, rgba: Uint8ClampedArray, width: number, height: number): void {
    const ctx = this.prepareContext(alpha, rgba, width, height, this.frameCounter);
    this.frameCounter++;
    this.buffer.push(ctx);
    if (this.buffer.length > 3) this.buffer.shift();

    if (this.buffer.length >= 2) {
      this.evaluateTwoFrameMetrics(this.buffer[this.buffer.length - 2], this.buffer[this.buffer.length - 1]);
    }
    if (this.buffer.length === 3) {
      this.evaluateThreeFrameMetrics(this.buffer[0], this.buffer[1], this.buffer[2]);
    }
  }

  private evaluateTwoFrameMetrics(prev: FrameContext, curr: FrameContext): void {
    const motion = computeMotionMask(curr.rgba, prev.rgba, this.options.motionThreshold);
    const meanMotion = meanOf(motion);
    const frameRange = { start: prev.frameIndex, end: curr.frameIndex };
    const fullRegion = fullFrameRegion(curr.width, curr.height);

    const jitter = computeEdgeJitterScore(prev.boundaryMask, curr.boundaryMask);
    this.metricHistory.edgeJitter.push(jitter.score);
    this.maybeRaiseEvent(TemporalInstabilityKind.EdgeJitter, jitter.score, this.options.edgeJitterThreshold, frameRange, fullRegion, () => {
      const corrected = applyTemporalMedianInRegion(prev.alpha, curr.alpha, null, fullRegion, curr.width);
      const recomputed = this.prepareContext(corrected, curr.rgba, curr.width, curr.height, curr.frameIndex);
      return computeEdgeJitterScore(prev.boundaryMask, recomputed.boundaryMask).score;
    });

    const silhouette = computeSilhouetteInstabilityScore(prev.foregroundArea, curr.foregroundArea, meanMotion);
    this.metricHistory.silhouette.push(silhouette.score);
    this.maybeRaiseEvent(TemporalInstabilityKind.SilhouetteInstability, silhouette.score, this.options.silhouetteInstabilityThreshold, frameRange, fullRegion, () => {
      const corrected = applyTemporalMedianInRegion(prev.alpha, curr.alpha, null, fullRegion, curr.width);
      const recomputed = this.prepareContext(corrected, curr.rgba, curr.width, curr.height, curr.frameIndex);
      return computeSilhouetteInstabilityScore(prev.foregroundArea, recomputed.foregroundArea, meanMotion).score;
    });

    const hair = computeHairInstabilityScore(prev.hairMask, curr.hairMask);
    if (!hair.noHairDetected) {
      this.metricHistory.hair.push(hair.score);
      this.maybeRaiseEvent(TemporalInstabilityKind.HairInstability, hair.score, this.options.hairInstabilityThreshold, frameRange, fullRegion, () => {
        const corrected = applyTemporalMedianInRegion(prev.alpha, curr.alpha, null, fullRegion, curr.width);
        const recomputed = this.prepareContext(corrected, curr.rgba, curr.width, curr.height, curr.frameIndex);
        return computeHairInstabilityScore(prev.hairMask, recomputed.hairMask).score;
      });
    }

    const opacity = computeSuddenOpacityChanges(prev.alpha, curr.alpha, motion, curr.width, curr.height);
    this.metricHistory.opacity.push(opacity.score);
    for (const region of opacity.regions) {
      this.maybeRaiseEvent(TemporalInstabilityKind.SuddenOpacityChange, opacity.score, this.options.suddenOpacityChangeThreshold, frameRange, region, () => {
        const corrected = applyTemporalMedianInRegion(prev.alpha, curr.alpha, null, region, curr.width);
        return fractionMatchingInRegion(region, curr.width, (i) => motion[i] < 0.2 && Math.abs(corrected[i] - prev.alpha[i]) > 0.4);
      });
    }

    const popping = computeMaskPoppingScore(prev.foregroundMask, curr.foregroundMask, curr.width, curr.height, curr.foregroundArea);
    this.metricHistory.popping.push(popping.score);
    for (const region of popping.regions) {
      this.maybeRaiseEvent(TemporalInstabilityKind.MaskPopping, popping.score, this.options.maskPoppingThreshold, frameRange, region, () => {
        const corrected = applyTemporalMedianInRegion(prev.alpha, curr.alpha, null, region, curr.width);
        return fractionMatchingInRegion(region, curr.width, (i) => (corrected[i] > 0.5 ? 1 : 0) !== prev.foregroundMask[i]);
      });
    }

    let holeArea = 0;
    for (const v of curr.holeMask) if (v) holeArea++;
    const leakageScoreNow = rampToConfidence(holeArea / Math.max(1, curr.foregroundArea), 0.05);
    this.leakageHistory.push(leakageScoreNow);
    if (this.leakageHistory.length > this.options.leakageWindowSize) this.leakageHistory.shift();
    if (this.leakageHistory.length >= this.options.leakageWindowSize) {
      const leakage = computeTemporalLeakageVolatility(this.leakageHistory);
      this.metricHistory.leakage.push(leakage.score);
      // No correction attempt: a multi-frame volatility trend has no
      // sensible localized alpha edit — see the class doc comment.
      this.maybeRaiseEvent(
        TemporalInstabilityKind.TemporalLeakage,
        leakage.score,
        this.options.temporalLeakageThreshold,
        { start: curr.frameIndex - this.options.leakageWindowSize + 1, end: curr.frameIndex },
        fullRegion,
        null,
      );
    }
  }

  private evaluateThreeFrameMetrics(a: FrameContext, b: FrameContext, c: FrameContext): void {
    const motionAB = computeMotionMask(b.rgba, a.rgba, this.options.motionThreshold);
    const frameRange = { start: a.frameIndex, end: c.frameIndex };
    const fullRegion = fullFrameRegion(b.width, b.height);

    const flicker = computeAlphaFlickerScore(a.alpha, b.alpha, c.alpha, motionAB);
    this.metricHistory.alphaFlicker.push(flicker.score);
    this.maybeRaiseEvent(TemporalInstabilityKind.AlphaFlicker, flicker.score, this.options.alphaFlickerThreshold, frameRange, fullRegion, () => {
      const corrected = applyTemporalMedianInRegion(a.alpha, b.alpha, c.alpha, fullRegion, b.width);
      return computeAlphaFlickerScore(a.alpha, corrected, c.alpha, motionAB).score;
    });

    const holes = computeTemporalHolesScore(a.holeMask, b.holeMask, c.holeMask, b.width, b.foregroundArea);
    this.metricHistory.holes.push(holes.score);
    for (const region of holes.regions) {
      this.maybeRaiseEvent(TemporalInstabilityKind.TemporalHole, holes.score, this.options.temporalHoleThreshold, { start: b.frameIndex, end: b.frameIndex }, region, () => {
        const corrected = applyTemporalMedianInRegion(a.alpha, b.alpha, c.alpha, region, b.width);
        const correctedHoleMask = computeHoleMask(corrected, b.width, b.height);
        return fractionMatchingInRegion(region, b.width, (i) => correctedHoleMask[i] === 1 && !a.holeMask[i] && !c.holeMask[i]);
      });
    }
  }

  private maybeRaiseEvent(
    kind: TemporalInstabilityKind,
    severity: number,
    threshold: number,
    frameRange: { start: number; end: number },
    region: BoundingBox,
    attemptCorrection: (() => number) | null,
  ): void {
    if (severity <= threshold) return;

    let correctionAttempted = false;
    let severityAfterCorrection: number | null = null;
    if (attemptCorrection && this.options.attemptCorrection) {
      correctionAttempted = true;
      severityAfterCorrection = attemptCorrection();
    }
    const resolved = correctionAttempted && severityAfterCorrection !== null && severityAfterCorrection <= threshold * this.options.resolutionFactor;
    const needsHumanReview = !resolved;

    const message = resolved
      ? `${kind}: severity ${severity.toFixed(2)} at frames ${frameRange.start}-${frameRange.end} — localized correction reduced it to ${severityAfterCorrection!.toFixed(2)}.`
      : correctionAttempted
        ? `${kind}: severity ${severity.toFixed(2)} at frames ${frameRange.start}-${frameRange.end} — localized correction only reduced it to ${severityAfterCorrection!.toFixed(2)}; still unstable, flagged for human review.`
        : `${kind}: severity ${severity.toFixed(2)} at frames ${frameRange.start}-${frameRange.end} — no automated correction attempted; flagged for human review.`;

    this.events.push({ kind, frameRange, region, severity, correctionAttempted, severityAfterCorrection, resolved, needsHumanReview, message });
  }

  finalize(): TemporalMatteQualityReport {
    const metrics: TemporalConsistencyMetrics = {
      alphaFlickerScore: meanOfArray(this.metricHistory.alphaFlicker),
      edgeJitterScore: meanOfArray(this.metricHistory.edgeJitter),
      silhouetteInstabilityScore: meanOfArray(this.metricHistory.silhouette),
      hairInstabilityScore: meanOfArray(this.metricHistory.hair),
      suddenOpacityChangeScore: meanOfArray(this.metricHistory.opacity),
      maskPoppingScore: meanOfArray(this.metricHistory.popping),
      temporalHoleScore: meanOfArray(this.metricHistory.holes),
      temporalLeakageScore: meanOfArray(this.metricHistory.leakage),
    };

    const goodness = [
      1 - metrics.alphaFlickerScore,
      1 - metrics.edgeJitterScore,
      1 - metrics.silhouetteInstabilityScore,
      1 - metrics.hairInstabilityScore,
      1 - metrics.suddenOpacityChangeScore,
      1 - metrics.maskPoppingScore,
      1 - metrics.temporalHoleScore,
      1 - metrics.temporalLeakageScore,
    ];
    const overallTemporalQuality = Math.min(1, Math.max(0, goodness.reduce((a, b) => a + b, 0) / goodness.length));

    const unresolvedEvents = this.events.filter((e) => e.needsHumanReview);
    const warnings = this.events.map((e) => e.message);
    const needsReview = unresolvedEvents.length > 0;

    return {
      framesAnalyzed: this.frameCounter,
      metrics,
      events: this.events,
      unresolvedEvents,
      overallTemporalQuality,
      needsReview,
      warnings,
    };
  }
}

function meanOfArray(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
