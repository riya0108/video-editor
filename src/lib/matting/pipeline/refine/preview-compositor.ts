import { TrimapLabel } from "./trimap";
import type { DirtyRegion } from "./manual-refinement-engine";

/**
 * MANUAL MATTE REFINEMENT (Phase 6) / MATTE PREVIEW SYSTEM (Phase 11). Pure
 * pixel compositing for every preview mode this app's matting tools need:
 * the original source, a transparent checkerboard, solid black/white/gray/
 * custom backgrounds, a high-contrast diagnostic backdrop (for spotting
 * colour fringing a neutral background would hide), matte-only (the raw
 * alpha as a grayscale image), and a false-colour alpha visualization — plus
 * an edge-uncertainty diagnostic view. No DOM/canvas code here — this
 * produces plain RGBA buffers; a canvas layer just blits them. Every
 * function accepts an optional `region` (the same DirtyRegion shape
 * ManualRefinementEngine.applyStroke returns) and, when given one, allocates
 * and fills only that sub-rectangle.
 *
 * Phase 11's own requirement — "do not re-run the ML model when only the
 * preview background changes" / "separate MATTE GENERATION from
 * COMPOSITING" / "a generated matte should be reusable across multiple
 * background previews" — is why this file has never taken a model,
 * MattingModel, or router dependency at any point: every function here is a
 * pure, cheap pixel transform over an alpha/rgba pair a caller already has.
 * See matte-preview-engine.ts for the stateful wrapper that holds a
 * generated matte once and re-composites it across modes on demand.
 */
export const enum PreviewBackgroundMode {
  /** Straight RGBA with the real alpha in the 4th channel — for a canvas context that itself understands transparency. */
  Transparent = 0,
  Checkerboard = 1,
  Black = 2,
  White = 3,
  /** The unmodified source image — alpha/matte ignored entirely, a direct "what did this look like before extraction" reference. */
  Original = 4,
  Gray = 5,
  /** A solid colour (`customColor`) or, when `customBackgroundImage` is supplied, an arbitrary background image sampled under the subject. */
  Custom = 6,
  /** A saturated two-colour checker (magenta/green by default) specifically chosen for high contrast against typical subject colours — colour fringing or spill that a neutral checkerboard/gray would hide reads much more clearly against it. A diagnostic aid, not an automated defect detector. */
  HighContrastDiagnostic = 7,
  /** The raw alpha rendered directly as a grayscale image (0 -> black, 1 -> white) — the matte by itself, with no compositing at all. */
  MatteOnly = 8,
  /** A false-colour (blue -> green -> red) rendering of the alpha channel — more perceptually distinguishable gradation than plain grayscale for spotting soft-edge/partial-opacity regions. A fixed, documented colour ramp, not a claim of any particular scientific colormap's accuracy. */
  AlphaVisualization = 9,
}

export interface PreviewOptions {
  backgroundMode: PreviewBackgroundMode;
  /** Checkerboard square size, in image pixels. */
  checkerSize: number;
  checkerLight: [number, number, number];
  checkerDark: [number, number, number];
  grayColor: [number, number, number];
  /** Used by Custom mode when `customBackgroundImage` isn't supplied. */
  customColor: [number, number, number];
  /** Used by Custom mode when supplied — sampled with simple nearest-neighbor clamping if its dimensions differ from the subject's, not resampled/scaled. */
  customBackgroundImage: { rgba: Uint8ClampedArray; width: number; height: number } | null;
  diagnosticColorA: [number, number, number];
  diagnosticColorB: [number, number, number];
  diagnosticCheckerSize: number;
}

export const DEFAULT_PREVIEW_OPTIONS: PreviewOptions = {
  backgroundMode: PreviewBackgroundMode.Checkerboard,
  checkerSize: 8,
  checkerLight: [255, 255, 255],
  checkerDark: [204, 204, 204],
  grayColor: [128, 128, 128],
  customColor: [255, 105, 180],
  customBackgroundImage: null,
  diagnosticColorA: [255, 0, 255],
  diagnosticColorB: [0, 255, 0],
  diagnosticCheckerSize: 8,
};

/** 0 -> blue, 0.5 -> green, 1 -> red — a fixed, deterministic two-segment colour ramp (documented in PreviewBackgroundMode.AlphaVisualization's own comment). */
function alphaHeatmapColor(a: number): [number, number, number] {
  if (a < 0.5) {
    const t = a / 0.5;
    return [0, Math.round(255 * t), Math.round(255 * (1 - t))];
  }
  const t = (a - 0.5) / 0.5;
  return [Math.round(255 * t), Math.round(255 * (1 - t)), 0];
}

export interface PreviewBuffer {
  rgba: Uint8ClampedArray;
  minX: number;
  minY: number;
  width: number;
  height: number;
}

