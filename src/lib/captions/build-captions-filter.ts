import { escapeDrawtext } from "../ffmpeg/drawtext";
import { positionExprs } from "../ffmpeg/text-position";
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
): string {
  const colorHex = toFfmpegColor(style.color);
  const highlightHex = toFfmpegColor(style.highlightColor);
  const { x, y } = positionExprs(style.x, style.y);

  return cues
    .map((cue) => {
      const text = style.uppercase ? cue.text.toLocaleUpperCase() : cue.text;
      const options = [
        `drawtext=fontfile=${fontFfmpegName}`,
        `text='${escapeDrawtext(text)}'`,
        `fontsize=${style.fontSize}`,
        `fontcolor=${colorHex}`,
        `x=${x}`,
        `y=${y}`,
        `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`,
      ];
      if (style.background) {
        options.push(`box=1:boxcolor=${toFfmpegColor(style.backgroundColor)}@0.65:boxborderw=16`);
      }
      if (style.outline) {
        options.push(`borderw=3:bordercolor=${toFfmpegColor(style.outlineColor)}`);
      }
      if (style.fade) {
        options.push(`alpha='${fadeAlphaExpr(cue.start, cue.end)}'`);
      }
      const base = options.join(":");

      const layout = style.karaoke ? karaokeLayouts?.get(cue.id) : undefined;
      const words = layout && cue.words && cue.words.length === layout.length ? cue.words : null;
      if (!words || !layout) return base;

      const wordFilters = words.map((word, i) => {
        const wordOptions = [
          `drawtext=fontfile=${fontFfmpegName}`,
          `text='${escapeDrawtext(style.uppercase ? word.text.toLocaleUpperCase() : word.text)}'`,
          `fontsize=${style.fontSize}`,
          `fontcolor=${highlightHex}`,
          `x=${Math.round(layout[i].x)}`,
          `y=${y}`,
          `enable='between(t\\,${Math.max(word.start, cue.start).toFixed(2)}\\,${Math.min(word.end, cue.end).toFixed(2)})'`,
        ];
        if (style.outline) {
          wordOptions.push(`borderw=3:bordercolor=${toFfmpegColor(style.outlineColor)}`);
        }
        if (style.fade) {
          wordOptions.push(`alpha='${fadeAlphaExpr(cue.start, cue.end)}'`);
        }
        return wordOptions.join(":");
      });

      return [base, ...wordFilters].join(",");
    })
    .join(",");
}
