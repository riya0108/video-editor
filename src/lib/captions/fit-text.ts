let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Lazily creates one offscreen canvas 2D context, reused for every measurement — cheap and avoids allocating a canvas per call. */
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/**
 * The largest font size at or below `fontSize` for which `text`, rendered
 * with `fontSpec(size)`, measures no wider than `maxWidthPx` — never scales
 * up. Used to keep a single oversized word/line (the Blockbuster caption
 * style's giant emphasis word, in particular) from running off the edge of
 * the frame instead of shrinking to fit it, in both the live preview
 * (CaptionOverlay) and the burned-in export (build-captions-filter).
 *
 * Text width scales close enough to linearly with font size for one
 * measurement + ratio to land within a pixel or two of the true fit — no
 * need for a binary search.
 */
export function fitFontSizeToWidth(
  text: string,
  fontSize: number,
  maxWidthPx: number,
  fontSpec: (size: number) => string,
): number {
  const ctx = getMeasureCtx();
  if (!ctx || !text || !Number.isFinite(maxWidthPx) || maxWidthPx <= 0) return fontSize;
  ctx.font = fontSpec(fontSize);
  const width = ctx.measureText(text).width;
  if (width <= maxWidthPx || width === 0) return fontSize;
  return Math.max(1, Math.floor(fontSize * (maxWidthPx / width)));
}
