/**
 * EDGE ANALYSIS — Phase 5. The set of edge categories an EdgeClassifier
 * (see edge-classifier.ts) can assign to a pixel, and the lookup table
 * mapping each one to concrete refinement guidance — this is the literal
 * mechanism behind "the classification must influence refinement": every
 * category maps to a documented, testable set of parameter biases a caller
 * can apply to Phase 2's RefinementParams, Phase 3's HairRefinementOptions,
 * and Phase 4's DecontaminationOptions. This file has no dependency on any
 * particular classifier implementation — it's pure data, reusable by the
 * classical classifier now and any future (e.g. ML-based) one later.
 */
export const enum EdgeCategory {
  HardEdge = 0,
  SoftEdge = 1,
  Hair = 2,
  Fur = 3,
  Translucent = 4,
  MotionBlur = 5,
  Shadow = 6,
  Reflection = 7,
  Uncertain = 8,
}

export const EDGE_CATEGORY_NAMES: Record<EdgeCategory, string> = {
  [EdgeCategory.HardEdge]: "HARD_EDGE",
  [EdgeCategory.SoftEdge]: "SOFT_EDGE",
  [EdgeCategory.Hair]: "HAIR",
  [EdgeCategory.Fur]: "FUR",
  [EdgeCategory.Translucent]: "TRANSLUCENT",
  [EdgeCategory.MotionBlur]: "MOTION_BLUR",
  [EdgeCategory.Shadow]: "SHADOW",
  [EdgeCategory.Reflection]: "REFLECTION",
  [EdgeCategory.Uncertain]: "UNCERTAIN",
};

export interface EdgeRefinementGuidance {
  /** Human-readable rationale — diagnostics/logs only, never shown to end users. */
  rationale: string;
  /**
   * -1..1. Positive biases toward a narrow, geometrically precise boundary
   * (HARD_EDGE: "prioritize geometric accuracy"); negative biases toward
   * preserving a wide, gradual transition as-is (SOFT_EDGE: "preserve
   * gradual alpha transition", TRANSLUCENT: "preserve partial opacity").
   * Intended to scale Phase 2's contractExpand/localEdgeRefine radius.
   */
  edgeSharpnessBias: number;
  /** Recommends routing this region through Phase 3's HairRefinementEngine — HAIR's "prioritize fine alpha detail" and FUR's denser equivalent. */
  recommendHairRefinement: boolean;
  /**
   * Upper bound this region's alpha should be allowed to reach *automatically*,
   * without further evidence. SHADOW's "do not automatically classify as
   * solid foreground" and REFLECTION's "treat cautiously" both live here —
   * both are capped below 1 rather than being allowed to resolve to fully
   * opaque on the strength of ordinary refinement alone. Every other
   * category leaves this at 1 (no cap).
   */
  maxAutoAlpha: number;
  /**
   * Multiplies Phase 4's ColourDecontaminationEngine effective strength for
   * this region. REFLECTION and SHADOW get a reduced multiplier (their
   * colour evidence is inherently less trustworthy — "treat cautiously"),
   * HAIR/FUR get a mild reduction (preserve the strand's own natural colour
   * rather than aggressively unmixing it), everything else runs at full
   * strength.
   */
  decontaminationStrengthMultiplier: number;
  /**
   * Multiplies Phase 2's smoothAlpha radius. TRANSLUCENT and SOFT_EDGE get
   * a reduced multiplier — "preserve gradual alpha transition"/"preserve
   * partial opacity" both mean *don't reshape what's already there*.
   * HARD_EDGE also gets a reduced multiplier, for the opposite reason: a
   * boundary that should stay crisp shouldn't be blurred at all. HAIR/FUR
   * get a reduced multiplier too, since they route to the *targeted*
   * Phase 3 pass instead of broad smoothing.
   */
  smoothingRadiusMultiplier: number;
  /**
   * "trigger stronger refinement or manual review": flags this region as a
   * priority candidate for Phase 3's local refinement mode (once a paint UI
   * exists) or an extra automated refinement pass in the meantime.
   * UNCERTAIN always sets this; REFLECTION sets it too, given how
   * conservative its own detection already is (see
   * classical-edge-classifier.ts's doc comment).
   */
  flagForManualReview: boolean;
}

