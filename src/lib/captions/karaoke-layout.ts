import { INLINE_EMPHASIS_SCALE, pickEmphasisIndex } from "./emphasis";
import type { CaptionCue, CaptionStyle } from "./types";

export interface WordLayout {
  text: string;
  /** Pixel x offset from the left edge of the video frame. */
  x: number;
  width: number;
}

/**
 * Pre-measures where each word in a (single-line) cue will land once
 * centered, so per-word highlight overlays can be positioned with fixed
 * pixel coordinates in the ffmpeg filter graph — drawtext itself has no way
 * to ask "where did word 3 of this line end up". Canvas text metrics are a
 * close but not pixel-perfect stand-in for ffmpeg/freetype's own shaping of
 * the same typeface, which is an accepted approximation here.
 *
 * When `style.emphasizeKeyword` is on with "inline" layout (Interlock), the
 * singled-out word renders much bigger and (optionally) in a different font
 * than the rest — measuring it at the base size would under-count its true
 * width and push every following word's x offset left into it, so it's
 * measured with `emphasisCssFontFamily`/`INLINE_EMPHASIS_SCALE` to match
 * exactly what build-captions-filter.ts actually draws.
 */
export async function measureKaraokeLayouts(
  cues: CaptionCue[],
  style: CaptionStyle,
  cssFontFamily: string,
  videoWidth: number,
  emphasisCssFontFamily?: string,
): Promise<Map<string, WordLayout[]>> {
  const layouts = new Map<string, WordLayout[]>();
  if (typeof document === "undefined") return layouts;

  const fontSpec = `600 ${style.fontSize}px ${cssFontFamily}`;
  const usesInlineEmphasis = style.emphasizeKeyword && style.emphasisLayout !== "overlay";
  const emphasisFontSize = Math.round(style.fontSize * INLINE_EMPHASIS_SCALE);
  const emphasisFontSpec = `600 ${emphasisFontSize}px ${emphasisCssFontFamily ?? cssFontFamily}`;
  try {
    await document.fonts.load(fontSpec);
    if (usesInlineEmphasis) await document.fonts.load(emphasisFontSpec);
  } catch {
    // Fall back to whatever font is already available; measurements will
    // just be less accurate rather than failing the whole export.
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return layouts;

  for (const cue of cues) {
    if (!cue.words || cue.words.length === 0) continue;
    const emphasisIdx = usesInlineEmphasis ? pickEmphasisIndex(cue.words.map((w) => w.text)) : -1;
    const words = cue.words.map((w, i) =>
      i === emphasisIdx
        ? style.emphasisUppercase
          ? w.text.toLocaleUpperCase()
          : w.text
        : style.uppercase
          ? w.text.toLocaleUpperCase()
          : w.text,
    );
    ctx.font = fontSpec;
    const spaceWidth = ctx.measureText(" ").width;
    const widths = words.map((w, i) => {
      ctx.font = i === emphasisIdx ? emphasisFontSpec : fontSpec;
      return ctx.measureText(w).width;
    });
    const totalWidth = widths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, words.length - 1);

    let cursor = videoWidth * (style.x / 100) - totalWidth / 2;
    const layout: WordLayout[] = [];
    for (let i = 0; i < words.length; i++) {
      layout.push({ text: words[i], x: cursor, width: widths[i] });
      cursor += widths[i] + spaceWidth;
    }
    layouts.set(cue.id, layout);
  }

  return layouts;
}
