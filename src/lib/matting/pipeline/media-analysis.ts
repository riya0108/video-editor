import type { SubjectKind, RequestSubjectHint } from "../types";

export interface MediaAnalysis {
  width: number;
  height: number;
  aspectRatio: number;
  /** True if the source image already contains non-opaque pixels (e.g. re-processing an existing PNG cutout) — a real, cheap check of the actual pixel data, not a guess. */
  hasExistingAlpha: boolean;
  /**
   * "unknown" unless the caller supplied an explicit hint — see
   * RequestSubjectHint's doc comment in ../types.ts for why this app
   * doesn't pretend to detect the subject on its own yet.
   */
  subjectHint: RequestSubjectHint;
}

/**
 * MEDIA ANALYSIS + SUBJECT DETECTION stages. Pure function over already-
 * extracted pixel data (the caller reads the source image into `rgba` once,
 * via pipeline/dom-io.ts's drawSourceToRgba, and reuses that same buffer for
 * every later stage — this function doesn't touch the DOM itself, which is
 * what makes it unit-testable with a synthetic buffer).
 */
export function analyzeMedia(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  explicitSubjectHint?: SubjectKind,
): MediaAnalysis {
  let hasExistingAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) {
      hasExistingAlpha = true;
      break;
    }
  }

  return {
    width,
    height,
    aspectRatio: width / Math.max(1, height),
    hasExistingAlpha,
    subjectHint: explicitSubjectHint ?? "unknown",
  };
}
