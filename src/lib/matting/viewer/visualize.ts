/**
 * MATTE COMPARISON VIEWER — pure, DOM-free pixel-buffer functions for the
 * viewer's non-trivial view modes. Diagnostic-only: nothing here is called
 * by, or changes the output of, the production pipeline
 * (`src/lib/matting/pipeline/**`) — it only visualizes an already-computed
 * `MattingResult`. "Original", "AI Result" (transparent), and the two
 * solid-color composites reuse existing pipeline exports directly
 * (`compositeTransparentForeground` in `../pipeline/dom-io.ts`) rather than
 * duplicating that logic — the four functions below are exactly the ones
 * that don't already exist anywhere: a grayscale alpha view, a checkerboard-
 * baked composite (distinct from the CSS `bg-checkerboard` backdrop used
 * behind a still-transparent view), and a ground-truth-free edge diagnostic.
 */

/** Grayscale rendering of the raw alpha channel: 0 (transparent) -> black, 1 (opaque) -> white. Same convention the matte-quality-benchmark's own export used. */
export function alphaToGrayscaleRgba(alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(Math.min(1, Math.max(0, alpha[i])) * 255);
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

/** Composites the foreground (rgba, alpha) over a solid opaque backdrop color — real alpha blending, not a CSS trick, since this is meant to be a baked reference view. Covers both "Black Composite" and "White Composite". */
export function compositeOverSolidColor(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
  color: [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const [br, bg, bb] = color;
  for (let i = 0; i < width * height; i++) {
    const a = Math.min(1, Math.max(0, alpha[i]));
    const o = i * 4;
    out[o] = rgba[o] * a + br * (1 - a);
    out[o + 1] = rgba[o + 1] * a + bg * (1 - a);
    out[o + 2] = rgba[o + 2] * a + bb * (1 - a);
    out[o + 3] = 255;
  }
  return out;
}

/** Same two neutral grays and 16px tile size as this app's own `.bg-checkerboard` CSS class (`src/styles/global.css`) — an axis-aligned checkerboard rather than that class's diagonal-gradient trick (visually equivalent as a transparency indicator, simpler to bake per-pixel). */
const CHECKER_LIGHT: [number, number, number] = [0xf3, 0xf4, 0xf6];
const CHECKER_DARK: [number, number, number] = [0xd1, 0xd5, 0xdb];
const CHECKER_TILE_PX = 16;

/** Composites the foreground over a baked, opaque checkerboard pattern — a fully rendered reference view, distinct from the "AI Result" view's own transparent canvas shown over a live CSS checkerboard backdrop. */
export function compositeOverCheckerboard(rgba: Uint8ClampedArray, alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = Math.min(1, Math.max(0, alpha[i]));
      const tileOn = (Math.floor(x / CHECKER_TILE_PX) + Math.floor(y / CHECKER_TILE_PX)) % 2 === 0;
      const [br, bg, bb] = tileOn ? CHECKER_LIGHT : CHECKER_DARK;
      const o = i * 4;
      out[o] = rgba[o] * a + br * (1 - a);
      out[o + 1] = rgba[o + 1] * a + bg * (1 - a);
      out[o + 2] = rgba[o + 2] * a + bb * (1 - a);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * "Edge diagnostic" for a REAL upload — there is no ground truth to compare
 * against here (unlike the matte-quality-benchmark's own edge diagnostic,
 * which compares predicted vs. ground-truth alpha). This is a different,
 * honest, ground-truth-free diagnostic instead: a Sobel gradient-magnitude
 * heatmap of the alpha channel itself — the same boundary-detection math
 * `quality-metrics.ts`'s `edgeGradientEnergy` already computes internally,
 * just visualized per-pixel instead of aggregated to one scalar. Bright =
 * a sharp/rapid alpha transition (a hard edge); dark = a flat region or a
 * genuinely soft, gradual transition. Grayscale intensity is the raw
 * gradient magnitude normalized to this specific image's own observed max
 * (so the heatmap is always legible regardless of overall edge sharpness),
 * not a fixed absolute scale.
 */
export function computeAlphaEdgeHeatmap(alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (width < 3 || height < 3) return out;

  // Same 3x3 Sobel kernel used elsewhere in this codebase for boundary
  // detection (hair-detector.ts's computeColorGradientEnergy,
  // quality-benchmark/metrics.ts's sobelMagnitude) — applied to alpha
  // instead of luminance/predicted-vs-ground-truth.
  const gxKernel = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gyKernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const magnitude = new Float32Array(width * height);
  let maxMagnitude = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sx = 0;
      let sy = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = alpha[(y + dy) * width + (x + dx)];
          sx += v * gxKernel[k];
          sy += v * gyKernel[k];
          k++;
        }
      }
      const i = y * width + x;
      const m = Math.sqrt(sx * sx + sy * sy);
      magnitude[i] = m;
      if (m > maxMagnitude) maxMagnitude = m;
    }
  }

  const scale = maxMagnitude > 0 ? 255 / maxMagnitude : 0;
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(magnitude[i] * scale);
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

export type ImageViewMode = "original" | "ai-result" | "alpha" | "black" | "white" | "checkerboard" | "edge";

export const IMAGE_VIEW_MODES: { id: ImageViewMode; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "ai-result", label: "AI Result" },
  { id: "alpha", label: "Alpha Matte" },
  { id: "black", label: "Black Composite" },
  { id: "white", label: "White Composite" },
  { id: "checkerboard", label: "Checkerboard Composite" },
  { id: "edge", label: "Edge Diagnostic" },
];

/**
 * Computes the pixel buffer for every view mode EXCEPT "original" (the
 * caller already has the source rgba for that) and "ai-result" (rendered
 * directly from `MattingResult.foreground`, a real transparent canvas, via
 * `ComparisonCanvas`'s own transparent-background rendering path — baking
 * it to an opaque buffer here would lose the transparency the view is
 * specifically meant to show).
 */
export function computeViewBuffer(
  mode: Exclude<ImageViewMode, "original" | "ai-result">,
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  switch (mode) {
    case "alpha":
      return alphaToGrayscaleRgba(alpha, width, height);
    case "black":
      return compositeOverSolidColor(rgba, alpha, width, height, [0, 0, 0]);
    case "white":
      return compositeOverSolidColor(rgba, alpha, width, height, [255, 255, 255]);
    case "checkerboard":
      return compositeOverCheckerboard(rgba, alpha, width, height);
    case "edge":
      return computeAlphaEdgeHeatmap(alpha, width, height);
  }
}
