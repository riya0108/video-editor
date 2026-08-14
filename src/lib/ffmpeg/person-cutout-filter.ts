import type { CutoutFrame } from "../captions/person-cutout";

export interface CutoutOverlayPlan {
  /** Cutout PNG blobs to stage into ffmpeg's VFS, in the same order as `-i` occurrences below. */
  inputs: { name: string; data: Blob }[];
  /** `-loop 1 -i <name>` args for each input above, to append to the command's input args (before the filter_complex). */
  inputArgs: string[];
  /**
   * Builds the filter_complex fragment chaining each cutout frame's overlay
   * on top of `inLabel`, given the ffmpeg input index the first cutout PNG
   * landed at (i.e. how many `-i`s came before it) and a label allocator.
   */
  buildFilters: (
    firstInputIndex: number,
    inLabel: string,
    newLabel: (prefix: "v") => string,
  ) => { filters: string[]; outLabel: string };
}

/**
 * Plans the ffmpeg side of "behind a person" captions: each sampled cutout
 * frame becomes its own looped image input, composited on top of the caption
 * text with `overlay=enable='between(t,...)'` so only one is visible at a
 * time — the same enable/between chaining this app already uses for drawtext
 * and timed image overlays, just applied per sampled frame instead of per cue.
 *
 * `timeOffset` should be the trim start when the base video stream was
 * seeked with `-ss` before `-i` (ffmpeg's filtergraph `t` then runs from 0 at
 * the trim point, not the original file's absolute time) — 0 when there's no
 * trim. `windowStart`/`windowEnd` bound the visible timeline in that same
 * (post-offset) time base.
 */
export function planCutoutOverlay({
  frames,
  timeOffset,
  windowStart,
  windowEnd,
  targetWidth,
  targetHeight,
}: {
  frames: CutoutFrame[];
  timeOffset: number;
  windowStart: number;
  windowEnd: number;
  targetWidth: number;
  targetHeight: number;
}): CutoutOverlayPlan | null {
  const relevant = frames
    .map((f) => ({ ...f, relTime: f.time - timeOffset }))
    .filter((f) => f.relTime < windowEnd)
    .sort((a, b) => a.relTime - b.relTime);
  if (relevant.length === 0) return null;

  const inputs = relevant.map((f, i) => ({ name: `cutout_${i}.png`, data: f.blob }));
  const inputArgs = inputs.flatMap((input) => ["-loop", "1", "-i", input.name]);

  return {
    inputs,
    inputArgs,
    buildFilters: (firstInputIndex, inLabel, newLabel) => {
      const filters: string[] = [];
      let current = inLabel;
      for (let i = 0; i < relevant.length; i++) {
        const winStart = Math.max(windowStart, relevant[i].relTime);
        const winEnd = i + 1 < relevant.length ? Math.min(windowEnd, relevant[i + 1].relTime) : windowEnd;
        if (winEnd <= winStart) continue;
        const idx = firstInputIndex + i;
        const scaled = newLabel("v");
        filters.push(`[${idx}:v]scale=${targetWidth}:${targetHeight}[${scaled}]`);
        const out = newLabel("v");
        filters.push(
          `[${current}][${scaled}]overlay=x=0:y=0:eof_action=pass:enable='between(t\\,${winStart.toFixed(2)}\\,${winEnd.toFixed(2)})'[${out}]`,
        );
        current = out;
      }
      return { filters, outLabel: current };
    },
  };
}
