import { supportsImage, supportsVideo, type MattingModel, type MediaKind, type RequestSubjectHint } from "./types";

export interface MatteRequest {
  media: MediaKind;
  /** "unknown" is a legitimate, expected value — see RequestSubjectHint's doc comment in types.ts. The router still returns a reasonable answer for it (see score() below), it just can't award the subject-match bonus. */
  subject: RequestSubjectHint;
  /** True when a clean, subject-free background plate is available for this shot — rare in practice (see MATTE_IMPLEMENTATION_PLAN.md sections 4/21), but required for a BackgroundMattingV2-style model to even be eligible. */
  hasBackgroundPlate?: boolean;
  /**
   * Opt-in escape hatch for a model whose license doesn't clear commercial
   * use by default (e.g. RMBG-1.4 — see MODEL_LICENSES.md). The router
   * trusts the *caller* to have actually secured that license before
   * setting this; it does not and cannot verify that itself. Defaults to
   * false, meaning non-commercial-licensed models are excluded unless asked
   * for explicitly.
   */
  allowNonCommercial?: boolean;
}

export interface RoutedModel {
  model: MattingModel;
  /** True when the chosen model is "segmentation"-class — the caller MUST run this through refinement before treating it as a final matte (MATTE_IMPLEMENTATION_PLAN.md sections 7-9; not implemented in this phase, this just carries the fact forward). This is the mechanism behind "do not use U²-Net as though it were automatically a high-quality alpha matting solution." */
  requiresRefinement: boolean;
  score: number;
  /** Human-readable summary of how this model scored — for debugging/tests, not shown to end users. */
  reason: string;
}

/** Hard filters. A model failing any of these is never selectable, regardless of how well it would otherwise score — eligibility always wins over ranking. */
function isEligible(model: MattingModel, request: MatteRequest): boolean {
  const caps = model.capabilities;
  if (!caps.supportedMedia.includes(request.media)) return false;
  if (request.media === "image" && !supportsImage(model)) return false;
  if (request.media === "video" && !supportsVideo(model)) return false;
  if (caps.requiredInputs.includes("background-plate") && !request.hasBackgroundPlate) return false;
  if (!caps.license.commercialUse) {
    // Copyleft (e.g. GPL-3.0) is a fundamentally different problem than a
    // plain non-commercial license: purchasing a commercial license fixes
    // the latter (see the RMBG-1.4 adapter), but does nothing for the
    // former — integrating the code into this proprietary bundle at all is
    // what's restricted. There is deliberately no opt-in for this case.
    if (caps.license.copyleft) return false;
    if (!request.allowNonCommercial) return false;
  }
  return true;
}

/**
 * Ranks already-eligible models. This — not isEligible — is where "human
 * image -> portrait matting model", "human video -> temporal video matting
 * model", and "general object image -> segmentation/matting pipeline" are
 * actually expressed: a subject-matched model outranks a generic fallback,
 * a "matting"-class model outranks a "segmentation"-class one when both
 * qualify, and a genuinely temporal model outranks a per-frame segmenter on
 * video. None of this is a hard requirement (a segmentation-class model is
 * still eligible and still returned when it's the only option — with
 * requiresRefinement set), it's a preference order.
 */
function score(model: MattingModel, request: MatteRequest): number {
  const caps = model.capabilities;
  let s = 0;
  // request.subject === "unknown" never matches a real SubjectKind — there's
  // nothing to award the match bonus for, honestly, rather than guessing.
  if (request.subject !== "unknown" && caps.supportedSubjects.includes(request.subject)) s += 10;
  else if (caps.supportedSubjects.includes("general")) s += 2; // a general-purpose fallback still beats nothing
  if (caps.modelClass === "matting") s += 5;
  if (request.subject === "known-background" && caps.requiredInputs.includes("background-plate")) s += 20;
  if (request.media === "video" && caps.supportsTemporal) s += 8;
  return s;
}

/**
 * Ranks every eligible model best-first — not just the winner — so a caller
 * (e.g. a future QA-driven retry loop, MATTE_IMPLEMENTATION_PLAN.md section
 * 10, not implemented in this phase) can fall through to the next-best
 * candidate if the top pick's output later fails a quality check.
 */
export function rankModels(models: MattingModel[], request: MatteRequest): RoutedModel[] {
  return models
    .filter((m) => isEligible(m, request))
    .map((m) => {
      const s = score(m, request);
      return {
        model: m,
        requiresRefinement: m.capabilities.modelClass === "segmentation",
        score: s,
        reason: `subject=${request.subject} media=${request.media} modelId=${m.capabilities.modelId} modelClass=${m.capabilities.modelClass} score=${s}`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Picks the single best-fit eligible model for a request, or null if nothing qualifies (e.g. every candidate for "known-background" needs a plate the caller doesn't have, or every candidate for this subject/media is license-gated and the caller didn't opt in). */
export function selectModel(models: MattingModel[], request: MatteRequest): RoutedModel | null {
  return rankModels(models, request)[0] ?? null;
}
