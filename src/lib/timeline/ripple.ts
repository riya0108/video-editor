import { clipTimelineEnd } from "./clip";
import { TimelineEditError } from "./errors";
import type { TimelineModel } from "./model";
import { deleteClip, moveClip, splitClip } from "./operations";

/**
 * RIPPLE DELETE ACROSS TRACKS — removes a span of TIME from the whole project and closes the gap: every track's
 * clips are split at the span's edges, the pieces inside are deleted, and everything after moves up. Captions,
 * overlays, music and text stay in sync with the picture. This is what transcript editing ("delete these words")
 * and the clip maker ("keep only this part") are built on. Pure; one undo step via engine.transact.
 *
 * A locked track with anything at or after the span refuses the edit (moving the rest without it would desync it).
 */
export function rippleDeleteRange(timeline: TimelineModel, start: number, end: number): TimelineModel {
  const s = Math.max(0, Math.round(start));
  const e = Math.round(end);
  if (e <= s) return timeline;
  const len = e - s;
  let tl = timeline;
  for (const trackId of tl.trackIds) {
    const track = tl.tracks[trackId];
    const affected = track.clipIds.some((id) => clipTimelineEnd(tl.clips[id]) > s);
    if (!affected) continue;
    if (track.locked) throw new TimelineEditError("track-locked", `"${track.name}" is locked — unlock it to cut time from the whole project.`);
    // Cut out [s, e) from every clip overlapping it.
    for (const id of [...track.clipIds]) {
      const c = tl.clips[id];
      if (!c) continue;
      const cs = c.timelineStart;
      const ce = clipTimelineEnd(c);
      if (ce <= s || cs >= e) continue;
      let middle = id;
      if (cs < s) {
        const r = splitClip(tl, id, s);
        tl = r.timeline;
        middle = r.right.id;
      }
      const m = tl.clips[middle];
      if (clipTimelineEnd(m) > e) tl = splitClip(tl, middle, e).timeline;
      tl = deleteClip(tl, middle);
    }
    // Close the gap: everything at or after `e` moves left by `len` (left to right, so nothing collides).
    const later = tl.tracks[trackId].clipIds
      .map((id) => tl.clips[id])
      .filter((c) => c.timelineStart >= e)
      .sort((a, b) => a.timelineStart - b.timelineStart);
    for (const c of later) tl = moveClip(tl, c.id, c.timelineStart - len);
  }
  return tl;
}

/** Several spans at once (timeline frames, any order, may overlap). Processed from the end so earlier spans stay valid. */
export function rippleDeleteRanges(timeline: TimelineModel, ranges: readonly (readonly [number, number])[]): { timeline: TimelineModel; removedFrames: number } {
  const sorted = ranges
    .map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  let tl = timeline;
  let removed = 0;
  for (const [a, b] of merged.reverse()) {
    tl = rippleDeleteRange(tl, a, b);
    removed += b - a;
  }
  return { timeline: tl, removedFrames: removed };
}

/** Keeps only [start, end) of the whole project, moved to the start of the timeline. */
export function keepRange(timeline: TimelineModel, start: number, end: number, totalFrames: number): TimelineModel {
  const ranges: [number, number][] = [];
  if (end < totalFrames) ranges.push([end, totalFrames]);
  if (start > 0) ranges.push([0, start]);
  return rippleDeleteRanges(timeline, ranges).timeline;
}
