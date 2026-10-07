/**
 * AI EDITING ENGINE — RESULT, CONFIDENCE AND STATUS MODEL (AI_EDITING_ARCHITECTURE.md §2–§4).
 *
 * Every analysis targets ONE clip's source media and reports times in SOURCE
 * seconds (the media's own clock), so a result stays valid when the clip is
 * moved or trimmed; `apply/` maps source time onto the timeline through the
 * clip at apply time. Results are plain, serializable data — editable items
 * the user can accept, edit or delete before anything touches the timeline.
 * Nothing here ever writes to media.
 */

export type AIFeatureId =
  | "shot-detection"
  | "scene-detection"
  | "object-detection"
  | "face-detection"
  | "speaker-detection"
  | "silence-detection"
  | "filler-detection"
  | "auto-reframe"
  | "highlight-detection"
  | "object-removal"
  | "object-tracking"
  | "broll-suggestions";

export const AI_FEATURES: readonly AIFeatureId[] = [
  "shot-detection",
  "scene-detection",
  "object-detection",
  "face-detection",
  "speaker-detection",
  "silence-detection",
  "filler-detection",
  "auto-reframe",
  "highlight-detection",
  "object-removal",
  "object-tracking",
  "broll-suggestions",
];

/**
 * What actually produced a result — shown to the user and stored with every result, so a heuristic is never
 * presented as a neural model. "ml-model" = a trained network actually ran; "classical-cv"/"signal-processing" =
 * deterministic algorithms; "heuristic" = a hand-tuned score over other signals.
 */
export type ProviderKind = "ml-model" | "classical-cv" | "signal-processing" | "heuristic";

export interface ModelInfo {
  name: string;
  /** Where the weights come from (self-hosted path or URL). */
  source: string;
  license: string;
  sizeBytes?: number;
}

/**
 * CONFIDENCE MODEL. `value` is 0..1. `basis` says what the number IS, so a UI never presents a heuristic margin as a
 * calibrated probability:
 *  - "model-score": the network's own output score (uncalibrated unless the model says otherwise),
 *  - "margin": distance of a measurement past its decision threshold, squashed to 0..1,
 *  - "heuristic": a normalized hand-tuned score,
 *  - "agreement": fraction of evidence that agrees (e.g. track frames found / frames searched).
 */
export interface Confidence {
  value: number;
  basis: "model-score" | "margin" | "heuristic" | "agreement";
}

export type ConfidenceBand = "low" | "medium" | "high";

export function confidenceBand(c: Confidence): ConfidenceBand {
  return c.value >= 0.75 ? "high" : c.value >= 0.45 ? "medium" : "low";
}

export function conf(value: number, basis: Confidence["basis"]): Confidence {
  return { value: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0, basis };
}

/** Margin past a threshold -> 0..1 (0.5 exactly at the threshold). `scale` = how far past counts as "very sure". */
export function marginConfidence(value: number, threshold: number, scale: number): Confidence {
  const z = (value - threshold) / Math.max(1e-9, scale);
  return conf(1 / (1 + Math.exp(-3 * z)), "margin");
}

/** Normalized box: fractions of the frame (0..1), top-left origin. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  /** Source seconds. */
  time: number;
  box: Box;
  label: string;
  confidence: Confidence;
  /** Face keypoints (normalized), when the model provides them. */
  keypoints?: { x: number; y: number }[];
}

// ---- per-feature result items ---------------------------------------------------------------------------------------

interface ItemBase {
  /** Stable within a result. */
  id: string;
  /** The user's decision. Apply actions use accepted items only; new items start accepted. */
  accepted: boolean;
  confidence: Confidence;
  /** Set when the user edited the item (times/box/label) — kept so the UI can show "edited". */
  edited?: boolean;
}

export interface ShotItem extends ItemBase {
  kind: "shot";
  start: number;
  end: number;
  /** How the shot STARTS (the transition into it); the first shot starts with "start". */
  transitionIn: "start" | "cut" | "dissolve";
}

