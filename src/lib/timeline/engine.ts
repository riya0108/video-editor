import { createHistory, pushHistory, undo as historyUndo, redo as historyRedo, canUndo as historyCanUndo, canRedo as historyCanRedo, type History } from "./history";
import { createTimeline, type TimelineModel } from "./model";
import {
  createSelection,
  select as selectOp,
  toggleSelect as toggleSelectOp,
  selectMany as selectManyOp,
  selectRange as selectRangeOp,
  clearSelection as clearSelectionOp,
  pruneSelection,
  type Selection,
} from "./selection";
import { TimelineEditError } from "./errors";
import type { Clip, ClipContent } from "./clip";
import type { Track, TrackKind } from "./track";
import * as ops from "./operations";

export type EditResult<TExtra extends object = object> =
  | ({ ok: true; timeline: TimelineModel } & TExtra)
  | { ok: false; error: TimelineEditError };

/**
 * The one public surface meant for real callers (eventually a UI layer —
 * none exists yet, per the brief). Wraps operations.ts (which throws) into
 * a Result-returning API, and ties model + history + selection together:
 *
 *  - Structural edits go through history (undo/redo-tracked) and are
 *    rejected as a typed Result, never an uncaught exception, on invalid
 *    usage (locked track, overlap, etc.) — see TIMELINE_ARCHITECTURE.md §8.
 *  - A failed edit never touches history — no corrupted/partial entries.
 *  - Selection changes are NOT history-tracked (§6) — they mutate the
 *    engine's own selection field directly, independent of undo/redo.
 *  - Deleting a clip also prunes it out of the current selection, so a
 *    stale id never lingers in `selection` pointing at nothing.
 */
export class TimelineEngine {
  private history: History<TimelineModel>;
  private _selection: Selection = createSelection();

  constructor(frameRate: number) {
    this.history = createHistory(createTimeline(frameRate));
  }

  get timeline(): TimelineModel {
    return this.history.present;
  }

  get selection(): Selection {
    return this._selection;
  }

  get canUndo(): boolean {
    return historyCanUndo(this.history);
  }

  get canRedo(): boolean {
    return historyCanRedo(this.history);
  }

  undo(): void {
    this.history = historyUndo(this.history);
    this._selection = pruneSelection(this._selection, this.timeline);
  }

  redo(): void {
    this.history = historyRedo(this.history);
    this._selection = pruneSelection(this._selection, this.timeline);
  }

  // --- selection: never history-tracked ---

  select(clipId: string): void {
    this._selection = selectOp(clipId);
  }

  toggleSelect(clipId: string): void {
    this._selection = toggleSelectOp(this._selection, clipId);
  }

  selectMany(clipIds: string[]): void {
    this._selection = selectManyOp(clipIds);
  }

  selectRange(trackId: string, startFrame: number, endFrame: number): void {
    this._selection = selectRangeOp(this.timeline, trackId, startFrame, endFrame);
  }

  clearSelection(): void {
    this._selection = clearSelectionOp();
  }

  // --- structural edits: history-tracked, Result-returning ---

  /** Pushes `next` onto history and prunes selection against it — the only place either happens, so every edit method stays consistent by construction. */
  private commit(next: TimelineModel): void {
    this.history = pushHistory(this.history, next);
    this._selection = pruneSelection(this._selection, next);
  }

  private run<TExtra extends Record<string, unknown>>(fn: () => { timeline: TimelineModel } & TExtra): EditResult<TExtra> {
    try {
      const result = fn();
      this.commit(result.timeline);
      return { ok: true, ...result } as EditResult<TExtra>;
    } catch (e) {
      if (e instanceof TimelineEditError) return { ok: false, error: e };
      throw e;
    }
  }

  private runVoid(fn: () => TimelineModel): EditResult {
    try {
      const next = fn();
      this.commit(next);
      return { ok: true, timeline: next };
    } catch (e) {
      if (e instanceof TimelineEditError) return { ok: false, error: e };
      throw e;
    }
  }

  addTrack(kind: TrackKind, name: string): EditResult<{ track: Track }> {
    return this.run(() => ops.addTrack(this.timeline, kind, name));
  }

  removeTrack(trackId: string): EditResult {
    return this.runVoid(() => ops.removeTrack(this.timeline, trackId));
  }

  reorderTrack(trackId: string, newIndex: number): EditResult {
    return this.runVoid(() => ops.reorderTrack(this.timeline, trackId, newIndex));
  }

  setTrackLocked(trackId: string, locked: boolean): EditResult {
    return this.runVoid(() => ops.setTrackLocked(this.timeline, trackId, locked));
  }

  setTrackVisible(trackId: string, visible: boolean): EditResult {
    return this.runVoid(() => ops.setTrackVisible(this.timeline, trackId, visible));
  }

  setTrackMuted(trackId: string, muted: boolean): EditResult {
    return this.runVoid(() => ops.setTrackMuted(this.timeline, trackId, muted));
  }

  setTrackSolo(trackId: string, solo: boolean): EditResult {
    return this.runVoid(() => ops.setTrackSolo(this.timeline, trackId, solo));
  }

  insertClip(trackId: string, content: ClipContent, timelineStart: number): EditResult<{ clip: Clip }> {
    return this.run(() => ops.insertClip(this.timeline, trackId, content, timelineStart));
  }

  trimClip(clipId: string, edge: "start" | "end", newFrame: number): EditResult {
    return this.runVoid(() => ops.trimClip(this.timeline, clipId, edge, newFrame));
  }

  splitClip(clipId: string, atFrame: number): EditResult<{ left: Clip; right: Clip }> {
    return this.run(() => ops.splitClip(this.timeline, clipId, atFrame));
  }

  moveClip(clipId: string, newTimelineStart: number, newTrackId?: string): EditResult {
    return this.runVoid(() => ops.moveClip(this.timeline, clipId, newTimelineStart, newTrackId));
  }

  duplicateClip(clipId: string, newTimelineStart?: number): EditResult<{ clip: Clip }> {
    return this.run(() => ops.duplicateClip(this.timeline, clipId, newTimelineStart));
  }

  deleteClip(clipId: string): EditResult {
    return this.runVoid(() => ops.deleteClip(this.timeline, clipId));
  }

  /** Multi-selection delete as one atomic op — one history entry, not N. */
  deleteClips(clipIds: string[]): EditResult {
    return this.runVoid(() => ops.deleteClips(this.timeline, clipIds));
  }

  /** Convenience: deletes every currently-selected clip in one undo step. */
  deleteSelectedClips(): EditResult {
    return this.deleteClips([...this._selection.selectedClipIds]);
  }
}
