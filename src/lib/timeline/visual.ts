/**
 * VISUAL CLIP PROPERTIES — the per-clip data the composition engine
 * (src/lib/composition/) reads to place a clip on the canvas. Lives in the
 * timeline model (not the composition layer) because these are user edits:
 * they must be undo-tracked, survive split/duplicate, and be serialized with
 * the project exactly like trim points. See COMPOSITION_ARCHITECTURE.md §3.
 *
 * Every spatial value is in COMPOSITION PIXELS (the project's output
 * resolution), never preview/screen pixels — so the same numbers render
 * identically at any preview scale and at final export resolution.
 */

export interface Transform2D {
  /** Composition-pixel position of the anchor point. */
  x: number;
  y: number;
  /** Anchor, normalized 0..1 within the layer's (uncropped) box. 0.5/0.5 = center. Rotation and scale pivot here. */
  anchorX: number;
  anchorY: number;
  /** Multipliers on the fitted box. Must be finite and > 0 — mirroring is flipX/flipY, not a negative scale. */
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise (canvas y-down convention). */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/** Normalized 0..1 insets of the source's intrinsic frame. Cropping CLIPS in place (Premiere-style) — the visible remainder does not move or rescale. */
export interface CropInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Subset of Canvas 2D globalCompositeOperation that has a well-defined meaning for layer blending (and maps 1:1 to the final renderer). */
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "add";

/**
 * How a sized source (video/image) is fitted into the composition before the
 * transform is applied: "contain" letterboxes, "cover" fills and overflows,
 * "fill" stretches, "none" uses native pixel size. Text and shapes always
 * behave as "none" — their size is authored in composition pixels already.
 */
export type FitMode = "contain" | "cover" | "fill" | "none";

/**
 * Alpha matte from a separate source (e.g. a background-removal result),
 * frame-aligned with the clip's own source. Its ALPHA channel multiplies the
 * layer's alpha; `invert` keeps the background instead of the subject.
 */
export interface MatteRef {
  sourceId: string;
  invert: boolean;
}

export interface ClipVisual {
  transform: Transform2D;
  crop: CropInsets;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  fit: FitMode;
  matte?: MatteRef;
}

/** Deep-partial patch accepted by setClipVisual — callers change one field (e.g. rotation) without restating the rest. `matte: null` removes a matte. */
export interface ClipVisualPatch {
  transform?: Partial<Transform2D>;
  crop?: Partial<CropInsets>;
  opacity?: number;
  blendMode?: BlendMode;
  fit?: FitMode;
  matte?: MatteRef | null;
}

export const IDENTITY_TRANSFORM: Readonly<Transform2D> = Object.freeze({
  x: 0,
  y: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
});

export const NO_CROP: Readonly<CropInsets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Default placement: centered in the composition, fitted with "contain". */
export function defaultClipVisual(compWidth: number, compHeight: number): ClipVisual {
  return {
    transform: { ...IDENTITY_TRANSFORM, x: compWidth / 2, y: compHeight / 2 },
    crop: { ...NO_CROP },
    opacity: 1,
    blendMode: "normal",
    fit: "contain",
  };
}

export class InvalidVisualError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVisualError";
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Applies a patch and validates the result. Opacity and crop are CLAMPED
 * (they come from sliders and drags — clamping matches the gesture), but
 * non-finite numbers or a non-positive scale are REJECTED: those are caller
 * bugs that would otherwise produce a singular matrix and an invisible layer.
 */
export function applyVisualPatch(base: ClipVisual, patch: ClipVisualPatch): ClipVisual {
  const transform: Transform2D = { ...base.transform, ...patch.transform };
  for (const key of ["x", "y", "anchorX", "anchorY", "scaleX", "scaleY", "rotation"] as const) {
    if (!Number.isFinite(transform[key])) throw new InvalidVisualError(`transform.${key} must be finite, got ${transform[key]}.`);
  }
  if (transform.scaleX <= 0 || transform.scaleY <= 0) {
    throw new InvalidVisualError(`scale must be > 0 (use flipX/flipY to mirror), got ${transform.scaleX}x${transform.scaleY}.`);
  }

  const rawCrop: CropInsets = { ...base.crop, ...patch.crop };
  for (const key of ["top", "right", "bottom", "left"] as const) {
    if (!Number.isFinite(rawCrop[key])) throw new InvalidVisualError(`crop.${key} must be finite.`);
  }
  const crop = normalizeCrop(rawCrop);

  const opacity = patch.opacity ?? base.opacity;
  if (!Number.isFinite(opacity)) throw new InvalidVisualError("opacity must be finite.");

  const next: ClipVisual = {
    transform,
    crop,
    opacity: clamp01(opacity),
    blendMode: patch.blendMode ?? base.blendMode,
    fit: patch.fit ?? base.fit,
  };
  const matte = patch.matte === undefined ? base.matte : patch.matte ?? undefined;
  if (matte) next.matte = matte;
  return next;
}

/** Leaves at least 1% of the frame visible on each axis — a 100% crop is never what a drag meant, and an empty rect has no hit-test area to grab again. */
export const MIN_VISIBLE_FRACTION = 0.01;

export function normalizeCrop(crop: CropInsets): CropInsets {
  let { top, right, bottom, left } = { top: clamp01(crop.top), right: clamp01(crop.right), bottom: clamp01(crop.bottom), left: clamp01(crop.left) };
  const maxSum = 1 - MIN_VISIBLE_FRACTION;
  if (left + right > maxSum) {
    const k = maxSum / (left + right);
    left *= k;
    right *= k;
  }
  if (top + bottom > maxSum) {
    const k = maxSum / (top + bottom);
    top *= k;
    bottom *= k;
  }
  return { top, right, bottom, left };
}

// ---------------------------------------------------------------------------
// Authored content: text style and shapes
// ---------------------------------------------------------------------------

// Text typography lives in its own module (Phase 6); re-exported here so existing imports keep working.
export { DEFAULT_TEXT_STYLE, normalizeTextStyle, patchTextStyle, scaleTypography, TEXT_LIMITS, type TextStyle, type TextStylePatch } from "./text-style";

// Shapes/SVG graphics live in their own module (Phase 7); re-exported here so existing imports keep working.
export { DEFAULT_SHAPE, normalizeShapeSpec, normalizeSvgSpec, patchShapeSpec, type ShapeSpec, type SvgSpec } from "./shape-style";
