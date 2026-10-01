import { createId } from "./id";
import type { Track } from "./track";
import { clipTimelineEnd, type Clip } from "./clip";

export interface TimelineModel {
  id: string;
  frameRate: number;
  /** Track order — index 0 is topmost/frontmost for visual compositing. Maintained exclusively by operations.ts (addTrack/removeTrack/reorderTrack). */
  trackIds: string[];
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
}

export function createTimeline(frameRate: number): TimelineModel {
  if (!(frameRate > 0)) throw new Error(`frameRate must be > 0, got ${frameRate}.`);
  return { id: createId("timeline"), frameRate, trackIds: [], tracks: {}, clips: {} };
}

export function getTrack(timeline: TimelineModel, trackId: string): Track | undefined {
  return timeline.tracks[trackId];
}

export function getClip(timeline: TimelineModel, clipId: string): Clip | undefined {
  return timeline.clips[clipId];
}

/** Clips on a track, in ascending timelineStart order (mirrors track.clipIds, which operations.ts keeps sorted — this just resolves ids to Clip objects). */
export function getTrackClips(timeline: TimelineModel, trackId: string): Clip[] {
  const track = timeline.tracks[trackId];
  if (!track) return [];
  return track.clipIds.map((id) => timeline.clips[id]).filter((c): c is Clip => c !== undefined);
}

export function allTracks(timeline: TimelineModel): Track[] {
  return timeline.trackIds.map((id) => timeline.tracks[id]).filter((t): t is Track => t !== undefined);
}

/** The last frame any clip on any track reaches — 0 for an empty timeline. */
export function timelineDurationFrames(timeline: TimelineModel): number {
  let max = 0;
  for (const clip of Object.values(timeline.clips)) {
    max = Math.max(max, clipTimelineEnd(clip));
  }
  return max;
}

/**
 * The single place this engine checks "do two clips overlap" — every
 * placement-affecting operation routes through this rather than
 * reimplementing the comparison. Two clips that exactly touch at an edge
 * (one's end == the other's start) do NOT overlap — that's the normal,
 * valid, gapless-adjacent case.
 */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Finds a clip on `trackId` that would overlap a hypothetical clip spanning
 * [start, end) — excluding `excludeClipId` (typically the clip being
 * moved/trimmed/split itself, which obviously "overlaps" its own current
 * position). Returns the first conflicting clip, or undefined if the
 * placement is valid.
 */
export function findOverlap(timeline: TimelineModel, trackId: string, start: number, end: number, excludeClipId?: string): Clip | undefined {
  return getTrackClips(timeline, trackId).find((c) => c.id !== excludeClipId && rangesOverlap(start, end, c.timelineStart, clipTimelineEnd(c)));
}
