import type { CaptionWordTiming } from "./caption-model";

/**
 * CAPTION ANIMATION — the track style's `animation` field, rendered (it was reserved until now).
 *
 * Evaluated per frame in the composition resolver, the one place preview AND export resolve layers, so animated
 * captions look identical in both. Pure: (style, segment, time) -> how the segment looks right now. Nothing is
 * stored per frame; editing a caption's text or timing simply changes what this returns.
 *
 *   fade         segment fades in and out
 *   pop          segment springs in from small
 *   rise         segment slides up into place
 *   word-reveal  words appear one by one as they're spoken (needs word timings — auto-captions have them)
 *   word-single  only the word being spoken, each one popping in ("one word at a time" short-form style)
 *
 * Without word timings the word modes fall back to the whole segment with a pop.
 */

export const CAPTION_ANIMATIONS: readonly { id: string; label: string; needsWords?: boolean }[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "pop", label: "Pop" },
  { id: "rise", label: "Rise" },
  { id: "word-reveal", label: "Word by word", needsWords: true },
  { id: "word-single", label: "One word at a time", needsWords: true },
];

export interface CaptionMotion {
  /** Multiplies the layer's opacity. */
  opacity: number;
  /** Multiplies the layer's scale (both axes, around its anchor). */
  scale: number;
  /** Composition px added to the layer's y. */
  dy: number;
  /** Replaces the segment's text this frame (word modes); undefined = the whole text. */
  text?: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** Overshoots past 1 then settles — the "spring" in pop. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}
const popScale = (sinceSec: number, dur = 0.18, from = 0.6) => from + (1 - from) * easeOutBack(clamp01(sinceSec / dur));

/**
 * @param localSec  time since the segment's start, seconds
 * @param durationSec  the segment's length, seconds
 * @param fontSize  the caption font size (composition px) — sizes the rise distance
 */
export function captionMotionAt(animation: string | undefined, text: string, words: readonly CaptionWordTiming[] | undefined, localSec: number, durationSec: number, fontSize: number): CaptionMotion | null {
  if (!animation || animation === "none") return null;
  const t = Math.max(0, localSec);
  const tail = Math.max(0, durationSec - t);
  const usableWords = words && words.length > 0 ? words : null;
  switch (animation) {
    case "fade":
      return { opacity: clamp01(Math.min(t / 0.15, tail / 0.12)), scale: 1, dy: 0 };
    case "pop":
      return { opacity: clamp01(t / 0.08), scale: popScale(t), dy: 0 };
    case "rise":
      return { opacity: clamp01(t / 0.12), scale: 1, dy: fontSize * 0.6 * (1 - easeOut(clamp01(t / 0.25))) };
    case "word-reveal": {
      if (!usableWords) return { opacity: clamp01(t / 0.08), scale: popScale(t), dy: 0 };
      let n = 0;
      while (n < usableWords.length && usableWords[n].start <= t) n++;
      return { opacity: 1, scale: 1, dy: 0, text: usableWords.slice(0, Math.max(1, n)).map((w) => w.text.trim()).join(" ") };
    }
    case "word-single": {
      if (!usableWords) return { opacity: clamp01(t / 0.08), scale: popScale(t), dy: 0 };
      let i = 0;
      while (i + 1 < usableWords.length && usableWords[i + 1].start <= t) i++;
      const w = usableWords[i];
      return { opacity: 1, scale: popScale(t - w.start, 0.14, 0.75), dy: 0, text: w.text.trim() || text };
    }
    default:
      return null; // unknown (a newer build's) animation: render static rather than guess
  }
}
