/** A time range to keep, in whatever timeline the caller is working in (source-absolute or trim-relative — the functions below don't care, as long as everything passed to one call uses the same one). */
export interface KeepInterval {
  start: number;
  end: number;
}

export interface CutSegment extends KeepInterval {
  id: string;
}

let cutIdCounter = 0;
export function nextCutSegmentId(): string {
  cutIdCounter += 1;
  return `cut-${cutIdCounter}`;
}

const MIN_SEGMENT_LENGTH = 0.02;

/**
 * Clips stored kept-segments into the current [start,end] trim window,
 * dropping any that end up outside it and clamping the ones that straddle
 * its edges. Falls back to the whole window as a single segment when nothing
 * survives — e.g. before any split has been made, or after the trim range
 * moved past every stored segment — so callers never have to special-case
 * "no cuts yet" separately from "cuts, but the trim range moved."
 */
export function effectiveSegments(stored: CutSegment[], start: number, end: number): CutSegment[] {
  const clipped = stored
    .map((s) => ({ ...s, start: Math.max(start, s.start), end: Math.min(end, s.end) }))
    .filter((s) => s.end - s.start > MIN_SEGMENT_LENGTH)
    .sort((a, b) => a.start - b.start);
  if (clipped.length === 0) return [{ id: "base", start, end }];
  return clipped;
}

export function totalKeptDuration(segments: KeepInterval[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

function cumulativeBounds(segments: KeepInterval[]) {
  let acc = 0;
  return segments.map((s) => {
    const accStart = acc;
    acc += s.end - s.start;
    return { start: s.start, end: s.end, accStart };
  });
}

/** Maps a time forward through the kept segments into compacted (post-cut) time: inside a
 * kept segment it's a direct offset; in a gap it snaps forward to the next kept segment's
 * start; past the last segment it's out of range (null). */
export function mapStartTime(t: number, segments: KeepInterval[]): number | null {
  const bounds = cumulativeBounds(segments);
  for (const b of bounds) {
    if (t <= b.end) return b.accStart + Math.max(0, t - b.start);
  }
  return null;
}

/** Maps a time backward through the kept segments into compacted time: inside a kept
 * segment it's a direct offset; in a gap it snaps backward to the previous kept segment's
 * end; before the first segment it's out of range (null). */
export function mapEndTime(t: number, segments: KeepInterval[]): number | null {
  const bounds = cumulativeBounds(segments);
  let prevEnd: number | null = null;
  for (const b of bounds) {
    if (t <= b.start) return prevEnd;
    if (t <= b.end) return b.accStart + (t - b.start);
    prevEnd = b.accStart + (b.end - b.start);
  }
  return prevEnd;
}

/**
 * Remaps a [windowStart,windowEnd) window through the kept segments, clipping it to
 * whatever portion survives the cuts. Used to keep captions/overlays in sync with a
 * timeline that's been compacted by removing one or more middle sections — a window
 * that straddles a cut gets truncated to its visible edges rather than dropped or left
 * misaligned. Returns null if the whole window falls inside a removed gap.
 */
export function remapWindow(windowStart: number, windowEnd: number, segments: KeepInterval[]): KeepInterval | null {
  const mappedStart = mapStartTime(windowStart, segments);
  const mappedEnd = mapEndTime(windowEnd, segments);
  if (mappedStart === null || mappedEnd === null || mappedEnd <= mappedStart) return null;
  return { start: mappedStart, end: mappedEnd };
}

/** True when the segments actually remove something (more than one piece, or the
 * single piece doesn't already span the full [start,end) window) — lets callers skip
 * the trim+concat filter entirely for the common "no cuts made" case. */
export function hasRealCuts(segments: KeepInterval[], start: number, end: number): boolean {
  if (segments.length > 1) return true;
  const only = segments[0];
  if (!only) return false;
  return only.start - start > MIN_SEGMENT_LENGTH || end - only.end > MIN_SEGMENT_LENGTH;
}
