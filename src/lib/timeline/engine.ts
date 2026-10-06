import { createHistory, pushHistory, undo as historyUndo, redo as historyRedo, canUndo as historyCanUndo, canRedo as historyCanRedo, type History } from "./history";
import { createTimeline, type CompositionSettings, type Guide, type TimelineModel } from "./model";
import type { ClipVisualPatch } from "./visual";
import type { EasingSpec } from "../animation/easing";
import type { Effect } from "../effects/model";
import type { Transition } from "../transitions/model";
import type { SubtitleCue } from "../captions/subtitle-io";
import type { CaptionTrackSettings, CaptionWordTiming } from "../captions/caption-model";
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

  constructor(frameRate: number, composition?: Partial<CompositionSettings>) {
    this.history = createHistory(createTimeline(frameRate, composition));
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

  /** Replaces the whole project (e.g. after deserializeTimeline) as a fresh history baseline with an empty selection. */
  loadTimeline(timeline: TimelineModel): void {
    this.history = createHistory(timeline);
    this._selection = createSelection();
  }

  /** Makes the current timeline the history baseline (nothing to undo). For a freshly loaded/constructed project, so "undo" can't take apart the project's own setup. */
  resetHistory(): void {
    this.history = createHistory(this.timeline);
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
      // Every edit leaves transitions consistent with the clips (dropped if their clips no longer meet, shortened if they shrank).
      const timeline = ops.reconcileTransitions(result.timeline);
      this.commit(timeline);
      return { ok: true, ...result, timeline } as EditResult<TExtra>;
    } catch (e) {
      if (e instanceof TimelineEditError) return { ok: false, error: e };
      throw e;
    }
  }

  private runVoid(fn: () => TimelineModel): EditResult {
    try {
      const next = ops.reconcileTransitions(fn());
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

  insertClip(trackId: string, content: ClipContent, timelineStart: number, visual?: ClipVisualPatch): EditResult<{ clip: Clip }> {
    return this.run(() => ops.insertClip(this.timeline, trackId, content, timelineStart, visual));
  }

  /** Keyframe-aware visual edit at the playhead (auto-key for animated properties). One undo step. */
  setClipVisualsAtFrame(patches: Readonly<Record<string, ClipVisualPatch>>, frame: number): EditResult {
    return this.runVoid(() => ops.setClipVisualsAtFrame(this.timeline, patches, frame));
  }

  addKeyframe(clipId: string, path: string, frame: number, value?: number, easing?: EasingSpec): EditResult {
    return this.runVoid(() => ops.addKeyframe(this.timeline, clipId, path, frame, value, easing));
  }

  removeKeyframe(clipId: string, path: string, keyframeId: string): EditResult {
    return this.runVoid(() => ops.removeKeyframe(this.timeline, clipId, path, keyframeId));
  }

  moveKeyframe(clipId: string, path: string, keyframeId: string, newFrame: number): EditResult {
    return this.runVoid(() => ops.moveKeyframe(this.timeline, clipId, path, keyframeId, newFrame));
  }

  updateKeyframe(clipId: string, path: string, keyframeId: string, patch: { value?: number; easing?: EasingSpec }): EditResult {
    return this.runVoid(() => ops.updateKeyframe(this.timeline, clipId, path, keyframeId, patch));
  }

  setPropertyAnimated(clipId: string, path: string, animated: boolean, frame: number): EditResult {
    return this.runVoid(() => ops.setPropertyAnimated(this.timeline, clipId, path, animated, frame));
  }

  addEffect(clipId: string, type: string, params?: Record<string, number>, index?: number): EditResult<{ effect: Effect }> {
    return this.run(() => ops.addEffect(this.timeline, clipId, type, params, index));
  }

  removeEffect(clipId: string, effectId: string): EditResult {
    return this.runVoid(() => ops.removeEffect(this.timeline, clipId, effectId));
  }

  moveEffect(clipId: string, effectId: string, newIndex: number): EditResult {
    return this.runVoid(() => ops.moveEffect(this.timeline, clipId, effectId, newIndex));
  }

  setEffectEnabled(clipId: string, effectId: string, enabled: boolean): EditResult {
    return this.runVoid(() => ops.setEffectEnabled(this.timeline, clipId, effectId, enabled));
  }

  updateEffectParams(clipId: string, effectId: string, patch: Record<string, number>, frame?: number): EditResult {
    return this.runVoid(() => ops.updateEffectParams(this.timeline, clipId, effectId, patch, frame));
  }

  /** Adds a transition at an edit point (between adjacent clips, or a clip's start/end). One undo step. */
  addTransition(opts: ops.AddTransitionOptions): EditResult<{ transition: Transition }> {
    return this.run(() => ops.addTransition(this.timeline, opts));
  }

  updateTransition(transitionId: string, patch: ops.TransitionPatch): EditResult {
    return this.runVoid(() => ops.updateTransition(this.timeline, transitionId, patch));
  }

  removeTransition(transitionId: string): EditResult {
    return this.runVoid(() => ops.removeTransition(this.timeline, transitionId));
  }

  /** Audio settings edit (volume/gain auto-key at `frame` when animated). One undo step. */
  setClipAudio(clipId: string, patch: ops.ClipAudioPatch, frame?: number): EditResult {
    return this.runVoid(() => ops.setClipAudio(this.timeline, clipId, patch, frame));
  }

  /** Peak-normalizes a clip to `targetDb` from its measured peak. One undo step. */
  normalizeClipAudio(clipId: string, peakDb: number, targetDb?: number): EditResult {
    return this.runVoid(() => ops.normalizeClipAudioOp(this.timeline, clipId, peakDb, targetDb));
  }

  // --- captions (Phase 12) ---

  addCaptionTrack(opts?: { name?: string; settings?: Partial<CaptionTrackSettings> }): EditResult<{ track: Track }> {
    return this.run(() => ops.addCaptionTrack(this.timeline, opts));
  }

  /** Places cues (speech-to-text / SRT / VTT) as captions on a new track, or replacing a track's captions. One undo step. */
  importCaptionCues(cues: readonly SubtitleCue[], opts?: Parameters<typeof ops.importCaptionCues>[2]): EditResult<{ trackId: string; clips: Clip[]; adjusted: number }> {
    return this.run(() => ops.importCaptionCues(this.timeline, cues, opts));
  }

  updateCaptionText(clipId: string, text: string): EditResult {
    return this.runVoid(() => ops.updateCaptionText(this.timeline, clipId, text));
  }

  setCaptionSpeaker(clipId: string, speaker: string | null): EditResult {
    return this.runVoid(() => ops.setCaptionSpeaker(this.timeline, clipId, speaker));
  }

  setCaptionWords(clipId: string, words: readonly CaptionWordTiming[] | null): EditResult {
    return this.runVoid(() => ops.setCaptionWords(this.timeline, clipId, words));
  }

  setCaptionTrackSettings(trackId: string, patch: ops.CaptionTrackPatch): EditResult {
    return this.runVoid(() => ops.setCaptionTrackSettings(this.timeline, trackId, patch));
  }

  applyCaptionPreset(trackId: string, presetId: string): EditResult {
    return this.runVoid(() => ops.applyCaptionPreset(this.timeline, trackId, presetId));
  }

  setCaptionTiming(clipId: string, startFrame: number, endFrame: number): EditResult {
    return this.runVoid(() => ops.setCaptionTiming(this.timeline, clipId, startFrame, endFrame));
  }

  mergeCaptionWithNext(clipId: string): EditResult {
    return this.runVoid(() => ops.mergeCaptionWithNext(this.timeline, clipId));
  }

  /** Multi-object visual edit — one undo step for the whole batch. */
  setClipVisuals(patches: Readonly<Record<string, ClipVisualPatch>>): EditResult {
    return this.runVoid(() => ops.setClipVisuals(this.timeline, patches));
  }

  /** Duplicates clips as new layers (same timing, stacked above), one undo step; selects the copies. */
  duplicateClipsAsLayers(clipIds: readonly string[], offset?: { x: number; y: number }): EditResult<{ clips: Clip[] }> {
    const r = this.run(() => ops.duplicateClipsAsLayers(this.timeline, clipIds, offset));
    if (r.ok) this.selectMany(r.clips.map((c) => c.id));
    return r;
  }

  setClipVisual(clipId: string, patch: ClipVisualPatch): EditResult {
    return this.runVoid(() => ops.setClipVisual(this.timeline, clipId, patch));
  }

  updateAuthoredContent(clipId: string, patch: ops.AuthoredContentPatch): EditResult {
    return this.runVoid(() => ops.updateAuthoredContent(this.timeline, clipId, patch));
  }

  addGuide(axis: Guide["axis"], position: number): EditResult<{ guide: Guide }> {
    return this.run(() => ops.addGuide(this.timeline, axis, position));
  }

  moveGuide(guideId: string, position: number): EditResult {
    return this.runVoid(() => ops.moveGuide(this.timeline, guideId, position));
  }

  removeGuide(guideId: string): EditResult {
    return this.runVoid(() => ops.removeGuide(this.timeline, guideId));
  }

  setCompositionSettings(patch: Partial<CompositionSettings>, reposition: "proportional" | "keep" = "proportional"): EditResult {
    return this.runVoid(() => ops.setCompositionSettings(this.timeline, patch, reposition));
  }

  /** Content and/or visual edits to several clips, one undo step. */
  editClips(edits: Readonly<Record<string, ops.ClipEdit>>, frame?: number): EditResult {
    return this.runVoid(() => ops.editClips(this.timeline, edits, frame));
  }

  moveKeyframesAtFrame(clipId: string, fromFrame: number, toFrame: number): EditResult {
    return this.runVoid(() => ops.moveKeyframesAtFrame(this.timeline, clipId, fromFrame, toFrame));
  }

  /** Adds a shape/SVG graphic at the front (own track) and selects it. One undo step. */
  addGraphicLayer(opts: Parameters<typeof ops.addGraphicLayer>[1]): EditResult<{ clip: Clip; track: Track }> {
    const r = this.run(() => ops.addGraphicLayer(this.timeline, opts));
    if (r.ok) this.select(r.clip.id);
    return r;
  }

  /** Adds a text layer at the front (own track) and selects it. One undo step. */
  addTextLayer(opts: Parameters<typeof ops.addTextLayer>[1]): EditResult<{ clip: Clip; track: Track }> {
    const r = this.run(() => ops.addTextLayer(this.timeline, opts));
    if (r.ok) this.select(r.clip.id);
    return r;
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
