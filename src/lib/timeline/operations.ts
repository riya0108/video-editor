import { TimelineEditError } from "./errors";
import { createId } from "./id";
import {
  clipDurationFrames,
  clipKind,
  clipTimelineEnd,
  isTrimmableContent,
  withContent,
  withTimelineStart,
  withTrackId,
  type Clip,
  type ClipContent,
} from "./clip";
import { createTrack, withTrack, type Track, type TrackKind } from "./track";
import { findOverlap, getClip, getTrack, getTrackClips, type TimelineModel } from "./model";

const MIN_CLIP_DURATION_FRAMES = 1;

function requireTrack(timeline: TimelineModel, trackId: string): Track {
  const track = getTrack(timeline, trackId);
  if (!track) throw new TimelineEditError("track-not-found", `No track with id "${trackId}".`);
  return track;
}

function requireClip(timeline: TimelineModel, clipId: string): Clip {
  const clip = getClip(timeline, clipId);
  if (!clip) throw new TimelineEditError("clip-not-found", `No clip with id "${clipId}".`);
  return clip;
}

function requireUnlocked(track: Track): void {
  if (track.locked) throw new TimelineEditError("track-locked", `Track "${track.id}" is locked.`);
}

function requireKindMatch(track: Track, content: ClipContent): void {
  if (track.kind !== content.kind) {
    throw new TimelineEditError("kind-mismatch", `Cannot place a "${content.kind}" clip on a "${track.kind}" track.`);
  }
}

function sortedByStart(clipIds: string[], clips: Record<string, Clip>): string[] {
  return [...clipIds].sort((a, b) => clips[a].timelineStart - clips[b].timelineStart);
}

/** Returns a new timeline with one track patched via `patch(track)` — the shared plumbing every track-touching op needs (replace one entry in the tracks map, leave everything else structurally shared). */
function withPatchedTrack(timeline: TimelineModel, trackId: string, patch: (track: Track) => Track): TimelineModel {
  return { ...timeline, tracks: { ...timeline.tracks, [trackId]: patch(timeline.tracks[trackId]) } };
}

function withPatchedClip(timeline: TimelineModel, clipId: string, patch: (clip: Clip) => Clip): TimelineModel {
  return { ...timeline, clips: { ...timeline.clips, [clipId]: patch(timeline.clips[clipId]) } };
}

// ---------------------------------------------------------------------------
// TRACK OPERATIONS
// ---------------------------------------------------------------------------

export function addTrack(timeline: TimelineModel, kind: TrackKind, name: string): { timeline: TimelineModel; track: Track } {
  const track = createTrack(kind, name);
  const next: TimelineModel = {
    ...timeline,
    trackIds: [...timeline.trackIds, track.id],
    tracks: { ...timeline.tracks, [track.id]: track },
  };
  return { timeline: next, track };
}

/** Removing a track cascades to every clip on it — there is no such thing as an orphaned clip in this model. */
export function removeTrack(timeline: TimelineModel, trackId: string): TimelineModel {
  const track = requireTrack(timeline, trackId);
  requireUnlocked(track);
  const clips = { ...timeline.clips };
  for (const clipId of track.clipIds) delete clips[clipId];
  const tracks = { ...timeline.tracks };
  delete tracks[trackId];
  return { ...timeline, trackIds: timeline.trackIds.filter((id) => id !== trackId), tracks, clips };
}

/** Reordering is a stacking/arrangement change, not a content edit — deliberately NOT blocked by track lock (lock protects clips, not the track's position in the stack). */
export function reorderTrack(timeline: TimelineModel, trackId: string, newIndex: number): TimelineModel {
  requireTrack(timeline, trackId);
  if (newIndex < 0 || newIndex >= timeline.trackIds.length) {
    throw new TimelineEditError("invalid-track-index", `Index ${newIndex} is out of range for ${timeline.trackIds.length} track(s).`);
  }
  const withoutTrack = timeline.trackIds.filter((id) => id !== trackId);
  withoutTrack.splice(newIndex, 0, trackId);
  return { ...timeline, trackIds: withoutTrack };
}

