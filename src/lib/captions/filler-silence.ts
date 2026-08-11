import type { CaptionWord } from "./types";

// A deliberately conservative default list — words like "like" or "so" are
// filler *sometimes* but are real words too often to auto-remove safely.
// These almost never carry meaning on their own.
export const DEFAULT_FILLER_WORDS = ["um", "umm", "uhm", "uh", "uhh", "erm", "er", "hmm", "mm"];

export type RemovableKind = "filler" | "silence";

export interface RemovableSegment {
  id: string;
  kind: RemovableKind;
  start: number;
  end: number;
  /** The filler word's text, or "Silence" for a gap. */
  label: string;
  included: boolean;
}

function normalizeWord(text: string): string {
  return text.trim().toLowerCase().replace(/^[^a-z']+|[^a-z']+$/gi, "");
}

let nextSegmentId = 1;

export function detectFillerWords(words: CaptionWord[], fillerWords: string[]): RemovableSegment[] {
  const fillerSet = new Set(fillerWords.map((w) => w.toLowerCase()));
  const segments: RemovableSegment[] = [];
  for (const word of words) {
    if (fillerSet.has(normalizeWord(word.text))) {
      segments.push({
        id: `seg-${nextSegmentId++}`,
        kind: "filler",
        start: word.start,
        end: word.end,
        label: word.text.trim(),
        included: true,
      });
    }
  }
  return segments;
}

/**
 * Finds gaps with no speech — between words, and at the very start/end of
 * the video — that are at least `minGapSeconds` long.
 */
export function detectSilences(
  words: CaptionWord[],
  videoDuration: number,
  minGapSeconds: number,
): RemovableSegment[] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const segments: RemovableSegment[] = [];

  const leadGap = sorted[0].start;
  if (leadGap >= minGapSeconds) {
    segments.push({ id: `seg-${nextSegmentId++}`, kind: "silence", start: 0, end: leadGap, label: "Silence", included: true });
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = sorted[i].end;
    const gapEnd = sorted[i + 1].start;
    if (gapEnd - gapStart >= minGapSeconds) {
      segments.push({
        id: `seg-${nextSegmentId++}`,
        kind: "silence",
        start: gapStart,
        end: gapEnd,
        label: "Silence",
        included: true,
      });
    }
  }

  const lastEnd = sorted[sorted.length - 1].end;
  const trailGap = videoDuration - lastEnd;
  if (trailGap >= minGapSeconds) {
    segments.push({
      id: `seg-${nextSegmentId++}`,
      kind: "silence",
      start: lastEnd,
      end: videoDuration,
      label: "Silence",
      included: true,
    });
  }

  return segments;
}

/**
 * Turns the (possibly overlapping) set of segments the user has chosen to
 * remove into the complementary list of intervals to *keep* — what actually
 * gets fed to the trim+concat filter graph. A small padding is kept around
 * each cut so words right next to it don't get clipped.
 */
export function buildKeepIntervals(
  videoDuration: number,
  segments: RemovableSegment[],
  padding = 0.06,
): { start: number; end: number }[] {
  const cuts = segments
    .filter((s) => s.included)
    .map((s) => ({ start: Math.max(0, s.start + padding), end: Math.min(videoDuration, s.end - padding) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const cut of cuts) {
    const last = merged.at(-1);
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
    } else {
      merged.push({ ...cut });
    }
  }

  const keep: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.start > cursor) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < videoDuration) keep.push({ start: cursor, end: videoDuration });

  // Guard against pathologically tiny slivers (e.g. two cuts a few ms apart)
  // that would otherwise turn into near-zero-length segments in the export.
  return keep.filter((k) => k.end - k.start > 0.03);
}
