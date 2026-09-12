import { escapeDrawtext } from "../ffmpeg/drawtext";
import { positionExprs } from "../ffmpeg/text-position";
import { contrastTextColor } from "./contrast-color";
import { INLINE_EMPHASIS_SCALE, pickEmphasisIndex } from "./emphasis";
import type { WordLayout } from "./karaoke-layout";
import type { CaptionCue, CaptionStyle } from "./types";

function toFfmpegColor(hex: string): string {
  return hex.replace("#", "0x");
}

/** A short in/out alpha ramp confined to the cue's own [start, end) window, for `style.fade`. */
function fadeAlphaExpr(start: number, end: number): string {
  const fadeDur = Math.min(0.35, Math.max(0.05, (end - start) / 2));
  const t0 = start.toFixed(2);
  const t1 = end.toFixed(2);
  const d = fadeDur.toFixed(2);
  return `if(lt(t\\,${t0}+${d})\\,(t-${t0})/${d}\\,if(gt(t\\,${t1}-${d})\\,(${t1}-t)/${d}\\,1))`;
}

/** Entrance animations that read as a "grows in" motion — pop/elastic/bounce all share this same quick scale-in shape in the browser preview, so they share this one drawtext approximation too. */
const GROW_ANIMATIONS = new Set(["pop", "elastic", "bounce"]);
/** Entrance animations that read as a "slides/drops in" motion, keyed to the pixel offset (and sign) the text starts displaced by. Positive = starts below and rises; negative = starts above and falls. */
const SLIDE_ANIMATION_OFFSETS: Partial<Record<CaptionStyle["animation"], number>> = {
  "slide-up": 44,
  "drop-in": -60,
};

/** A quick scale-in ramp from a fraction of `size` up to `size`, for `style.animation` values in GROW_ANIMATIONS. Clamped to stay a positive integer at all times since drawtext errors on a non-positive fontsize. */
function growFontSizeExpr(size: number, start: number): string {
  const s = start.toFixed(2);
  return `max(1\\,min(${size}\\,round(${size}*(0.55+0.45*(t-${s})/0.16))))`;
}

/**
 * A short position-offset ramp that decays to 0 over the first ~0.22s after
 * `start`, for `style.animation` values in SLIDE_ANIMATION_OFFSETS — the
 * closest drawtext (no transforms) can get to a slide/drop entrance.
 */
function entranceYOffsetExpr(offsetPx: number, start: number): string {
  const s = start.toFixed(2);
  return `(${offsetPx}*max(0\\,1-(t-${s})/0.22))`;
}

/** Builds the fontsize= value for a cue or word's own drawtext pass, folding in whichever entrance animation (if any) applies. */
function animatedFontSizeExpr(style: CaptionStyle, size: number, start: number): string {
  return GROW_ANIMATIONS.has(style.animation) ? growFontSizeExpr(size, start) : `${size}`;
}

/** Builds the y= value for a cue or word's own drawtext pass, folding in whichever entrance animation (if any) applies. */
function animatedYExpr(style: CaptionStyle, y: string, start: number): string {
  const offset = SLIDE_ANIMATION_OFFSETS[style.animation];
  return offset === undefined ? y : `${y}+${entranceYOffsetExpr(offset, start)}`;
}

/** Middle color of a gradient (Prism-style) as a flat fallback — burned-in drawtext has no gradient-fill text, so this is the closest single-color approximation. */
function gradientFallbackColor(gradient: string[], fallback: string): string {
  return gradient.length > 0 ? gradient[Math.floor(gradient.length / 2)] : fallback;
}

/**
 * Shifts cue (and word) timestamps from the original video's absolute time
 * base into a trimmed clip's own [0, trimEnd-trimStart) time base — needed
 * wherever captions are burned into a filtergraph whose main input was
 * seeked with `-ss` before `-i`, since ffmpeg's filter-time `t` then runs
 * from 0 at the trim point rather than the original file's absolute time.
 * Cues entirely outside the trim window are dropped; partially-overlapping
 * ones are clamped to it.
 */
export function remapCuesToTrim(cues: CaptionCue[], trimStart: number, trimEnd: number): CaptionCue[] {
  const span = trimEnd - trimStart;
  return cues
    .map((cue) => ({
      ...cue,
      start: cue.start - trimStart,
      end: cue.end - trimStart,
      words: cue.words?.map((w) => ({ ...w, start: w.start - trimStart, end: w.end - trimStart })),
    }))
    .filter((cue) => cue.end > 0 && cue.start < span)
    .map((cue) => ({
      ...cue,
      start: Math.max(0, cue.start),
      end: Math.min(span, cue.end),
      words: cue.words?.filter((w) => w.end > 0 && w.start < span),
    }));
}

