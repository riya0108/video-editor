import { escapeDrawtext } from "../ffmpeg/drawtext";
import type { CaptionCue, CaptionStyle, CaptionPosition } from "./types";

const POSITION_Y: Record<CaptionPosition, string> = {
  top: "40",
  center: "(h-text_h)/2",
  bottom: "h-text_h-40",
};

/**
 * Builds a `-vf`-ready chain of drawtext filters, one per cue, each only
 * visible during its own [start, end) window via `enable=between(...)`. The
 * bundled ffmpeg core has no libass/subtitles filter, so this is the same
 * drawtext-chaining approach the full video editor uses for timed overlays.
 */
export function buildCaptionsFilter(cues: CaptionCue[], style: CaptionStyle, fontFfmpegName: string): string {
  const colorHex = style.color.replace("#", "0x");
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
        options.push(`box=1:boxcolor=${style.backgroundColor.replace("#", "0x")}@0.65:boxborderw=16`);
      }
      if (style.outline) {
        options.push(`borderw=3:bordercolor=${style.outlineColor.replace("#", "0x")}`);
      }
      return options.join(":");
    })
    .join(",");
}