export function setTrackLocked(timeline: TimelineModel, trackId: string, locked: boolean): TimelineModel {
  requireTrack(timeline, trackId);
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { locked }));
}

export function setTrackVisible(timeline: TimelineModel, trackId: string, visible: boolean): TimelineModel {
  requireTrack(timeline, trackId);
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { visible }));
}

export function setTrackMuted(timeline: TimelineModel, trackId: string, muted: boolean): TimelineModel {
  requireTrack(timeline, trackId);
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { muted }));
}

export function setTrackSolo(timeline: TimelineModel, trackId: string, solo: boolean): TimelineModel {
  requireTrack(timeline, trackId);
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { solo }));
}

// ---------------------------------------------------------------------------
// CLIP PLACEMENT OPERATIONS
// ---------------------------------------------------------------------------

function contentDurationFrames(content: ClipContent): number {
  return isTrimmableContent(content) ? content.sourceOutFrame - content.sourceInFrame : content.durationFrames;
}

export function insertClip(timeline: TimelineModel, trackId: string, content: ClipContent, timelineStart: number): { timeline: TimelineModel; clip: Clip } {
  const track = requireTrack(timeline, trackId);
  requireUnlocked(track);
  requireKindMatch(track, content);
  if (timelineStart < 0) throw new TimelineEditError("out-of-range", "timelineStart must be >= 0.");

  const duration = contentDurationFrames(content);
  const conflict = findOverlap(timeline, trackId, timelineStart, timelineStart + duration);
  if (conflict) throw new TimelineEditError("overlap", `Placement overlaps existing clip "${conflict.id}" on track "${trackId}".`);

  const clip: Clip = { id: createId("clip"), trackId, timelineStart, content };
  const clips = { ...timeline.clips, [clip.id]: clip };
  const next: TimelineModel = {
    ...timeline,
    clips,
    tracks: { ...timeline.tracks, [trackId]: withTrack(track, { clipIds: sortedByStart([...track.clipIds, clip.id], clips) }) },
  };
  return { timeline: next, clip };
}

export function deleteClip(timeline: TimelineModel, clipId: string): TimelineModel {
  const clip = requireClip(timeline, clipId);
  const track = requireTrack(timeline, clip.trackId);
  requireUnlocked(track);

  const clips = { ...timeline.clips };
  delete clips[clipId];
  return {
    ...timeline,
    clips,
    tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds: track.clipIds.filter((id) => id !== clipId) }) },
  };
}

/**
 * Multi-selection delete, as ONE atomic operation (and therefore one undo
 * step, not N — see TIMELINE_ARCHITECTURE.md §8/testing strategy). Validates
 * every clip exists and every one of its tracks is unlocked BEFORE deleting
 * any of them: a batch that would partially fail never partially applies.
 */
export function deleteClips(timeline: TimelineModel, clipIds: string[]): TimelineModel {
  const clips = clipIds.map((id) => requireClip(timeline, id));
  const trackIds = new Set(clips.map((c) => c.trackId));
  for (const trackId of trackIds) requireUnlocked(requireTrack(timeline, trackId));

  const idsToDelete = new Set(clipIds);
  const nextClips = { ...timeline.clips };
  for (const id of idsToDelete) delete nextClips[id];

  const nextTracks = { ...timeline.tracks };
  for (const trackId of trackIds) {
    const track = nextTracks[trackId];
    nextTracks[trackId] = withTrack(track, { clipIds: track.clipIds.filter((id) => !idsToDelete.has(id)) });
  }
  return { ...timeline, clips: nextClips, tracks: nextTracks };
}

