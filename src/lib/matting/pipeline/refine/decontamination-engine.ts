import { estimateLocalBackground, DEFAULT_DECONTAMINATE_OPTIONS, type DecontaminateOptions } from "../decontaminate";
import { TrimapLabel } from "./trimap";

/**
 * ColourDecontaminationEngine — Phase 4 ("FOREGROUND COLOUR
 * DECONTAMINATION"). Builds on the closed-form unmixing math in
 * decontaminate.ts (Phase 1) with a dedicated safeguard layer purpose-built
 * for the artifacts a naive application of that math can produce:
 *
 *   - green background -> green hair fringe
 *   - blue background -> blue clothing edge
 *   - bright background -> light halo
 *
 * Unlike decontaminate.ts, this engine NEVER touches alpha — it is strictly
 * a colour-only transform ("respect alpha values": alpha is read as
 * immutable context, not corrected). Where decontaminate.ts's own
 * "indistinguishable from background" case zeroes alpha, this engine's
 * equivalent case just leaves the observed colour alone.
 *
 * Requirements 1-8 from the brief map onto this module as follows:
 *   1. detect likely contaminated edge pixels -> gating, see `gated` below
 *      (a caller-supplied trimap's UNKNOWN band when available — including
 *      one Phase 3's expandUnknownAroundCandidates already widened — or
 *      decontaminate.ts's own alpha-band gate as a fallback).
 *   2. estimate foreground colour -> reuses decontaminate.ts's closed-form
 *      unmixing (estimateLocalBackground + the same per-channel formula).
 *   3. reduce background colour spill -> the corrected colour blend below.
 *   4. preserve natural subject colour / 8. never destroy genuine
 *      foreground colour -> a pixel with no nearby background sample, or
 *      whose estimate is indistinguishable from the background, is left
 *      completely unchanged rather than guessed at.
 *   5. avoid desaturating the entire subject -> requirement 1's gating IS
 *      this safeguard: pixels outside the uncertain edge band are never
 *      touched at all, by construction, regardless of `strength`.
 *   6. operate primarily around uncertain edge regions -> gating, plus a
 *      parabolic alpha weighting (peaks at alpha 0.5, fades to 0 at the
 *      band's own edges) so correction strength itself tracks how uncertain
 *      a given pixel's alpha is, with no hard on/off seam.
 *   7. respect alpha values -> alpha is read, never written; the parabolic
 *      weighting above is the concrete way alpha shapes the correction.
 */

export interface DecontaminationOptions {
  /** Global 0 (no-op) .. 1 (full correction) dial — "support adjustable strength internally". */
  strength: number;
  /** The underlying closed-form unmixing's own tuning (search radius, alpha-band thresholds, suppress distance) — see decontaminate.ts. */
  unmix: DecontaminateOptions;
  /** When a trimap is supplied, gate on TrimapLabel.Unknown rather than the (potentially narrower) raw alpha-band test. */
  restrictToTrimapUnknown: boolean;
  /**
   * Per-channel overshoot (0-255 scale) the *raw*, pre-clamp closed-form
   * estimate is allowed before its correction strength is derated —
   * safeguard against dark and white halos. A small overshoot is normal
   * rounding slack; a large one means the linear blend model has no
   * reliable signal at this pixel (noise, a slightly-off alpha estimate)
   * and clamping it in unquestioningly would paint an artificial dark or
   * white ring instead of leaving the ambiguous pixel alone.
   */
  maxPlausibleOvershoot: number;
  /** Fraction (0-1) of the observed colour's own saturation the correction is allowed to remove before being derated — safeguard against over-desaturation at individual edge pixels (distinct from requirement 5's *spatial* gating, which prevents it across the whole subject). */
  maxSaturationLoss: number;
  /** A saturated, single-channel-dominant local background (the classic green/blue screen signature) gets a wider overshoot tolerance — safeguard specifically named in the brief ("green-screen contamination"): this is the single most common, well-understood spill source, and the closed-form estimate for it is usually trustworthy even with a larger nominal overshoot. */
  screenLikeOvershootMultiplier: number;
}

export const DEFAULT_DECONTAMINATION_OPTIONS: DecontaminationOptions = {
  strength: 1,
  unmix: DEFAULT_DECONTAMINATE_OPTIONS,
  restrictToTrimapUnknown: true,
  maxPlausibleOvershoot: 80,
  maxSaturationLoss: 0.4,
  screenLikeOvershootMultiplier: 1.5,
};

export interface DecontaminationResult {
  /** Same layout as the input — only the R/G/B bytes of gated pixels ever change; alpha (both the 4th rgba byte and the separate float alpha map) is always identical to the input. */
  rgba: Uint8ClampedArray;
  /** How many pixels were inside the gated (uncertain-edge) region at all. */
  pixelsConsidered: number;
  /** How many of those actually had their colour changed. */
  pixelsCorrected: number;
  /** Gated pixels left unchanged because no nearby background sample existed, or the estimate was indistinguishable from it — requirement 8, "never destroy genuine foreground colour" without real evidence. */
  pixelsNoSignal: number;
  /** How many pixels had their correction strength reduced by the dark/white-halo overshoot safeguard. */
  pixelsHaloGuarded: number;
  /** How many pixels had their correction strength reduced by the over-desaturation safeguard. */
  pixelsSaturationGuarded: number;
  /** How many pixels' local background was classified screen-like (saturated, single-channel-dominant) — surfaced so a caller can confirm the green-screen-specific tolerance actually engaged, not just trust it silently. */
  pixelsScreenLike: number;
}

/** HSV saturation only (0-1) — cheap enough not to need the rest of HSV, and all the over-desaturation safeguard needs. */
export function rgbSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 0 ? 0 : (max - min) / max;
}

