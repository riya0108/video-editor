import { clipTimelineEnd, isTrimmableContent, type Clip } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { isAudibleKind } from "../audio/model";

/**
 * TRANSCRIPT EDITING MODEL — edit video by editing its words.
 *
 * Words are transcribed once per SOURCE (source seconds) and never stored per edit. The transcript you see is
 * DERIVED from the timeline every render: each transcribed clip contributes the words inside its current source
 * range, placed at its current timeline position. So deleting words (a ripple cut), trimming, reordering, undo and
 * redo all update the transcript automatically — there is no second copy to keep in sync.
 */

export interface SourceWord {
  text: string;
  /** Source seconds. */
  start: number;
  end: number;
}

export interface TimelineWord {
  /** Stable for this clip + word. */
  key: string;
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  clipId: string;
}

/** Transcripts as stored in a project: source id -> words (source seconds). */
export type SourceTranscripts = Record<string, SourceWord[]>;

/** Validates stored transcripts from a project file; drops anything malformed rather than failing the whole load. */
export function normalizeTranscripts(raw: unknown): { transcripts: SourceTranscripts; dropped: number } {
  const out: SourceTranscripts = {};
  let dropped = 0;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { transcripts: out, dropped: raw == null ? 0 : 1 };
  for (const [id, words] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(words)) {
      dropped++;
      continue;
    }
    const ok = words.every((w) => typeof w === "object" && w !== null && typeof (w as SourceWord).text === "string" && Number.isFinite((w as SourceWord).start) && Number.isFinite((w as SourceWord).end) && (w as SourceWord).end >= (w as SourceWord).start && (w as SourceWord).start >= 0);
    if (!ok) {
      dropped++;
      continue;
    }
    out[id] = (words as SourceWord[]).map((w) => ({ text: w.text, start: w.start, end: w.end }));
  }
  return { transcripts: out, dropped };
}

/** Clips whose speech belongs in the transcript: audible media on video tracks, or audio clips that aren't music/SFX. */
export function isTranscriptClip(timeline: TimelineModel, clip: Clip): boolean {
  if (!isTrimmableContent(clip.content) || !isAudibleKind(clip.content.kind)) return false;
  const track = timeline.tracks[clip.trackId];
  if (!track || track.muted || clip.audio?.muted) return false;
  if (track.kind === "video" || track.kind === "overlay") return true;
  return clip.audio?.role === "voiceover" || clip.audio?.role === "original" || clip.audio?.role === undefined;
}

/** Distinct sources the transcript needs. */
export function transcriptSources(timeline: TimelineModel): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(timeline.clips)) if (isTranscriptClip(timeline, c) && isTrimmableContent(c.content)) ids.add(c.content.source.sourceId);
  return [...ids];
}

export function timelineWords(timeline: TimelineModel, transcripts: ReadonlyMap<string, readonly SourceWord[]>): TimelineWord[] {
  const fps = timeline.frameRate;
  const out: TimelineWord[] = [];
  for (const clip of Object.values(timeline.clips)) {
    if (!isTranscriptClip(timeline, clip) || !isTrimmableContent(clip.content)) continue;
    const words = transcripts.get(clip.content.source.sourceId);
    if (!words) continue;
    const inSec = clip.content.sourceInFrame / fps;
    const outSec = inSec + (clipTimelineEnd(clip) - clip.timelineStart) / fps;
    const at = clip.timelineStart / fps;
    words.forEach((w, i) => {
      const mid = (w.start + w.end) / 2;
      if (mid < inSec || mid >= outSec) return; // a word belongs to the clip that holds its middle
      out.push({ key: `${clip.id}:${i}`, text: w.text, start: +(at + Math.max(0, w.start - inSec)).toFixed(3), end: +(at + Math.min(outSec, w.end) - inSec).toFixed(3), clipId: clip.id });
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Lowercase word without surrounding punctuation. */
export const bareWord = (w: string) =>
  w
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .trim();

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mhm"]);
export const isFillerWord = (w: string) => FILLERS.has(bareWord(w));

/**
 * Timeline-frame spans to cut so the given words disappear cleanly: each run of consecutive selected words is cut
 * from its first word's start to the NEXT kept word's start (taking the pause after it too, like a human editor),
 * unless that pause is long — then only a short tail of it goes.
 */
export function rangesForWords(words: readonly TimelineWord[], selected: ReadonlySet<string>, fps: number): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < words.length) {
    if (!selected.has(words[i].key)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && selected.has(words[j + 1].key)) j++;
    const first = words[i];
    const last = words[j];
    const next = words[j + 1];
    const prev = words[i - 1];
    const gapAfter = next ? next.start - last.end : Infinity;
    const end = gapAfter <= 0.6 ? next!.start : last.end + Math.min(0.12, gapAfter / 2);
    // Start just after the previous word, so its tail isn't clipped, but take the breath before this run.
    const start = prev ? Math.max(prev.end, first.start - 0.05) : Math.max(0, first.start - 0.05);
    ranges.push([Math.round(start * fps), Math.round(end * fps)]);
    i = j + 1;
  }
  return ranges.filter(([a, b]) => b > a);
}

/** Spans that shorten every pause longer than `maxPauseSec` down to `keepSec`. */
export function rangesForPauses(words: readonly TimelineWord[], fps: number, maxPauseSec = 0.8, keepSec = 0.3): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > maxPauseSec) ranges.push([Math.round((words[i - 1].end + keepSec / 2) * fps), Math.round((words[i].start - keepSec / 2) * fps)]);
  }
  return ranges.filter(([a, b]) => b > a);
}
