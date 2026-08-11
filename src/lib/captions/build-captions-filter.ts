import { escapeDrawtext } from "../ffmpeg/drawtext";
import type { WordLayout } from "./karaoke-layout";
import type { CaptionCue, CaptionStyle, CaptionPosition } from "./types";

const POSITION_Y: Record<CaptionPosition, string> = {
  top: "40",
  center: "(h-text_h)/2",
  bottom: "h-text_h-40",
};

function toFfmpegColor(hex: string): string {
  return hex.replace("#", "0x");
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
  const y = POSITION_Y[style.position];

  return cues
    .map((cue) => {
      const text = style.uppercase ? cue.text.toLocaleUpperCase() : cue.text;
      const options = [
        `drawtext=fontfile=${fontFfmpegName}`,
        `text='${escapeDrawtext(text)}'`,
        `fontsize=${style.fontSize}`,
        `fontcolor=${colorHex}`,
        "x=(w-text_w)/2",
        `y=${y}`,
        `enable='between(t\\,${cue.start.toFixed(2)}\\,${cue.end.toFixed(2)})'`,
      ];
      if (style.background) {
        options.push(`box=1:boxcolor=${toFfmpegColor(style.backgroundColor)}@0.65:boxborderw=16`);
      }
      if (style.outline) {
        options.push(`borderw=3:bordercolor=${toFfmpegColor(style.outlineColor)}`);
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
        return wordOptions.join(":");
      });

      return [base, ...wordFilters].join(",");
    })
    .join(",");
}
