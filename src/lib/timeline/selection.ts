import { getTrackClips, rangesOverlap, type TimelineModel } from "./model";
import { clipTimelineEnd } from "./clip";

/**
 * Deliberately a value SEPARATE from TimelineModel, and deliberately never
 * pushed onto the undo/redo history (see TIMELINE_ARCHITECTURE.md §6) —
 * losing a multi-selection on Ctrl+Z would be a bug, not a feature.
 */
export interface Selection {
  selectedClipIds: ReadonlySet<string>;
}

export function createSelection(): Selection {
  return { selectedClipIds: new Set() };
}

export function isSelected(selection: Selection, clipId: string): boolean {
  return selection.selectedClipIds.has(clipId);
}

/** Replaces the selection with a single clip (the common click-without-modifier case). */
export function select(clipId: string): Selection {
  return { selectedClipIds: new Set([clipId]) };
}

/** Adds/removes one clip without disturbing the rest — the ctrl/cmd-click case. */
export function toggleSelect(selection: Selection, clipId: string): Selection {
  const next = new Set(selection.selectedClipIds);
  if (next.has(clipId)) next.delete(clipId);
  else next.add(clipId);
  return { selectedClipIds: next };
}

/** Replaces the selection with exactly this set of clips. */
export function selectMany(clipIds: string[]): Selection {
  return { selectedClipIds: new Set(clipIds) };
}

export function clearSelection(): Selection {
  return createSelection();
}

/** Every clip on `trackId` whose span intersects [startFrame, endFrame) — the natural rubber-band/shift-click selection over a single track. */
export function selectRange(timeline: TimelineModel, trackId: string, startFrame: number, endFrame: number): Selection {
  const matches = getTrackClips(timeline, trackId).filter((c) => rangesOverlap(startFrame, endFrame, c.timelineStart, clipTimelineEnd(c)));
  return selectMany(matches.map((c) => c.id));
}

/** Drops ids that no longer exist in the timeline (e.g. after a delete) — keeps selection internally consistent without the caller having to remember to do this. */
export function pruneSelection(selection: Selection, timeline: TimelineModel): Selection {
  const next = new Set<string>();
  for (const id of selection.selectedClipIds) {
    if (timeline.clips[id]) next.add(id);
  }
  return { selectedClipIds: next };
}