const GUIDANCE: Record<EdgeCategory, EdgeRefinementGuidance> = {
  [EdgeCategory.HardEdge]: {
    rationale: "Crisp geometric boundary — prioritize accuracy, don't soften it.",
    edgeSharpnessBias: 0.8,
    recommendHairRefinement: false,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 1,
    smoothingRadiusMultiplier: 0.3,
    flagForManualReview: false,
  },
  [EdgeCategory.SoftEdge]: {
    rationale: "Genuine gradual transition — preserve it, don't sharpen or reshape it.",
    edgeSharpnessBias: -0.5,
    recommendHairRefinement: false,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 1,
    smoothingRadiusMultiplier: 0.6,
    flagForManualReview: false,
  },
  [EdgeCategory.Hair]: {
    rationale: "Fine strand structure — route to targeted hair refinement, not broad smoothing.",
    edgeSharpnessBias: 0,
    recommendHairRefinement: true,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 0.7,
    smoothingRadiusMultiplier: 0.2,
    flagForManualReview: false,
  },
  [EdgeCategory.Fur]: {
    rationale: "Dense fine-detail texture — same targeted treatment as HAIR, slightly gentler decontamination.",
    edgeSharpnessBias: 0,
    recommendHairRefinement: true,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 0.6,
    smoothingRadiusMultiplier: 0.2,
    flagForManualReview: false,
  },
  [EdgeCategory.Translucent]: {
    rationale: "Genuine partial opacity (glass, veil, sheer fabric) — preserve it, never push toward solid.",
    edgeSharpnessBias: -0.7,
    recommendHairRefinement: false,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 0.8,
    smoothingRadiusMultiplier: 0.4,
    flagForManualReview: false,
  },
  [EdgeCategory.MotionBlur]: {
    rationale: "Directional smear from subject/camera motion — preserve the wide transition; sharpening it fabricates detail that isn't there.",
    edgeSharpnessBias: -0.6,
    recommendHairRefinement: false,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 0.85,
    smoothingRadiusMultiplier: 0.7,
    flagForManualReview: false,
  },
  [EdgeCategory.Shadow]: {
    rationale: "Likely a shadow cast on/near the background, not subject material — do not auto-resolve to solid foreground.",
    edgeSharpnessBias: -0.3,
    recommendHairRefinement: false,
    maxAutoAlpha: 0.55,
    decontaminationStrengthMultiplier: 0.5,
    smoothingRadiusMultiplier: 0.8,
    flagForManualReview: false,
  },
  [EdgeCategory.Reflection]: {
    rationale: "Possible reflection of the subject on a nearby surface — treat cautiously, flag rather than auto-resolve confidently.",
    edgeSharpnessBias: -0.3,
    recommendHairRefinement: false,
    maxAutoAlpha: 0.65,
    decontaminationStrengthMultiplier: 0.4,
    smoothingRadiusMultiplier: 0.8,
    flagForManualReview: true,
  },
  [EdgeCategory.Uncertain]: {
    rationale: "No cue was confidently dominant — trigger stronger refinement or manual review rather than guessing.",
    edgeSharpnessBias: 0,
    recommendHairRefinement: false,
    maxAutoAlpha: 1,
    decontaminationStrengthMultiplier: 0.75,
    smoothingRadiusMultiplier: 1,
    flagForManualReview: true,
  },
};

/** Pure lookup — the same category always yields the same guidance, independent of which classifier produced it. */
export function getEdgeRefinementGuidance(category: EdgeCategory): EdgeRefinementGuidance {
  return GUIDANCE[category];
}