/**
 * True when one channel of `rgb` dominates the other two by a wide,
 * deliberate margin — the visual signature of a saturated green/blue screen
 * backdrop (or any strongly single-hued solid background), as opposed to a
 * neutral, skin-tone, or mixed-hue one. Deliberately simple/classical (no
 * model): the same kind of channel-dominance test ffmpeg's own `despill`
 * filter uses (see bg-removal-command.ts's despillTypeFor for the
 * chroma-key path's equivalent).
 */
export function isScreenLikeColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const others = r + g + b - max;
  return max > 80 && max - others / 2 > 50;
}

export class ColourDecontaminationEngine {
  private readonly options: DecontaminationOptions;

  constructor(overrides: Partial<DecontaminationOptions> = {}) {
    this.options = {
      ...DEFAULT_DECONTAMINATION_OPTIONS,
      ...overrides,
      unmix: { ...DEFAULT_DECONTAMINATE_OPTIONS, ...overrides.unmix },
    };
  }

  /**
   * `trimap` is optional — when provided (e.g. Phase 2's buildTrimap, or a
   * Phase 3-expanded one), it takes priority over the raw alpha-band gate
   * for deciding *which* pixels count as "uncertain edge region" per
   * requirement 6. `alpha` is only ever read.
   */
  process(rgba: Uint8ClampedArray, alpha: Float32Array, width: number, height: number, trimap: Uint8Array | null = null): DecontaminationResult {
    const { unmix, strength: globalStrength, maxPlausibleOvershoot, maxSaturationLoss, screenLikeOvershootMultiplier, restrictToTrimapUnknown } =
      this.options;
    const out = Uint8ClampedArray.from(rgba);

    let pixelsConsidered = 0;
    let pixelsCorrected = 0;
    let pixelsNoSignal = 0;
    let pixelsHaloGuarded = 0;
    let pixelsSaturationGuarded = 0;
    let pixelsScreenLike = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const a = alpha[i];

        const inAlphaBand = a > unmix.loThreshold && a < unmix.hiThreshold;
        const gated = trimap && restrictToTrimapUnknown ? trimap[i] === TrimapLabel.Unknown : inAlphaBand;
        if (!gated) continue;
        pixelsConsidered++;

        const o = i * 4;
        const observedR = rgba[o];
        const observedG = rgba[o + 1];
        const observedB = rgba[o + 2];

        const bg = estimateLocalBackground(rgba, alpha, x, y, width, height, unmix.loThreshold, unmix.searchRadius);
        if (!bg) {
          pixelsNoSignal++;
          continue;
        }

        const screenLike = isScreenLikeColor(bg[0], bg[1], bg[2]);
        if (screenLike) pixelsScreenLike++;
        const overshootTolerance = screenLike ? maxPlausibleOvershoot * screenLikeOvershootMultiplier : maxPlausibleOvershoot;

        // Raw (unclamped) closed-form estimate — see decontaminate.ts for
        // the derivation. How far this sits outside [0,255] before
        // clamping is the dark/white-halo tell (module doc comment).
        const rawR = (observedR - (1 - a) * bg[0]) / a;
        const rawG = (observedG - (1 - a) * bg[1]) / a;
        const rawB = (observedB - (1 - a) * bg[2]) / a;
        const overshoot = Math.max(
          0,
          -rawR,
          rawR - 255,
          -rawG,
          rawG - 255,
          -rawB,
          rawB - 255,
        );

        const clampedR = Math.min(255, Math.max(0, Math.round(rawR)));
        const clampedG = Math.min(255, Math.max(0, Math.round(rawG)));
        const clampedB = Math.min(255, Math.max(0, Math.round(rawB)));

        const dr = clampedR - bg[0];
        const dg = clampedG - bg[1];
        const db = clampedB - bg[2];
        const distanceFromBackground = Math.sqrt(dr * dr + dg * dg + db * db);
        if (distanceFromBackground < unmix.suppressDistance) {
          pixelsNoSignal++;
          continue; // indistinguishable from background — no real foreground signal to preserve, so leave the observed colour as-is (colour-only equivalent of decontaminate.ts's alpha suppression).
        }

        // Requirement 6/7: weight by how uncertain THIS pixel's own alpha
        // is, peaking at 0.5 and fading to 0 at the gated band's edges —
        // avoids a hard on/off seam (a colour-bleeding safeguard) and
        // avoids ever applying much correction right at the edge of the
        // gate, where the classification itself is least confident.
        let effectiveStrength = globalStrength * 4 * a * (1 - a);

        if (overshoot > overshootTolerance) {
          effectiveStrength *= overshootTolerance / overshoot;
          pixelsHaloGuarded++;
        }

        const observedSat = rgbSaturation(observedR, observedG, observedB);
        const clampedSat = rgbSaturation(clampedR, clampedG, clampedB);
        if (observedSat > 0 && clampedSat < observedSat) {
          const relativeLoss = (observedSat - clampedSat) / observedSat;
          if (relativeLoss > maxSaturationLoss) {
            effectiveStrength *= maxSaturationLoss / relativeLoss;
            pixelsSaturationGuarded++;
          }
        }

        effectiveStrength = Math.min(1, Math.max(0, effectiveStrength));
        if (effectiveStrength <= 0) continue;

        out[o] = Math.round(observedR + (clampedR - observedR) * effectiveStrength);
        out[o + 1] = Math.round(observedG + (clampedG - observedG) * effectiveStrength);
        out[o + 2] = Math.round(observedB + (clampedB - observedB) * effectiveStrength);
        pixelsCorrected++;
      }
    }

    return { rgba: out, pixelsConsidered, pixelsCorrected, pixelsNoSignal, pixelsHaloGuarded, pixelsSaturationGuarded, pixelsScreenLike };
  }
}