/**
 * Builds a `-vf`-ready chain of drawtext filters, one per cue, each only
 * visible during its own [start, end) window via `enable=between(...)`. The
 * bundled ffmpeg core has no libass/subtitles filter, so this is the same
 * drawtext-chaining approach the full video editor uses for timed overlays.
 *
 * When `style.karaoke` is on and a cue has a precomputed word layout, each
 * word gets a second drawtext pass in the highlight color, positioned at its
 * pre-measured pixel offset and only enabled during that word's own time
 * window — layered on top of the base line so it reads as a live highlight.
 */
export function buildCaptionsFilter(
  cues: CaptionCue[],
  style: CaptionStyle,
  fontFfmpegName: string,
  karaokeLayouts?: Map<string, WordLayout[]>,
  emphasisFontFfmpegName?: string,
): string {
  const colorHex = toFfmpegColor(gradientFallbackColor(style.gradient, style.color));
  const highlightHex = toFfmpegColor(style.highlightColor);
  const wordBoxTextHex = toFfmpegColor(contrastTextColor(style.highlightColor));
  const { x, y } = positionExprs(style.x, style.y);
  const boxAlpha = style.backdropBlur ? "0.35" : "0.65";

  return cues
    .map((cue) => {
      const text = style.uppercase ? cue.text.toLocaleUpperCase() : cue.text;
      const baseFontSize = animatedFontSizeExpr(style, style.fontSize, cue.start);
      const baseY = animatedYExpr(style, y, cue.start);

      const layout = style.karaoke ? karaokeLayouts?.get(cue.id) : undefined;
      const words = layout && cue.words && cue.words.length === layout.length ? cue.words : null;
      const emphasisIdx =
        style.emphasizeKeyword && words ? pickEmphasisIndex(words.map((w) => w.text)) : -1;

      // "overlay" (Blockbuster): two independently-centered drawtext passes
      // at the same anchor point — a giant standalone word behind a smaller
      // sentence — rather than one line of differently-sized words. Doesn't
      // need the karaoke pixel layout at all since nothing sits inline.
      const isOverlay = style.emphasizeKeyword && style.emphasisLayout === "overlay" && emphasisFontFfmpegName;
      const overlayWords = isOverlay
        ? cue.words && cue.words.length > 0
          ? cue.words.map((w) => w.text)
          : cue.text.trim().split(/\s+/)
        : [];
      const overlayEmphasisIdx = isOverlay ? pickEmphasisIndex(overlayWords) : -1;

      const commonTextOptions = [
        style.background ? `box=1:boxcolor=${toFfmpegColor(style.backgroundColor)}@${boxAlpha}:boxborderw=16` : null,
        style.outline ? `borderw=${style.strokeWidth}:bordercolor=${toFfmpegColor(style.outlineColor)}` : null,
        style.shadow ? `shadowx=3:shadowy=3:shadowcolor=black@0.55` : null,
        style.fade ? `alpha='${fadeAlphaExpr(cue.start, cue.end)}'` : null,
      ].filter((v): v is string => v !== null);

      // With word-level timing, the base line reveals progressively — each
      // word pops in at its own start time and holds through the cue's end —
      // matching the live preview's word-by-word reveal, rather than
      // burning in the full phrase from the cue's very first frame.
      const base = isOverlay
        ? (() => {
            const rawBigWord = overlayWords[overlayEmphasisIdx] ?? "";
            const bigWord = style.emphasisUppercase ? rawBigWord.toLocaleUpperCase() : rawBigWord;
            const restText = overlayWords.filter((_, i) => i !== overlayEmphasisIdx).join(" ");
            const restDisplay = style.uppercase ? restText.toLocaleUpperCase() : restText;
            const enable = `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`;
            return [
              [
                `drawtext=fontfile=${emphasisFontFfmpegName}`,
                `text='${escapeDrawtext(bigWord)}'`,
                `fontsize=${Math.round(style.fontSize * 3.3)}`,
                `fontcolor=${highlightHex}`,
                `x=${x}`,
                `y=${y}`,
                enable,
              ].join(":"),
              [
                `drawtext=fontfile=${fontFfmpegName}`,
                `text='${escapeDrawtext(restDisplay)}'`,
                `fontsize=${Math.round(style.fontSize * 1.05)}`,
                `fontcolor=${colorHex}`,
                `x=${x}`,
                `y=${y}`,
                enable,
                ...commonTextOptions,
              ].join(":"),
            ].join(",");
          })()
        : words && layout
          ? words
              .map((word, i) => {
                const isEmphasis = i === emphasisIdx && emphasisFontFfmpegName;
                const wordFontSize = isEmphasis
                  ? Math.round(style.fontSize * INLINE_EMPHASIS_SCALE)
                  : animatedFontSizeExpr(style, style.fontSize, word.start);
                const wordY = animatedYExpr(style, y, word.start);
                const wordText = isEmphasis
                  ? style.emphasisUppercase
                    ? word.text.toLocaleUpperCase()
                    : word.text
                  : style.uppercase
                    ? word.text.toLocaleUpperCase()
                    : word.text;
                return [
                  `drawtext=fontfile=${isEmphasis ? emphasisFontFfmpegName : fontFfmpegName}`,
                  `text='${escapeDrawtext(wordText)}'`,
                  `fontsize=${wordFontSize}`,
                  `fontcolor=${isEmphasis ? highlightHex : colorHex}`,
                  `x=${Math.round(layout[i].x)}`,
                  `y=${wordY}`,
                  `enable='between(t\\,${Math.max(word.start, cue.start).toFixed(2)}\\,${cue.end.toFixed(2)})'`,
                  ...(isEmphasis && style.glow
                    ? [`borderw=8:bordercolor=${toFfmpegColor(style.glowColor)}@0.5`, ...commonTextOptions.filter((o) => !o.startsWith("borderw"))]
                    : commonTextOptions),
                ].join(":");
              })
              .join(",")
          : [
              `drawtext=fontfile=${fontFfmpegName}`,
              `text='${escapeDrawtext(text)}'`,
              `fontsize=${baseFontSize}`,
              `fontcolor=${colorHex}`,
              `x=${x}`,
              `y=${baseY}`,
              `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`,
              ...commonTextOptions,
            ].join(":");

      // Layered "halo" and "chromatic split" passes are drawn *before* the
      // base text (earlier in a -vf chain = further back), so they read as
      // a glow or an RGB-split ghost behind the real glyphs. Burned-in
      // drawtext has no real gaussian blur, so this is the closest
      // approximation without a much heavier per-frame filter graph.
      const backdropPasses: string[] = [];
      if (style.glow) {
        backdropPasses.push(
          [
            `drawtext=fontfile=${fontFfmpegName}`,
            `text='${escapeDrawtext(text)}'`,
            `fontsize=${baseFontSize}`,
            `fontcolor=${toFfmpegColor(style.glowColor)}@0.6`,
            `x=${x}`,
            `y=${baseY}`,
            `borderw=${style.strokeWidth + 5}:bordercolor=${toFfmpegColor(style.glowColor)}@0.4`,
            `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`,
          ].join(":"),
        );
      }
      if (style.glitch) {
        for (const [dx, tint] of [
          [-3, "0xff0050@0.7"],
          [3, "0x00e1ff@0.7"],
        ] as const) {
          backdropPasses.push(
            [
              `drawtext=fontfile=${fontFfmpegName}`,
              `text='${escapeDrawtext(text)}'`,
              `fontsize=${baseFontSize}`,
              `fontcolor=${tint}`,
              `x=${x}+${dx}`,
              `y=${baseY}`,
              `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`,
            ].join(":"),
          );
        }
      }

      // emphasizeKeyword already bakes its one-word styling into `base`
      // above — skip the usual "currently spoken word" highlight overlay so
      // it doesn't also flash a second word's color as playback moves.
      if (!words || !layout || style.emphasizeKeyword) return [...backdropPasses, base].join(",");

      const wordFilters = words.map((word, i) => {
        const wordFontSize = animatedFontSizeExpr(style, style.fontSize, word.start);
        const wordY = animatedYExpr(style, y, word.start);
        const wordOptions = [
          `drawtext=fontfile=${fontFfmpegName}`,
          `text='${escapeDrawtext(style.uppercase ? word.text.toLocaleUpperCase() : word.text)}'`,
          `fontsize=${wordFontSize}`,
          `fontcolor=${style.wordBox ? wordBoxTextHex : highlightHex}`,
          `x=${Math.round(layout[i].x)}`,
          `y=${wordY}`,
          `enable='between(t\\,${Math.max(word.start, cue.start).toFixed(2)}\\,${Math.min(word.end, cue.end).toFixed(2)})'`,
        ];
        if (style.wordBox) {
          wordOptions.push(`box=1:boxcolor=${highlightHex}@0.95:boxborderw=10`);
        }
        if (style.outline && !style.wordBox) {
          wordOptions.push(`borderw=${style.strokeWidth}:bordercolor=${toFfmpegColor(style.outlineColor)}`);
        }
        if (style.fade) {
          wordOptions.push(`alpha='${fadeAlphaExpr(cue.start, cue.end)}'`);
        }
        return wordOptions.join(":");
      });

      return [...backdropPasses, base, ...wordFilters].join(",");
    })
    .join(",");
}
