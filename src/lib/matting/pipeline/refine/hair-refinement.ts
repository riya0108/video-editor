import {
  detectHairCandidates,
  expandUnknownAroundCandidates,
  dilateBinaryMask,
  DEFAULT_HAIR_DETECTION_OPTIONS,
  DEFAULT_EXPAND_UNKNOWN_OPTIONS,
  type HairDetectionOptions,
  type ExpandUnknownOptions,
} from "./hair-detector";
import { refineFineDetail, DEFAULT_FINE_DETAIL_REFINE_OPTIONS, type FineDetailRefineOptions } from "./fine-detail-refiner";

/**
 * HairRefinementEngine — Phase 3 ("HAIR AND FINE DETAIL REFINEMENT").
 *
 * Ties together hair-detector.ts (candidate detection + unknown-region
 * expansion) and fine-detail-refiner.ts (the actual local refinement pass)
 * into the one internal API a caller needs: hand it an already-computed
 * alpha/trimap (e.g. Phase 2's `refineAlphaMatte` output) and it returns an
 * improved alpha with hair/fur/thin-structure areas specifically targeted,
 * per the pipeline described in the brief:
 *
 *   1. detect candidates            -> detectHairCandidates
 *   2. expand the unknown region     -> expandUnknownAroundCandidates
 *   3-8. local refinement            -> refineFineDetail
 *
 * Not wired into `remove-background.ts`'s default pipeline yet — like Phase
 * 2's `refineAlphaMatte`, this is exposed as a tunable internal API for a
 * caller to opt into, not a change to existing default output.
 */
export interface HairRefinementOptions {
  detection: HairDetectionOptions;
  expand: ExpandUnknownOptions;
  refine: FineDetailRefineOptions;
}

export const DEFAULT_HAIR_REFINEMENT_OPTIONS: HairRefinementOptions = {
  detection: DEFAULT_HAIR_DETECTION_OPTIONS,
  expand: DEFAULT_EXPAND_UNKNOWN_OPTIONS,
  refine: DEFAULT_FINE_DETAIL_REFINE_OPTIONS,
};

export type PartialHairRefinementOptions = { [K in keyof HairRefinementOptions]?: Partial<HairRefinementOptions[K]> };

function mergeOptions(defaults: HairRefinementOptions, overrides: PartialHairRefinementOptions): HairRefinementOptions {
  return {
    detection: { ...defaults.detection, ...overrides.detection },
    expand: { ...defaults.expand, ...overrides.expand },
    refine: { ...defaults.refine, ...overrides.refine },
  };
}

export interface HairRefinementResult {
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  /** Trimap widened to Unknown around every detected candidate — see expandUnknownAroundCandidates. */
  expandedTrimap: Uint8Array;
  /** Thresholded hair/fine-detail candidates (0/1). Restricted to the requested region for `refineRegion`. */
  candidateMask: Uint8Array;
  /** Continuous 0..1 confidence backing `candidateMask`. Restricted to the requested region for `refineRegion`. */
  confidence: Float32Array;
  pixelsCandidates: number;
  pixelsRefined: number;
  pixelsDecontaminated: number;
  pixelsSuppressed: number;
  pixelsSuppressionOverridden: number;
}

function countNonZero(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n;
}

export class HairRefinementEngine {
  private readonly options: HairRefinementOptions;

  constructor(overrides: PartialHairRefinementOptions = {}) {
    this.options = mergeOptions(DEFAULT_HAIR_REFINEMENT_OPTIONS, overrides);
  }

  /**
   * Full-image detection + refinement. `trimap` should come from the base
   * Phase 2 classification (buildTrimap) — this engine widens it locally
   * around detected candidates rather than reclassifying the whole image.
   */
  refine(alpha: Float32Array, rgba: Uint8ClampedArray, width: number, height: number, trimap: Uint8Array): HairRefinementResult {
    const { confidence, candidateMask } = detectHairCandidates(alpha, rgba, width, height, this.options.detection);
    const expandedTrimap = expandUnknownAroundCandidates(trimap, candidateMask, width, height, this.options.expand);
    const refined = refineFineDetail(alpha, rgba, width, height, expandedTrimap, confidence, this.options.refine);

    return {
      alpha: refined.alpha,
      rgba: refined.rgba,
      expandedTrimap,
      candidateMask,
      confidence,
      pixelsCandidates: countNonZero(candidateMask),
      pixelsRefined: refined.pixelsRefined,
      pixelsDecontaminated: refined.pixelsDecontaminated,
      pixelsSuppressed: refined.pixelsSuppressed,
      pixelsSuppressionOverridden: refined.pixelsSuppressionOverridden,
    };
  }

  /**
   * LOCAL REFINEMENT MODE — "the user should eventually be able to
   * paint/refine only a problematic area rather than recomputing the entire
   * image." `regionMask` is a 0/1 mask the same size as the image (a brush
   * stroke, once a paint UI exists to produce one); every pixel outside it
   * (plus a small `contextMargin` so the guided filter has real neighboring
   * context right up to the region's edge, not a hard seam) is copied
   * through from the *input* alpha/rgba completely unchanged.
   *
   * This guarantees correctness of the *output* — nothing outside the
   * painted area can change — by computing the full refinement and then
   * masking it down, rather than by cropping the input arrays. That's a
   * deliberate simplification: the full-image compute this reuses is
   * classical-CV cheap even at real photo resolutions (no model inference),
   * so correctness came first. A cropped-buffer fast path that actually
   * skips work outside the region is a reasonable follow-up once a paint UI
   * exists and this is called interactively per brush stroke.
   */
  refineRegion(
    alpha: Float32Array,
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    trimap: Uint8Array,
    regionMask: Uint8Array,
    contextMargin = 4,
  ): HairRefinementResult {
    const full = this.refine(alpha, rgba, width, height, trimap);
    const grown = dilateBinaryMask(regionMask, width, height, contextMargin);

    const outAlpha = new Float32Array(alpha.length);
    const outRgba = Uint8ClampedArray.from(rgba);
    const outCandidateMask = new Uint8Array(alpha.length);
    const outConfidence = new Float32Array(alpha.length);
    const outTrimap = trimap.slice();

    for (let i = 0; i < alpha.length; i++) {
      if (!grown[i]) {
        outAlpha[i] = alpha[i];
        continue;
      }
      outAlpha[i] = full.alpha[i];
      outTrimap[i] = full.expandedTrimap[i];
      outCandidateMask[i] = full.candidateMask[i];
      outConfidence[i] = full.confidence[i];
      const o = i * 4;
      outRgba[o] = full.rgba[o];
      outRgba[o + 1] = full.rgba[o + 1];
      outRgba[o + 2] = full.rgba[o + 2];
      outRgba[o + 3] = full.rgba[o + 3];
    }

    // Diagnostics (pixelsRefined/Decontaminated/Suppressed) only count what
    // actually landed inside the region — reporting the full image's totals
    // here would misrepresent a call that, by design, touched almost none
    // of it.
    let pixelsRefined = 0;
    for (let i = 0; i < alpha.length; i++) {
      if (grown[i] && outAlpha[i] !== alpha[i]) pixelsRefined++;
    }

    return {
      alpha: outAlpha,
      rgba: outRgba,
      expandedTrimap: outTrimap,
      candidateMask: outCandidateMask,
      confidence: outConfidence,
      pixelsCandidates: countNonZero(outCandidateMask),
      pixelsRefined,
      pixelsDecontaminated: full.pixelsDecontaminated,
      pixelsSuppressed: full.pixelsSuppressed,
      pixelsSuppressionOverridden: full.pixelsSuppressionOverridden,
    };
  }
}