export function moveClip(timeline: TimelineModel, clipId: string, newTimelineStart: number, newTrackId?: string): TimelineModel {
  const clip = requireClip(timeline, clipId);
  const sourceTrack = requireTrack(timeline, clip.trackId);
  const targetTrackId = newTrackId ?? clip.trackId;
  const targetTrack = requireTrack(timeline, targetTrackId);
  requireUnlocked(sourceTrack);
  requireUnlocked(targetTrack);
  if (targetTrack.kind !== clipKind(clip)) {
    throw new TimelineEditError("kind-mismatch", `Cannot move a "${clipKind(clip)}" clip onto a "${targetTrack.kind}" track.`);
  }
  if (newTimelineStart < 0) throw new TimelineEditError("out-of-range", "timelineStart must be >= 0.");

  const duration = clipDurationFrames(clip);
  const conflict = findOverlap(timeline, targetTrackId, newTimelineStart, newTimelineStart + duration, clipId);
  if (conflict) throw new TimelineEditError("overlap", `Move would overlap existing clip "${conflict.id}" on track "${targetTrackId}".`);

  const movedClip = withTrackId(withTimelineStart(clip, newTimelineStart), targetTrackId);
  const clips = { ...timeline.clips, [clipId]: movedClip };

  if (targetTrackId === clip.trackId) {
    return { ...timeline, clips, tracks: { ...timeline.tracks, [targetTrackId]: withTrack(targetTrack, { clipIds: sortedByStart(targetTrack.clipIds, clips) }) } };
  }
  return {
    ...timeline,
    clips,
    tracks: {
      ...timeline.tracks,
      [sourceTrack.id]: withTrack(sourceTrack, { clipIds: sourceTrack.clipIds.filter((id) => id !== clipId) }),
      [targetTrackId]: withTrack(targetTrack, { clipIds: sortedByStart([...targetTrack.clipIds, clipId], clips) }),
    },
  };
}

/** Defaults to placing the duplicate immediately after the original (its own timelineEnd) when no explicit position is given. */
export function duplicateClip(timeline: TimelineModel, clipId: string, newTimelineStart?: number): { timeline: TimelineModel; clip: Clip } {
  const original = requireClip(timeline, clipId);
  const track = requireTrack(timeline, original.trackId);
  requireUnlocked(track);

  const targetStart = newTimelineStart ?? clipTimelineEnd(original);
  if (targetStart < 0) throw new TimelineEditError("out-of-range", "timelineStart must be >= 0.");

  const duration = clipDurationFrames(original);
  const conflict = findOverlap(timeline, track.id, targetStart, targetStart + duration);
  if (conflict) throw new TimelineEditError("overlap", `Duplicate would overlap existing clip "${conflict.id}" on track "${track.id}".`);

  const copy: Clip = { id: createId("clip"), trackId: track.id, timelineStart: targetStart, content: original.content };
  const clips = { ...timeline.clips, [copy.id]: copy };
  return {
    timeline: { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds: sortedByStart([...track.clipIds, copy.id], clips) }) } },
    clip: copy,
  };
}

// ---------------------------------------------------------------------------
// TRIM
// ---------------------------------------------------------------------------

/**
 * See TIMELINE_ARCHITECTURE.md §9 for the full semantics. Clamps rather than
 * rejects out-of-range requests (matches how a drag-to-trim handle actually
 * behaves — it stops at the limit, it doesn't refuse the gesture), but still
 * throws if the clamped result would overlap a neighboring clip.
 */