export interface SceneItem extends ItemBase {
  kind: "scene";
  start: number;
  end: number;
  shotIds: string[];
}

export interface DetectionTrackItem extends ItemBase {
  kind: "detection-track";
  label: string;
  /** Detections of the same object/face over time (IoU-linked), source seconds ascending. */
  detections: Detection[];
  start: number;
  end: number;
}

export interface SpeakerTurnItem extends ItemBase {
  kind: "speaker-turn";
  start: number;
  end: number;
  speaker: string;
}

export interface SilenceItem extends ItemBase {
  kind: "silence";
  start: number;
  end: number;
  /** Mean level inside the range. */
  levelDb: number;
}

export interface FillerItem extends ItemBase {
  kind: "filler";
  start: number;
  end: number;
  text: string;
  /** "hesitation" = um/uh-type sounds; "discourse" = phrases like "you know" (context-dependent, lower confidence). */
  category: "hesitation" | "discourse";
}

export interface ReframeKey {
  time: number;
  /** Crop window centre, normalized source coordinates. */
  cx: number;
  cy: number;
}

export interface ReframeItem extends ItemBase {
  kind: "reframe";
  /** Target aspect (width / height), e.g. 9/16. */
  aspect: number;
  /** Crop window size as a fraction of the source (the largest window of `aspect` that fits). */
  cropW: number;
  cropH: number;
  keys: ReframeKey[];
  subject: "face" | "person" | "center";
}

export interface HighlightItem extends ItemBase {
  kind: "highlight";
  start: number;
  end: number;
  score: number;
  reasons: string[];
}

export interface ObjectRemovalItem extends ItemBase {
  kind: "object-removal";
  region: Box;
  method: "temporal-plate" | "temporal-plate+diffusion";
  /** Frame-provider source id of the generated clean-plate patch (an image). Re-generated if missing after reload. */
  plateSourceId: string;
  /** Fraction of region pixels filled from real background samples (the rest by diffusion). */
  realBackgroundFraction: number;
  cameraMotion: number;
}

export interface TrackKey {
  time: number;
  box: Box;
  score: number;
}

export interface TrackItem extends ItemBase {
  kind: "track";
  label: string;
  keys: TrackKey[];
  /** Times where the target was lost (score under threshold); positions there are held, not guessed. */
  lostTimes: number[];
}

export interface BrollItem extends ItemBase {
  kind: "broll";
  start: number;
  end: number;
  keywords: string[];
  /** Suggested search query for a stock library / your own media. */
  query: string;
  transcript: string;
}

export type AIResultItem =
  | ShotItem
  | SceneItem
  | DetectionTrackItem
  | SpeakerTurnItem
  | SilenceItem
  | FillerItem
  | ReframeItem
  | HighlightItem
  | ObjectRemovalItem
  | TrackItem
  | BrollItem;

/** What an analysis ran on. */
export interface AITarget {
  clipId: string;
  sourceId: string;
  /** The analysed span of the source, seconds. */
  sourceStart: number;
  sourceEnd: number;
}

export interface AIResult {
  id: string;
  feature: AIFeatureId;
  providerId: string;
  providerKind: ProviderKind;
  model?: ModelInfo;
  target: AITarget;
  createdAt: number;
  items: AIResultItem[];
  /** Honest caveats from the provider (e.g. "camera moves: clean plate unreliable"). */
  warnings: string[];
  metrics: { durationMs: number; framesAnalyzed?: number; audioSeconds?: number; [k: string]: number | undefined };
  /** Free-form parameters the run used (thresholds, sample rate...), for reproducibility. */
  params: Record<string, unknown>;
}

// ---- job status -----------------------------------------------------------------------------------------------------

export type AIJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly AIJobStatus[] = ["completed", "failed", "cancelled"];
