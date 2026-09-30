import { guidedFilterAlpha } from "../guided-filter";
import { decontaminate, DEFAULT_DECONTAMINATE_OPTIONS, type DecontaminateOptions } from "../decontaminate";
import { TrimapLabel } from "./trimap";

/**
 * FINE-DETAIL LOCAL REFINEMENT — the actual quality pass Phase 3 runs over
 * whatever region hair-detector.ts's `expandUnknownAroundCandidates` widened
 * the unknown band to cover. Distinct from edge-refine.ts (which targets a
 * fixed alpha-*value* band) and smoothing-ops.ts's smoothAlpha (which uses
 * the *base* trimap's unknown band) — this one runs over the *expanded*
 * band, so it reaches hair the base trimap was already confident about.
 *
 * Requirements 3-8 from the Phase 3 brief map directly onto this module:
 *   3. higher-quality local matting  -> small-radius guided filter, restricted
 *      to the expanded unknown band (never touches the rest of the image).
 *   4. preserve high-frequency transitions -> the result is a confidence-
 *      weighted blend of the filtered value and the ORIGINAL alpha, not the
 *      filtered value outright — a real strand's own alpha texture survives
 *      instead of being averaged into a flat gradient.
 *   5. remove background colour contamination "where possible" -> reuses
 *      decontaminate.ts (closed-form unmixing, same module the main Phase 1
 *      image pipeline uses), run first so the guided filter's own RGB guide
 *      is already unmixed rather than still colour-contaminated. The brief's
 *      "where possible" qualifier matters here: decontaminate.ts also
 *      suppresses alpha to 0 when it can't distinguish the unmixed
 *      foreground from the local background — a legitimate check for its
 *      original purpose (catching spurious low-confidence background
 *      pixels), but one that fires on EVERY genuinely low-color-contrast
 *      hair pixel too (dark hair on a dark background, light hair on a
 *      light background — exactly two of this module's named test
 *      scenarios), since by definition there's little colour difference to
 *      recover there either. Suppression is overridden back to the pixel's
 *      pre-decontamination alpha wherever the hair detector's *independent*
 *      alpha-structure evidence (not colour) already gave it high
 *      confidence — see `confidenceSuppressionGuard` below.
 *   6. preserve natural strand transparency / 7. avoid artificial solid hair
 *      -> the blend is a plain weighted average in [0,1], never rounded,
 *      thresholded, or pushed toward 0/1 — there is no code path here that
 *      can turn a semi-transparent strand fully opaque or fully transparent
 *      on its own.
 *   8. avoid excessive erosion of thin hair -> this module contains no
 *      hole/island/erosion logic at all (that's cleanup.ts's job, upstream);
 *      it can only ever blend a pixel's value between two already-valid
 *      alpha estimates, never remove it.
 */

export interface FineDetailRefineOptions {
  /** Guided-filter radius for the local pass — kept small (sharpen, don't re-smooth), same philosophy as edge-refine.ts. */
  radius: number;
  eps: number;
  /**
   * How much of a high-confidence pixel's ORIGINAL alpha to keep over the
   * freshly-filtered value, scaled by that pixel's hair-detector confidence
   * (0 = always use the filtered value; 1 = a fully-confident hair pixel
   * keeps its original value untouched). Sits well below 1 by default so
   * refinement still does real work everywhere, while a genuine strand's own
   * fine variation isn't smoothed away just because it happened to fall in
   * the expanded band.
   */
  preserveStrength: number;
  decontaminate: DecontaminateOptions;
  /** Whether to override decontaminate's alpha-suppression when the hair detector already gave the pixel high confidence via independent (non-colour) evidence. See the module doc comment's point 5. */
  protectHighConfidenceFromSuppression: boolean;
  /** Hair-detector confidence (0-1) at or above which a suppressed pixel gets its pre-decontamination alpha restored. */
  confidenceSuppressionGuard: number;
}

export const DEFAULT_FINE_DETAIL_REFINE_OPTIONS: FineDetailRefineOptions = {
  radius: 1,
  eps: 1e-4,
  preserveStrength: 0.6,
  decontaminate: DEFAULT_DECONTAMINATE_OPTIONS,
  protectHighConfidenceFromSuppression: true,
  confidenceSuppressionGuard: 0.5,
};

export interface FineDetailRefineResult {
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  /** How many pixels actually received the local refinement pass (i.e. sat in `expandedTrimap`'s unknown band). */
  pixelsRefined: number;
  pixelsDecontaminated: number;
  pixelsSuppressed: number;
  /** How many of `pixelsSuppressed` were reversed by the high-confidence guard above — surfaced so a caller can see this actually fired, not just trust it silently. */
  pixelsSuppressionOverridden: number;
}

/**
 * Runs colour decontamination followed by a confidence-weighted local
 * guided-filter pass, restricted to `expandedTrimap`'s unknown band. Every
 * pixel outside that band is copied through from `decontaminate`'s output
 * (post suppression-guard — see above) completely unchanged (still
 * non-destructive to the *input* alpha/rgba — neither is mutated, only
 * read).
 */
export function refineFineDetail(
  alpha: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  expandedTrimap: Uint8Array,
  confidence: Float32Array,
  options: FineDetailRefineOptions = DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
): FineDetailRefineResult {
  const decon = decontaminate(rgba, alpha, width, height, options.decontaminate);

  const protectedAlpha = new Float32Array(alpha.length);
  let pixelsSuppressionOverridden = 0;
  for (let i = 0; i < alpha.length; i++) {
    const wasSuppressed = decon.alpha[i] === 0 && alpha[i] > 0;
    if (wasSuppressed && options.protectHighConfidenceFromSuppression && confidence[i] >= options.confidenceSuppressionGuard) {
      protectedAlpha[i] = alpha[i];
      pixelsSuppressionOverridden++;
    } else {
      protectedAlpha[i] = decon.alpha[i];
    }
  }

  const filtered = guidedFilterAlpha(protectedAlpha, decon.rgba, width, height, options.radius, options.eps);

  const outAlpha = new Float32Array(alpha.length);
  let pixelsRefined = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (expandedTrimap[i] !== TrimapLabel.Unknown) {
      outAlpha[i] = protectedAlpha[i];
      continue;
    }
    const preserve = Math.min(1, Math.max(0, confidence[i])) * options.preserveStrength;
    outAlpha[i] = preserve * protectedAlpha[i] + (1 - preserve) * filtered[i];
    pixelsRefined++;
  }

  return {
    alpha: outAlpha,
    rgba: decon.rgba,
    pixelsRefined,
    pixelsDecontaminated: decon.pixelsDecontaminated,
    pixelsSuppressed: decon.pixelsSuppressed,
    pixelsSuppressionOverridden,
  };
}
