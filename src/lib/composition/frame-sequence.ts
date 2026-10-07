/**
 * FRAME SEQUENCES — a source made of individually rendered frames keyed by
 * source frame (e.g. a background-removal matte computed for sampled frames
 * of a video). Sparse by design: a frame with no sample of its own HOLDS the
 * nearest earlier sample (sample-and-hold, the same policy as the existing
 * video cutout pipeline), and frames before the first sample use the first.
 */
export interface SequenceFrame<T> {
  frame: number;
  image: T;
}

/** Sorted (ascending, unique frames) copy — the lookup below relies on it. Later duplicates win. */
export function normalizeSequence<T>(frames: readonly SequenceFrame<T>[]): SequenceFrame<T>[] {
  const byFrame = new Map<number, T>();
  for (const f of frames) if (Number.isFinite(f.frame)) byFrame.set(Math.round(f.frame), f.image);
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, image]) => ({ frame, image }));
}

/** The sample shown at `target`: the last one at or before it, else the first. Binary search; null only when empty. */
export function sampleAt<T>(frames: readonly SequenceFrame<T>[], target: number): SequenceFrame<T> | null {
  if (frames.length === 0) return null;
  if (target < frames[0].frame) return frames[0];
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].frame <= target) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}
