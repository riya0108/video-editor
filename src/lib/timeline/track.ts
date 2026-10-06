import { createId } from "./id";
import type { ClipKind } from "./clip";
import type { CaptionTrackSettings } from "../captions/caption-model";

export type TrackKind = ClipKind;

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Ordered ascending by clip.timelineStart — maintained exclusively by operations.ts; nothing else should reorder this array. */
  clipIds: string[];
  locked: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
  /** caption tracks only (Phase 12): the shared caption look. Undefined = defaults. */
  caption?: CaptionTrackSettings;
}

export function createTrack(kind: TrackKind, name: string): Track {
  return {
    id: createId("track"),
    kind,
    name,
    clipIds: [],
    locked: false,
    visible: true,
    muted: false,
    solo: false,
  };
}

export function withTrack(track: Track, patch: Partial<Omit<Track, "id" | "kind">>): Track {
  return { ...track, ...patch };
}

/**
 * Derived, never stored. Soloing a track must never mutate any OTHER
 * track's `muted` flag (that would make un-soloing need to remember and
 * restore prior mute state — a classic stateful bug class). Instead,
 * audibility is computed fresh every time from the whole track set: if
 * ANY track is soloed, only soloed tracks are audible; otherwise a track
 * is audible iff it isn't muted. See TIMELINE_ARCHITECTURE.md §5.
 */
export function isTrackAudible(track: Track, allTracks: readonly Track[]): boolean {
  const anySoloed = allTracks.some((t) => t.solo);
  if (anySoloed) return track.solo;
  return !track.muted;
}
