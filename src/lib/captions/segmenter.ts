import type { CaptionWordTiming } from "./caption-model";
import type { SubtitleCue } from "./subtitle-io";

/**
 * WORDS -> CAPTION SEGMENTS (CAPTIONS_ARCHITECTURE.md §3). Pure.
 *
 * Breaks a timed word stream into readable captions: a new segment starts at
 * a sentence end, at a pause, or when the segment would exceed the length /
 * word / duration limits. Two pacing profiles: broadcast-style subtitles
 * (up to two ~42-char lines) and short-form "creator" captions (a few words
 * at a time).
 */

export interface SegmentOptions {
  maxChars: number;
  maxWords: number;
  maxDurationSec: number;
  /** A silence at least this long between words always starts a new caption. */
  pauseSec: number;
  /** Minimum time a caption stays on screen (extended into the following gap when possible). */
  minDurationSec: number;
}

export const SEGMENT_PROFILES: Record<"subtitle" | "short-form", SegmentOptions> = {
  subtitle: { maxChars: 84, maxWords: 16, maxDurationSec: 6, pauseSec: 0.7, minDurationSec: 1 },
  "short-form": { maxChars: 24, maxWords: 4, maxDurationSec: 2.2, pauseSec: 0.45, minDurationSec: 0.4 },
};

/** `words` in absolute (timeline) seconds; returns cues in absolute seconds with their words. */
export function segmentWords(words: readonly CaptionWordTiming[], opts: SegmentOptions = SEGMENT_PROFILES.subtitle): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  let cur: CaptionWordTiming[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push({ start: cur[0].start, end: Math.max(cur[cur.length - 1].end, cur[0].start), text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
    chars = 0;
  };
  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;
    const w = { text, start: raw.start, end: Math.max(raw.start, raw.end) };
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const pause = w.start - prev.end >= opts.pauseSec;
      const tooLong = chars + 1 + text.length > opts.maxChars || cur.length >= opts.maxWords || w.end - cur[0].start > opts.maxDurationSec;
      if (pause || tooLong) flush();
    }
    cur.push(w);
    chars += (cur.length > 1 ? 1 : 0) + text.length;
    if (/[.!?…]["')\]]?$/.test(text)) flush();
  }
  flush();
  // Minimum on-screen time, without ever overlapping the next caption.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]?.start ?? Infinity;
    if (out[i].end - out[i].start < opts.minDurationSec) out[i].end = Math.min(out[i].start + opts.minDurationSec, next);
  }
  return out;
}

/** Stereo/mono PCM at any rate -> 16 kHz mono (what speech-to-text expects). Linear interpolation. */
export function toMono16k(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const a = channels[0];
  const b = channels[1] ?? a;
  const ratio = sampleRate / 16000;
  const n = Math.floor(a.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const i1 = Math.min(a.length - 1, i0 + 1);
    const f = p - i0;
    out[i] = ((a[i0] + b[i0]) / 2) * (1 - f) + ((a[i1] + b[i1]) / 2) * f;
  }
  return out;
}
