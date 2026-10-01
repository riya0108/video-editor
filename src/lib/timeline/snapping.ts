import { getTrackClips, type TimelineModel } from "./model";
import { clipTimelineEnd } from "./clip";

/**
 * Pure, stateless, frame-space-only — no opinion about pixels or UI. A
 * caller (future UI) computes this once per drag gesture start (excluding
 * the clip being dragged) plus any extra points (typically the live
 * playhead), then runs the live drag position through `snapToNearest` on
 * every move, then calls the engine's moveClip/trimClip with the
 * (possibly snapped) result. Edit operations themselves never snap
 * implicitly — see TIMELINE_ARCHITECTURE.md §10.
 */
export function collectSnapPoints(timeline: TimelineModel, opts: { excludeClipIds?: string[]; extra?: number[] } = {}): number[] {
  const excluded = new Set(opts.excludeClipIds ?? []);
  const points = new Set<number>([0, ...(opts.extra ?? [])]);
  for (const trackId of timeline.trackIds) {
    for (const clip of getTrackClips(timeline, trackId)) {
      if (excluded.has(clip.id)) continue;
      points.add(clip.timelineStart);
      points.add(clipTimelineEnd(clip));
    }
  }
  return [...points].sort((a, b) => a - b);
}

/** Returns the nearest point within thresholdFrames of `target`, or `target` unchanged if nothing is close enough. Ties (equally close on both sides) prefer the earlier point. */
export function snapToNearest(target: number, points: number[], thresholdFrames: number): number {
  let best = target;
  let bestDistance = thresholdFrames + 1;
  for (const point of points) {
    const distance = Math.abs(point - target);
    if (distance <= thresholdFrames && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
