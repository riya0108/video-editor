import { createId } from "./id";
import type { Track } from "./track";
import { clipTimelineEnd, type Clip } from "./clip";

/** Output canvas of the project — the coordinate space every ClipVisual is authored in. See COMPOSITION_ARCHITECTURE.md §1. */
export interface CompositionSettings {
  /** Output pixels. */
  width: number;
  height: number;
  /** CSS color, or "transparent" for an alpha-carrying output. */
  background: string;
}

export const DEFAULT_COMPOSITION: Readonly<CompositionSettings> = Object.freeze({ width: 1920, height: 1080, background: "#000000" });

/** A ruler guide: a vertical line at x = position (axis "x") or a horizontal line at y = position (axis "y"), in composition pixels. Project state, so guide edits are undoable like any other edit. */
export interface Guide {
  id: string;
  axis: "x" | "y";
  position: number;
}

export interface TimelineModel {
  id: string;
  frameRate: number;
  composition: CompositionSettings;
  guides: Guide[];
  /** Track order — index 0 is topmost/frontmost for visual compositing. Maintained exclusively by operations.ts (addTrack/removeTrack/reorderTrack). */
  trackIds: string[];
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
}

export function createTimeline(frameRate: number, composition: Partial<CompositionSettings> = {}): TimelineModel {
  if (!(frameRate > 0)) throw new Error(`frameRate must be > 0, got ${frameRate}.`);
  const comp = { ...DEFAULT_COMPOSITION, ...composition };
  validateCompositionSize(comp.width, comp.height);
  return { id: createId("timeline"), frameRate, composition: comp, guides: [], trackIds: [], tracks: {}, clips: {} };
}

/** Even, positive integers — every video codec this app encodes with requires even dimensions, so an odd size is rejected here rather than silently cropped at export. */
export function validateCompositionSize(width: number, height: number): void {
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(v) || v < 2 || v > 8192 || v % 2 !== 0) {
      throw new Error(`composition ${name} must be an even integer in [2, 8192], got ${v}.`);
    }
  }
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