export function trimClip(timeline: TimelineModel, clipId: string, edge: "start" | "end", newFrame: number): TimelineModel {
  const clip = requireClip(timeline, clipId);
  const track = requireTrack(timeline, clip.trackId);
  requireUnlocked(track);

  const currentEnd = clipTimelineEnd(clip);

  if (edge === "end") {
    const minEnd = clip.timelineStart + MIN_CLIP_DURATION_FRAMES;
    let targetEnd = Math.max(minEnd, newFrame);
    let content: ClipContent;
    if (isTrimmableContent(clip.content)) {
      const requestedOut = clip.content.sourceInFrame + (targetEnd - clip.timelineStart);
      const maxOut = clip.content.source.sourceDurationFrames ?? Infinity;
      const clampedOut = Math.min(requestedOut, maxOut);
      targetEnd = clip.timelineStart + (clampedOut - clip.content.sourceInFrame);
      content = { ...clip.content, sourceOutFrame: clampedOut };
    } else {
      content = { ...clip.content, durationFrames: targetEnd - clip.timelineStart };
    }
    const conflict = findOverlap(timeline, track.id, clip.timelineStart, targetEnd, clipId);
    if (conflict) throw new TimelineEditError("overlap", `Trim would overlap existing clip "${conflict.id}".`);
    // Only the end moved — timelineStart (and therefore track.clipIds' sort order) is unaffected.
    return withPatchedClip(timeline, clipId, () => withContent(clip, content));
  }

  // edge === "start"
  const maxStart = currentEnd - MIN_CLIP_DURATION_FRAMES;
  let targetStart = Math.min(maxStart, Math.max(0, newFrame));
  let content: ClipContent;
  if (isTrimmableContent(clip.content)) {
    const delta = targetStart - clip.timelineStart;
    const requestedIn = clip.content.sourceInFrame + delta;
    const clampedIn = Math.max(0, requestedIn);
    targetStart = clip.timelineStart + (clampedIn - clip.content.sourceInFrame);
    content = { ...clip.content, sourceInFrame: clampedIn };
  } else {
    content = { ...clip.content, durationFrames: currentEnd - targetStart };
  }
  const conflict = findOverlap(timeline, track.id, targetStart, currentEnd, clipId);
  if (conflict) throw new TimelineEditError("overlap", `Trim would overlap existing clip "${conflict.id}".`);

  const updatedClip = withTimelineStart(withContent(clip, content), targetStart);
  const clips = { ...timeline.clips, [clipId]: updatedClip };
  return { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds: sortedByStart(track.clipIds, clips) }) } };
}

// ---------------------------------------------------------------------------
// SPLIT
// ---------------------------------------------------------------------------

/** See TIMELINE_ARCHITECTURE.md §9. The left piece keeps `clipId`; the right piece is newly created. Both pieces remain pure pointers into the same, untouched MediaSourceRef. */
export function splitClip(timeline: TimelineModel, clipId: string, atFrame: number): { timeline: TimelineModel; left: Clip; right: Clip } {
  const clip = requireClip(timeline, clipId);
  const track = requireTrack(timeline, clip.trackId);
  requireUnlocked(track);

  const end = clipTimelineEnd(clip);
  if (atFrame <= clip.timelineStart || atFrame >= end) {
    throw new TimelineEditError("invalid-split-point", `Split point ${atFrame} must be strictly inside [${clip.timelineStart}, ${end}).`);
  }

  const leftLengthFrames = atFrame - clip.timelineStart;
  let leftContent: ClipContent;
  let rightContent: ClipContent;
  if (isTrimmableContent(clip.content)) {
    const splitSourceFrame = clip.content.sourceInFrame + leftLengthFrames;
    leftContent = { ...clip.content, sourceOutFrame: splitSourceFrame };
    rightContent = { ...clip.content, sourceInFrame: splitSourceFrame };
  } else {
    leftContent = { ...clip.content, durationFrames: leftLengthFrames };
    rightContent = { ...clip.content, durationFrames: clip.content.durationFrames - leftLengthFrames };
  }

  const left: Clip = withContent(clip, leftContent);
  const right: Clip = { id: createId("clip"), trackId: track.id, timelineStart: atFrame, content: rightContent };

  const clips = { ...timeline.clips, [left.id]: left, [right.id]: right };
  const clipIds = sortedByStart([...track.clipIds, right.id], clips); // right.id wasn't in track.clipIds yet; left.id already was
  return {
    timeline: { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds }) } },
    left,
    right,
  };
}

// ---------------------------------------------------------------------------
// Clip-kind constructors re-export (for symmetry with track kinds in the public API surface)
// ---------------------------------------------------------------------------

export { getTrackClips };