function resolveRegion(width: number, height: number, region?: DirtyRegion): DirtyRegion {
  return region ?? { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
}

/**
 * Composites `rgba`+`alpha` for on-screen preview per `backgroundMode`.
 * Checkerboard/Black/White all flatten to an opaque result (the backdrop is
 * baked into the RGB, alpha channel set to 255) — the standard way image
 * editors render a "what does the transparency look like" preview onto an
 * ordinary opaque canvas. Transparent and Original pass real/no alpha
 * through unchanged, respectively.
 */
export function compositePreview(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
  options: Partial<PreviewOptions> = {},
  region?: DirtyRegion,
): PreviewBuffer {
  const o = { ...DEFAULT_PREVIEW_OPTIONS, ...options };
  const r = resolveRegion(width, height, region);
  const w = r.maxX - r.minX + 1;
  const h = r.maxY - r.minY + 1;
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gi = (r.minY + y) * width + (r.minX + x);
      const go = gi * 4;
      const lo = (y * w + x) * 4;

      if (o.backgroundMode === PreviewBackgroundMode.Original) {
        out[lo] = rgba[go];
        out[lo + 1] = rgba[go + 1];
        out[lo + 2] = rgba[go + 2];
        out[lo + 3] = 255;
        continue;
      }
      if (o.backgroundMode === PreviewBackgroundMode.Transparent) {
        out[lo] = rgba[go];
        out[lo + 1] = rgba[go + 1];
        out[lo + 2] = rgba[go + 2];
        out[lo + 3] = Math.round(Math.min(1, Math.max(0, alpha[gi])) * 255);
        continue;
      }
      if (o.backgroundMode === PreviewBackgroundMode.MatteOnly) {
        const v = Math.round(Math.min(1, Math.max(0, alpha[gi])) * 255);
        out[lo] = v;
        out[lo + 1] = v;
        out[lo + 2] = v;
        out[lo + 3] = 255;
        continue;
      }
      if (o.backgroundMode === PreviewBackgroundMode.AlphaVisualization) {
        const [hr, hg, hb] = alphaHeatmapColor(Math.min(1, Math.max(0, alpha[gi])));
        out[lo] = hr;
        out[lo + 1] = hg;
        out[lo + 2] = hb;
        out[lo + 3] = 255;
        continue;
      }

      const gx = r.minX + x;
      const gy = r.minY + y;
      let bg: [number, number, number];
      if (o.backgroundMode === PreviewBackgroundMode.Black) bg = [0, 0, 0];
      else if (o.backgroundMode === PreviewBackgroundMode.White) bg = [255, 255, 255];
      else if (o.backgroundMode === PreviewBackgroundMode.Gray) bg = o.grayColor;
      else if (o.backgroundMode === PreviewBackgroundMode.Custom) {
        if (o.customBackgroundImage) {
          const img = o.customBackgroundImage;
          const ix = Math.min(img.width - 1, gx);
          const iy = Math.min(img.height - 1, gy);
          const io = (iy * img.width + ix) * 4;
          bg = [img.rgba[io], img.rgba[io + 1], img.rgba[io + 2]];
        } else {
          bg = o.customColor;
        }
      } else if (o.backgroundMode === PreviewBackgroundMode.HighContrastDiagnostic) {
        const checker = (Math.floor(gx / o.diagnosticCheckerSize) + Math.floor(gy / o.diagnosticCheckerSize)) % 2 === 0;
        bg = checker ? o.diagnosticColorA : o.diagnosticColorB;
      } else {
        const checker = (Math.floor(gx / o.checkerSize) + Math.floor(gy / o.checkerSize)) % 2 === 0;
        bg = checker ? o.checkerLight : o.checkerDark;
      }

      const a = Math.min(1, Math.max(0, alpha[gi]));
      out[lo] = Math.round(rgba[go] * a + bg[0] * (1 - a));
      out[lo + 1] = Math.round(rgba[go + 1] * a + bg[1] * (1 - a));
      out[lo + 2] = Math.round(rgba[go + 2] * a + bg[2] * (1 - a));
      out[lo + 3] = 255;
    }
  }

  return { rgba: out, minX: r.minX, minY: r.minY, width: w, height: h };
}

export interface EdgePreviewOptions {
  /** Colour used to highlight the trimap UNKNOWN band. */
  highlightColor: [number, number, number];
  /** How strongly the highlight is blended in over the UNKNOWN band (0-1). */
  highlightStrength: number;
  /** How much non-UNKNOWN pixels are dimmed, to make the highlighted band stand out (0 = no dimming, 1 = fully black). */
  dimOthers: number;
}

export const DEFAULT_EDGE_PREVIEW_OPTIONS: EdgePreviewOptions = {
  highlightColor: [255, 96, 0],
  highlightStrength: 0.55,
  dimOthers: 0.35,
};

/** Visualizes where the matte is uncertain — the trimap's UNKNOWN band, tinted, over a dimmed copy of the source image. A diagnostic/painting-aid view, not a claim about ground truth. */
export function renderEdgePreview(
  rgba: Uint8ClampedArray,
  trimap: Uint8Array,
  width: number,
  height: number,
  options: Partial<EdgePreviewOptions> = {},
  region?: DirtyRegion,
): PreviewBuffer {
  const o = { ...DEFAULT_EDGE_PREVIEW_OPTIONS, ...options };
  const r = resolveRegion(width, height, region);
  const w = r.maxX - r.minX + 1;
  const h = r.maxY - r.minY + 1;
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gi = (r.minY + y) * width + (r.minX + x);
      const go = gi * 4;
      const lo = (y * w + x) * 4;

      if (trimap[gi] === TrimapLabel.Unknown) {
        const s = o.highlightStrength;
        out[lo] = Math.round(rgba[go] * (1 - s) + o.highlightColor[0] * s);
        out[lo + 1] = Math.round(rgba[go + 1] * (1 - s) + o.highlightColor[1] * s);
        out[lo + 2] = Math.round(rgba[go + 2] * (1 - s) + o.highlightColor[2] * s);
      } else {
        const d = 1 - o.dimOthers;
        out[lo] = Math.round(rgba[go] * d);
        out[lo + 1] = Math.round(rgba[go + 1] * d);
        out[lo + 2] = Math.round(rgba[go + 2] * d);
      }
      out[lo + 3] = 255;
    }
  }

  return { rgba: out, minX: r.minX, minY: r.minY, width: w, height: h };
}
