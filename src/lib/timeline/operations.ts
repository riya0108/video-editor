import { TimelineEditError } from "./errors";
import { createId } from "./id";
import {
  clipDurationFrames,
  clipKind,
  clipTimelineEnd,
  hasVisual,
  isTrimmableContent,
  withContent,
  withTimelineStart,
  withTrackId,
  type AuthoredClipContent,
  type Clip,
  type ClipContent,
} from "./clip";
import { createTrack, withTrack, type Track, type TrackKind } from "./track";
import { findOverlap, getClip, getTrack, getTrackClips, validateCompositionSize, type CompositionSettings, type Guide, type TimelineModel } from "./model";
import { applyVisualPatch, defaultClipVisual, InvalidVisualError, type ClipVisual, type ClipVisualPatch, type ShapeSpec } from "./visual";
import { patchTextStyle, type TextStylePatch } from "./text-style";
import { createKeyframeId, shiftAnimation, sortKeyframes, upsertKeyframe, type KeyframeTrack } from "../animation/keyframes";
import { applyAnimation, getProperty, isAudioPath, valueAt, type AnimatableProperty } from "../animation/properties";
import { clampGainDb, clampVolume, clipAudioOf, isAudibleKind, normalizationFor, normalizeClipAudio, type ClipAudio } from "../audio/model";
import type { EasingSpec } from "../animation/easing";
import { clampParam, effectParamPath, normalizeParams, parseEffectPath, type Effect } from "../effects/model";
import { isEffectType } from "../effects/registry";
import { normalizeEasing } from "../animation/easing";
import {
  DEFAULT_TRANSITION_EASING,
  maxTransitionDuration,
  normalizeDirection,
  normalizeTransitionParams,
  transitionWindow,
  type Transition,
  type TransitionAlignment,
} from "../transitions/model";
import { getTransitionDefinition, isTransitionType, type TransitionDirection, type TransitionParams } from "../transitions/registry";
import { clipBaseVisual, withConcreteVisual } from "../captions/timeline-bridge";
import { ms, getCaptionPreset, normalizeCaptionStyle, normalizeCaptionTrackSettings, normalizeWords, retimeWords, splitCaptionText, type CaptionStyleSettings, type CaptionTrackSettings, type CaptionWordTiming } from "../captions/caption-model";
import type { SubtitleCue } from "../captions/subtitle-io";
import { applyMaskPatch, createMask, InvalidMaskError, isMaskParam, maskParamPath, parseMaskPath, type Mask, type MaskMode, type MaskPatch, type MaskPoint, type MaskShape, MASK_SHAPES } from "../masks/model";
import { normalizeShapeSpec, normalizeSvgSpec, patchShapeSpec, patchSvgSpec, type ShapePatch, type SvgPatch, type SvgSpec } from "./shape-style";

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

export function insertClip(
  timeline: TimelineModel,
  trackId: string,
  content: ClipContent,
  timelineStart: number,
  visual?: ClipVisualPatch,
): { timeline: TimelineModel; clip: Clip } {
  const track = requireTrack(timeline, trackId);
  requireUnlocked(track);
  requireKindMatch(track, content);
  if (timelineStart < 0) throw new TimelineEditError("out-of-range", "timelineStart must be >= 0.");

  const duration = contentDurationFrames(content);
  const conflict = findOverlap(timeline, trackId, timelineStart, timelineStart + duration);
  if (conflict) throw new TimelineEditError("overlap", `Placement overlaps existing clip "${conflict.id}" on track "${trackId}".`);

  const clip: Clip = { id: createId("clip"), trackId, timelineStart, content };
  if (visual) clip.visual = resolvePatchedVisual(timeline, clip, visual);
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

  // Spread (not a fresh literal) so the copy keeps every per-clip property — notably `visual` — rather than silently resetting the duplicate to default placement.
  const copy: Clip = { ...original, id: createId("clip"), trackId: track.id, timelineStart: targetStart };
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

  // Caption word timings are clip-relative: shift them so each word stays at the same timeline moment.
  if (content.kind === "caption" && content.words && targetStart !== clip.timelineStart) {
    const d = (targetStart - clip.timelineStart) / timeline.frameRate;
    content = { ...content, words: content.words.filter((w) => w.end > d).map((w) => ({ ...w, start: ms(Math.max(0, w.start - d)), end: ms(w.end - d) })) };
  }
  let updatedClip = withTimelineStart(withContent(clip, content), targetStart);
  // Keyframes are clip-relative: shift them so each stays at the same timeline (and media) moment.
  if (clip.animation && targetStart !== clip.timelineStart) updatedClip = { ...updatedClip, animation: shiftAnimation(clip.animation, clip.timelineStart - targetStart) };
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
  } else if (clip.content.kind === "caption") {
    // A caption splits its WORDS at the cut (by timing when it has it), not a copy of the whole sentence on both sides.
    const parts = splitCaptionText(clip.content.text ?? "", clip.content.words, leftLengthFrames / timeline.frameRate, clip.content.durationFrames / timeline.frameRate);
    leftContent = { ...clip.content, text: parts.left.text, durationFrames: leftLengthFrames, ...(parts.left.words ? { words: parts.left.words } : {}) };
    rightContent = { ...clip.content, text: parts.right.text, durationFrames: clip.content.durationFrames - leftLengthFrames, ...(parts.right.words ? { words: parts.right.words } : {}) };
  } else {
    leftContent = { ...clip.content, durationFrames: leftLengthFrames };
    rightContent = { ...clip.content, durationFrames: clip.content.durationFrames - leftLengthFrames };
  }

  const left: Clip = withContent(clip, leftContent);
  // Spread from the original so the right piece inherits `visual` (transform/crop/opacity/matte) — a split must never make half the clip jump to a different place on screen.
  const right: Clip = { ...clip, id: createId("clip"), timelineStart: atFrame, content: rightContent };
  // Both halves keep EVERY keyframe (the right one shifted to its new start), so each half evaluates exactly as the
  // original did over its range — pruning to the visible range and inserting boundary keys would change eased curves.
  if (clip.animation) right.animation = shiftAnimation(clip.animation, -leftLengthFrames);
  // Audio fades belong to the clip's outer edges: the left piece keeps the fade-in, the right piece the fade-out — so
  // the split is inaudible (no new fade at the cut).
  if (clip.audio) {
    left.audio = { ...clip.audio, fadeOutFrames: 0 };
    right.audio = { ...clip.audio, fadeInFrames: 0 };
  }

  const clips = { ...timeline.clips, [left.id]: left, [right.id]: right };
  const clipIds = sortedByStart([...track.clipIds, right.id], clips); // right.id wasn't in track.clipIds yet; left.id already was
  // The original clip's END edge now belongs to the right piece: its transition-out (or transition into the next clip) moves with it.
  let transitions = timeline.transitions;
  if (transitions && Object.values(transitions).some((t) => t.fromClipId === clipId)) {
    transitions = Object.fromEntries(Object.entries(transitions).map(([id, t]) => [id, t.fromClipId === clipId ? { ...t, fromClipId: right.id } : t]));
  }
  return {
    timeline: { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds }) }, ...(transitions ? { transitions } : {}) },
    left,
    right,
  };
}

// ---------------------------------------------------------------------------
// VISUAL / CONTENT PROPERTIES (composition engine inputs — see visual.ts)
// ---------------------------------------------------------------------------

function resolvePatchedVisual(timeline: TimelineModel, clip: Clip, patch: ClipVisualPatch): ClipVisual {
  if (!hasVisual(clip.content.kind)) {
    throw new TimelineEditError("kind-mismatch", `"${clip.content.kind}" clips have no visual properties.`);
  }
  const base = clipBaseVisual(timeline, clip);
  try {
    return applyVisualPatch(base, patch);
  } catch (e) {
    if (e instanceof InvalidVisualError) throw new TimelineEditError("invalid-visual", e.message);
    throw e;
  }
}

/** Transform/crop/opacity/blend/fit/matte edit. Deep-merges the patch onto the clip's current (or default) visual. */
export function setClipVisual(timeline: TimelineModel, clipId: string, patch: ClipVisualPatch): TimelineModel {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  const visual = resolvePatchedVisual(timeline, clip, patch);
  return withPatchedClip(timeline, clipId, (c) => ({ ...c, visual }));
}

/**
 * Visual edits to several clips as ONE atomic operation (one undo step) —
 * multi-object move/nudge/align. Every clip and its track lock are validated
 * and every patch is applied BEFORE anything is committed: a batch that would
 * partially fail never partially applies (same contract as deleteClips).
 */
export function setClipVisuals(timeline: TimelineModel, patches: Readonly<Record<string, ClipVisualPatch>>): TimelineModel {
  const next: Record<string, Clip> = {};
  for (const [clipId, patch] of Object.entries(patches)) {
    const clip = requireClip(timeline, clipId);
    requireUnlocked(requireTrack(timeline, clip.trackId));
    next[clipId] = { ...clip, visual: resolvePatchedVisual(timeline, clip, patch) };
  }
  return { ...timeline, clips: { ...timeline.clips, ...next } };
}

/**
 * "Duplicate" as a canvas editor means it: a second, independent LAYER with
 * the same timing, stacked directly above the original — not a copy placed
 * later in time (that's duplicateClip). Each copy gets its own new track of
 * the same kind (a track can't hold two overlapping clips), inherits the
 * original's visual, and is offset by `offset` composition px so it's
 * visibly distinct. One atomic op / one undo step for the whole batch.
 * Copies share the original's MediaSourceRef — the source is never copied.
 */
export function duplicateClipsAsLayers(
  timeline: TimelineModel,
  clipIds: readonly string[],
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { timeline: TimelineModel; clips: Clip[] } {
  let tl = timeline;
  const created: Clip[] = [];
  for (const clipId of clipIds) {
    const original = requireClip(tl, clipId);
    const sourceTrack = requireTrack(tl, original.trackId);
    const { timeline: withTrack_, track } = addTrack(tl, sourceTrack.kind, `${sourceTrack.name} copy`);
    tl = reorderTrack(withTrack_, track.id, tl.trackIds.indexOf(sourceTrack.id));
    const visual = hasVisual(original.content.kind)
      ? applyVisualPatch(original.visual ?? defaultClipVisual(tl.composition.width, tl.composition.height), {
          transform: {
            x: (original.visual?.transform.x ?? tl.composition.width / 2) + offset.x,
            y: (original.visual?.transform.y ?? tl.composition.height / 2) + offset.y,
          },
        })
      : undefined;
    const copy: Clip = { ...original, id: createId("clip"), trackId: track.id, ...(visual ? { visual } : {}) };
    // An animated position must be offset too, or the copy would sit exactly on the original whenever it's animating.
    if (original.animation && (offset.x || offset.y)) {
      const tracks = { ...original.animation.tracks };
      for (const [path, d] of [["visual.transform.x", offset.x], ["visual.transform.y", offset.y]] as const) {
        if (tracks[path] && d) tracks[path] = { keyframes: tracks[path].keyframes.map((k) => ({ ...k, id: createKeyframeId(), value: k.value + d })) };
      }
      copy.animation = { tracks };
    }
    tl = {
      ...tl,
      clips: { ...tl.clips, [copy.id]: copy },
      tracks: { ...tl.tracks, [track.id]: withTrack(tl.tracks[track.id], { clipIds: [copy.id] }) },
    };
    created.push(copy);
  }
  return { timeline: tl, clips: created };
}

export interface AuthoredContentPatch {
  text?: string;
  textStyle?: TextStylePatch;
  shape?: ShapePatch;
  svg?: SvgPatch;
}

/** Text/text-style/shape edits on timeline-authored content. Duration and source are deliberately not patchable here — those are trim/replace operations with their own invariants. */
export function updateAuthoredContent(
  timeline: TimelineModel,
  clipId: string,
  patch: AuthoredContentPatch,
): TimelineModel {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  const content = clip.content;
  if (isTrimmableContent(content)) {
    throw new TimelineEditError("kind-mismatch", `"${content.kind}" clips have no authored text/shape content.`);
  }
  if ((patch.text !== undefined || patch.textStyle) && content.kind !== "text") {
    throw new TimelineEditError("kind-mismatch", "text/textStyle only apply to text clips.");
  }
  if (patch.shape && !(content.kind === "graphic" && content.shape)) {
    throw new TimelineEditError("kind-mismatch", "shape only applies to shape graphic clips.");
  }
  if (patch.svg && !(content.kind === "graphic" && content.svg)) {
    throw new TimelineEditError("kind-mismatch", "svg only applies to SVG graphic clips.");
  }
  const next: ClipContent = { ...content };
  if (patch.text !== undefined) next.text = patch.text;
  if (patch.textStyle) next.textStyle = patchTextStyle(content.textStyle, patch.textStyle);
  if (patch.shape && content.shape) next.shape = patchShapeSpec(content.shape, patch.shape);
  if (patch.svg && content.svg) next.svg = patchSvgSpec(normalizeSvgSpec(content.svg) ?? content.svg, patch.svg);
  return withPatchedClip(timeline, clipId, (c) => withContent(c, next));
}

/**
 * Changes output resolution/background. Not blocked by any track lock (it's
 * project-level).
 *
 * `reposition` (only matters when the size changes):
 *  - "proportional" (default): every explicit layer position and every guide
 *    is scaled by the size ratio, so layout survives an aspect change — a
 *    lower-third stays a lower-third, centered text stays centered, going
 *    1920x1080 <-> 1080x1920 <-> 1080x1080. Sizes are NOT scaled.
 *  - "keep": positions keep their raw composition-px values.
 * Clips on the derived default visual re-center automatically either way.
 */
export function setCompositionSettings(
  timeline: TimelineModel,
  patch: Partial<CompositionSettings>,
  reposition: "proportional" | "keep" = "proportional",
): TimelineModel {
  const composition = { ...timeline.composition, ...patch };
  try {
    validateCompositionSize(composition.width, composition.height);
  } catch (e) {
    throw new TimelineEditError("out-of-range", (e as Error).message);
  }
  const kx = composition.width / timeline.composition.width;
  const ky = composition.height / timeline.composition.height;
  if (reposition === "keep" || (kx === 1 && ky === 1)) return { ...timeline, composition };
  const clips: Record<string, Clip> = {};
  for (const [id, c] of Object.entries(timeline.clips)) {
    clips[id] = c.visual ? { ...c, visual: { ...c.visual, transform: { ...c.visual.transform, x: c.visual.transform.x * kx, y: c.visual.transform.y * ky } } } : c;
  }
  const guides = timeline.guides.map((g) => ({ ...g, position: g.position * (g.axis === "x" ? kx : ky) }));
  return { ...timeline, composition, clips, guides };
}

/** One clip's combined edit: content (text/style/shape) and/or visual. */
export interface ClipEdit {
  content?: AuthoredContentPatch;
  visual?: ClipVisualPatch;
}

/**
 * Content + visual edits to one or more clips as ONE atomic operation (one
 * undo step). Needed whenever a single gesture changes both — e.g. resizing a
 * text box changes its width (content) AND its position (visual, to keep the
 * opposite edge pinned). All-or-nothing, like setClipVisuals.
 */
export function editClips(timeline: TimelineModel, edits: Readonly<Record<string, ClipEdit>>, frame?: number): TimelineModel {
  let tl = timeline;
  for (const [clipId, edit] of Object.entries(edits)) {
    if (edit.content) tl = updateAuthoredContent(tl, clipId, edit.content);
    // With a playhead frame, the visual part is keyframe-aware (auto-key on animated properties) like every other edit.
    if (edit.visual) tl = frame === undefined ? setClipVisual(tl, clipId, edit.visual) : setClipVisualsAtFrame(tl, { [clipId]: edit.visual }, frame);
  }
  return tl;
}

/**
 * ADD GRAPHIC: a new shape or SVG graphic on its own new graphic track at the
 * FRONT, starting at `atFrame`. One atomic op / one undo step. The spec is
 * normalized on the way in, like every other entry point.
 */
export function addGraphicLayer(
  timeline: TimelineModel,
  opts: { graphic: { shape: ShapeSpec } | { svg: SvgSpec }; atFrame: number; durationFrames: number; visual?: ClipVisualPatch; name?: string },
): { timeline: TimelineModel; clip: Clip; track: Track } {
  let graphic: { shape: ShapeSpec } | { svg: SvgSpec };
  if ("shape" in opts.graphic) graphic = { shape: normalizeShapeSpec(opts.graphic.shape) };
  else {
    const svg = normalizeSvgSpec(opts.graphic.svg);
    if (!svg) throw new TimelineEditError("invalid-visual", "That SVG couldn't be read.");
    graphic = { svg };
  }
  const name = opts.name ?? ("shape" in graphic ? graphic.shape.type[0].toUpperCase() + graphic.shape.type.slice(1) : "SVG graphic");
  const added = addTrack(timeline, "graphic", name);
  const tl = reorderTrack(added.timeline, added.track.id, 0);
  const content: ClipContent = { kind: "graphic", ...graphic, durationFrames: Math.max(1, Math.round(opts.durationFrames)) };
  const r = insertClip(tl, added.track.id, content, Math.max(0, Math.round(opts.atFrame)), opts.visual);
  return { timeline: r.timeline, clip: r.clip, track: r.timeline.tracks[added.track.id] };
}

/**
 * ADD TEXT: a new text layer on its own new text track at the FRONT of the
 * stack, starting at `atFrame`. One atomic op / one undo step (track + clip).
 * Text tracks are cheap; giving every new text its own track means it can
 * never be rejected for overlapping existing text.
 */
export function addTextLayer(
  timeline: TimelineModel,
  opts: { text: string; atFrame: number; durationFrames: number; style?: TextStylePatch; visual?: ClipVisualPatch; name?: string },
): { timeline: TimelineModel; clip: Clip; track: Track } {
  const added = addTrack(timeline, "text", opts.name ?? "Text");
  const tl = reorderTrack(added.timeline, added.track.id, 0);
  const content: ClipContent = { kind: "text", text: opts.text, textStyle: patchTextStyle(undefined, opts.style ?? {}), durationFrames: Math.max(1, Math.round(opts.durationFrames)) };
  const r = insertClip(tl, added.track.id, content, Math.max(0, Math.round(opts.atFrame)), opts.visual);
  return { timeline: r.timeline, clip: r.clip, track: r.timeline.tracks[added.track.id] };
}

// ---------------------------------------------------------------------------
// KEYFRAMES (KEYFRAME_ENGINE_ARCHITECTURE.md §5). Frames passed in are ABSOLUTE timeline frames; keyframes are stored
// clip-relative. All ops are pure, validate everything first, and reject locked tracks.
// ---------------------------------------------------------------------------

function requireAnimatableClip(timeline: TimelineModel, clipId: string, path: string): { clip: Clip; prop: AnimatableProperty } {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  // Sound properties (audio.*) animate on clips that carry sound; picture properties on visual clips.
  if (isAudioPath(path) ? !isAudibleKind(clip.content.kind) : !hasVisual(clip.content.kind)) {
    throw new TimelineEditError("kind-mismatch", `"${clip.content.kind}" clips have no animatable "${path}".`);
  }
  const prop = getProperty(path);
  if (!prop) throw new TimelineEditError("invalid-keyframe", `"${path}" isn't an animatable property.`);
  // A caption keyframed for the first time gets its on-screen placement made concrete, so nothing jumps.
  return { clip: isAudioPath(path) ? clip : withConcreteVisual(timeline, clip), prop };
}

function requireLocalFrame(frame: number, clip: Clip): number {
  if (!Number.isFinite(frame)) throw new TimelineEditError("invalid-keyframe", "Keyframe frame must be finite.");
  return Math.round(frame) - clip.timelineStart;
}

function withTrack_(clip: Clip, path: string, track: KeyframeTrack | null): Clip {
  const tracks = { ...(clip.animation?.tracks ?? {}) };
  if (track && track.keyframes.length > 0) tracks[path] = track;
  else delete tracks[path];
  const next = { ...clip };
  if (Object.keys(tracks).length > 0) next.animation = { tracks };
  else delete next.animation;
  return next;
}

/** Adds (or replaces) a keyframe at an absolute frame. `value` defaults to the property's current value there, so "add keyframe" never makes the layer jump. */
export function addKeyframe(timeline: TimelineModel, clipId: string, path: string, frame: number, value?: number, easing?: EasingSpec): TimelineModel {
  const { clip } = requireAnimatableClip(timeline, clipId, path);
  const local = requireLocalFrame(frame, clip);
  const v = value ?? valueAt(clip, path, local, timeline.composition);
  if (!Number.isFinite(v)) throw new TimelineEditError("invalid-keyframe", "Keyframe value must be finite.");
  const track = upsertKeyframe(clip.animation?.tracks[path], local, v, easing);
  return withPatchedClip(timeline, clipId, () => withTrack_(clip, path, track));
}

/** Removes a keyframe. Removing a property's LAST keyframe makes it static at that keyframe's value (the layer doesn't jump). */
export function removeKeyframe(timeline: TimelineModel, clipId: string, path: string, keyframeId: string): TimelineModel {
  const { clip, prop } = requireAnimatableClip(timeline, clipId, path);
  const track = clip.animation?.tracks[path];
  const kf = track?.keyframes.find((k) => k.id === keyframeId);
  if (!track || !kf) throw new TimelineEditError("invalid-keyframe", `No keyframe "${keyframeId}" on "${path}".`);
  const rest = track.keyframes.filter((k) => k.id !== keyframeId);
  let next = withTrack_(clip, path, { keyframes: rest });
  if (rest.length === 0) next = prop.set(next, kf.value, timeline.composition);
  return withPatchedClip(timeline, clipId, () => next);
}

/** Moves a keyframe to another absolute frame. Rejects landing on another keyframe of the same property. */
export function moveKeyframe(timeline: TimelineModel, clipId: string, path: string, keyframeId: string, newFrame: number): TimelineModel {
  const { clip } = requireAnimatableClip(timeline, clipId, path);
  const local = requireLocalFrame(newFrame, clip);
  const track = clip.animation?.tracks[path];
  const kf = track?.keyframes.find((k) => k.id === keyframeId);
  if (!track || !kf) throw new TimelineEditError("invalid-keyframe", `No keyframe "${keyframeId}" on "${path}".`);
  if (track.keyframes.some((k) => k.id !== keyframeId && k.frame === local)) throw new TimelineEditError("keyframe-conflict", `"${path}" already has a keyframe at that frame.`);
  const moved = { keyframes: sortKeyframes(track.keyframes.map((k) => (k.id === keyframeId ? { ...k, frame: local } : k))) };
  return withPatchedClip(timeline, clipId, () => withTrack_(clip, path, moved));
}

/** Edits a keyframe's value and/or easing. */
export function updateKeyframe(timeline: TimelineModel, clipId: string, path: string, keyframeId: string, patch: { value?: number; easing?: EasingSpec }): TimelineModel {
  const { clip } = requireAnimatableClip(timeline, clipId, path);
  const track = clip.animation?.tracks[path];
  if (!track?.keyframes.some((k) => k.id === keyframeId)) throw new TimelineEditError("invalid-keyframe", `No keyframe "${keyframeId}" on "${path}".`);
  if (patch.value !== undefined && !Number.isFinite(patch.value)) throw new TimelineEditError("invalid-keyframe", "Keyframe value must be finite.");
  const next = { keyframes: track.keyframes.map((k) => (k.id === keyframeId ? { ...k, ...(patch.value !== undefined ? { value: patch.value } : {}), ...(patch.easing ? { easing: patch.easing } : {}) } : k)) };
  return withPatchedClip(timeline, clipId, () => withTrack_(clip, path, next));
}

/** Moves EVERY property's keyframe at `fromFrame` to `toFrame` (a timeline diamond drag) — one atomic op. Rejects if any property already has a key at the destination. */
export function moveKeyframesAtFrame(timeline: TimelineModel, clipId: string, fromFrame: number, toFrame: number): TimelineModel {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  const from = Math.round(fromFrame) - clip.timelineStart;
  const to = Math.round(toFrame) - clip.timelineStart;
  if (!clip.animation || from === to) return timeline;
  const tracks: Record<string, KeyframeTrack> = {};
  let moved = 0;
  for (const [path, t] of Object.entries(clip.animation.tracks)) {
    const k = t.keyframes.find((x) => x.frame === from);
    if (k && t.keyframes.some((x) => x !== k && x.frame === to)) throw new TimelineEditError("keyframe-conflict", `"${path}" already has a keyframe at that frame.`);
    tracks[path] = k ? { keyframes: sortKeyframes(t.keyframes.map((x) => (x === k ? { ...x, frame: to } : x))) } : t;
    if (k) moved++;
  }
  if (moved === 0) throw new TimelineEditError("invalid-keyframe", "No keyframes at that frame.");
  return withPatchedClip(timeline, clipId, () => ({ ...clip, animation: { tracks } }));
}

/**
 * The "stopwatch". On: start animating with one keyframe at `frame` holding the current value (no visual change).
 * Off: drop all keyframes and keep the value showing at `frame` as the static value (no jump at the playhead).
 */
export function setPropertyAnimated(timeline: TimelineModel, clipId: string, path: string, animated: boolean, frame: number): TimelineModel {
  const { clip, prop } = requireAnimatableClip(timeline, clipId, path);
  const local = requireLocalFrame(frame, clip);
  const isAnimated = !!clip.animation?.tracks[path]?.keyframes.length;
  if (animated === isAnimated) return timeline;
  const current = valueAt(clip, path, local, timeline.composition);
  if (animated) return withPatchedClip(timeline, clipId, () => withTrack_(clip, path, upsertKeyframe(undefined, local, current)));
  return withPatchedClip(timeline, clipId, () => prop.set(withTrack_(clip, path, null), current, timeline.composition));
}

/**
 * KEYFRAME-AWARE VISUAL EDIT (auto-key) — what every existing editing path (drag, handles, keys, numeric fields,
 * alignment) commits through. `patches` are relative to what the user SEES at `frame` (the evaluated values). For each
 * changed registered property: animated -> upsert a keyframe at the playhead; static -> change the base value (exactly
 * the pre-animation behavior). Non-animatable fields always change the base. One atomic op, one undo step.
 */
export function setClipVisualsAtFrame(timeline: TimelineModel, patches: Readonly<Record<string, ClipVisualPatch>>, frame: number): TimelineModel {
  const comp = timeline.composition;
  const next: Record<string, Clip> = {};
  for (const [clipId, patch] of Object.entries(patches)) {
    const clip = requireClip(timeline, clipId);
    requireUnlocked(requireTrack(timeline, clip.trackId));
    if (!clip.animation) {
      next[clipId] = { ...clip, visual: resolvePatchedVisual(timeline, clip, patch) };
      continue;
    }
    const local = Math.round(frame) - clip.timelineStart;
    const evaluated = applyAnimation(clip, local, comp);
    const edited = resolvePatchedVisual(timeline, evaluated, patch); // validated, full visual as seen at the playhead
    // Base = the edit, except animated properties keep their stored base values (their change goes into keyframes).
    let out: Clip = { ...clip, visual: edited };
    for (const path of Object.keys(clip.animation.tracks)) {
      const prop = getProperty(path);
      if (!prop) continue;
      out = prop.set(out, prop.get(clip, comp), comp);
      const newValue = prop.get({ ...clip, visual: edited }, comp);
      if (Math.abs(newValue - prop.get(evaluated, comp)) > 1e-9) {
        out = withTrack_(out, path, upsertKeyframe(out.animation?.tracks[path], local, newValue));
      }
    }
    next[clipId] = out;
  }
  return { ...timeline, clips: { ...timeline.clips, ...next } };
}

// ---------------------------------------------------------------------------
// EFFECTS (EFFECTS_ENGINE_ARCHITECTURE.md §4) — pure, validated first, locked tracks rejected.
// ---------------------------------------------------------------------------

function requireEffectClip(timeline: TimelineModel, clipId: string): Clip {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  if (!hasVisual(clip.content.kind)) throw new TimelineEditError("kind-mismatch", `"${clip.content.kind}" clips can't have visual effects.`);
  return clip;
}

function requireEffect(clip: Clip, effectId: string): { effect: Effect; index: number } {
  const index = clip.effects?.findIndex((e) => e.id === effectId) ?? -1;
  if (index < 0) throw new TimelineEditError("effect-not-found", `No effect "${effectId}" on clip "${clip.id}".`);
  return { effect: clip.effects![index], index };
}

/** Adds an effect (default params, overridable) at `index` (default: bottom of the stack = runs last). */
export function addEffect(timeline: TimelineModel, clipId: string, type: string, params?: Record<string, number>, index?: number): { timeline: TimelineModel; effect: Effect } {
  const clip = requireEffectClip(timeline, clipId);
  if (!isEffectType(type)) throw new TimelineEditError("effect-not-found", `Unknown effect type "${type}".`);
  const effect: Effect = { id: createId("fx"), type, params: normalizeParams(type, params ?? {}), enabled: true };
  const list = [...(clip.effects ?? [])];
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(list.length, index)), 0, effect);
  return { timeline: withPatchedClip(timeline, clipId, () => ({ ...clip, effects: list })), effect };
}

/** Removes an effect and its keyframe tracks (no orphaned animation). */
export function removeEffect(timeline: TimelineModel, clipId: string, effectId: string): TimelineModel {
  const clip = requireEffectClip(timeline, clipId);
  requireEffect(clip, effectId);
  const effects = clip.effects!.filter((e) => e.id !== effectId);
  let next: Clip = { ...clip, effects };
  if (effects.length === 0) delete next.effects;
  if (clip.animation) {
    const tracks = Object.fromEntries(Object.entries(clip.animation.tracks).filter(([p]) => parseEffectPath(p)?.effectId !== effectId));
    next = { ...next, animation: { tracks } };
    if (Object.keys(tracks).length === 0) delete next.animation;
  }
  return withPatchedClip(timeline, clipId, () => next);
}

/** Reorders the stack (order = index; top runs first). */
export function moveEffect(timeline: TimelineModel, clipId: string, effectId: string, newIndex: number): TimelineModel {
  const clip = requireEffectClip(timeline, clipId);
  const { effect, index } = requireEffect(clip, effectId);
  if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= clip.effects!.length) throw new TimelineEditError("out-of-range", `Effect index ${newIndex} is out of range.`);
  if (newIndex === index) return timeline;
  const list = clip.effects!.filter((e) => e.id !== effectId);
  list.splice(newIndex, 0, effect);
  return withPatchedClip(timeline, clipId, () => ({ ...clip, effects: list }));
}

export function setEffectEnabled(timeline: TimelineModel, clipId: string, effectId: string, enabled: boolean): TimelineModel {
  const clip = requireEffectClip(timeline, clipId);
  requireEffect(clip, effectId);
  return withPatchedClip(timeline, clipId, () => ({ ...clip, effects: clip.effects!.map((e) => (e.id === effectId ? { ...e, enabled } : e)) }));
}

/**
 * Edits effect params. With a playhead `frame`, it's keyframe-aware like every other edit (Phase 8 auto-key): an
 * animated param gets a keyframe at the playhead, a static one changes its value. Values are clamped to the definition.
 */
export function updateEffectParams(timeline: TimelineModel, clipId: string, effectId: string, patch: Record<string, number>, frame?: number): TimelineModel {
  const clip = requireEffectClip(timeline, clipId);
  const { effect } = requireEffect(clip, effectId);
  let next: Clip = clip;
  const staticPatch: Record<string, number> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in effect.params)) throw new TimelineEditError("effect-not-found", `Effect "${effect.type}" has no parameter "${key}".`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TimelineEditError("out-of-range", `"${key}" must be a finite number.`);
    const v = clampParam(effect.type, key, value);
    const path = effectParamPath(effectId, key);
    const track = clip.animation?.tracks[path];
    if (frame !== undefined && track?.keyframes.length) next = withTrack_(next, path, upsertKeyframe(next.animation?.tracks[path], Math.round(frame) - clip.timelineStart, v));
    else staticPatch[key] = v;
  }
  if (Object.keys(staticPatch).length) next = { ...next, effects: next.effects!.map((e) => (e.id === effectId ? { ...e, params: { ...e.params, ...staticPatch } } : e)) };
  return withPatchedClip(timeline, clipId, () => next);
}

// ---------------------------------------------------------------------------
// MASKS (MASK_COMPOSITING_ARCHITECTURE.md §5) — pure, validated first, locked tracks rejected, one undo step each.
// ---------------------------------------------------------------------------

function requireMaskClip(timeline: TimelineModel, clipId: string): Clip {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  if (!hasVisual(clip.content.kind)) throw new TimelineEditError("kind-mismatch", `"${clip.content.kind}" clips can't have masks.`);
  return clip;
}

function requireMask(clip: Clip, maskId: string): { mask: Mask; index: number } {
  const index = clip.masks?.findIndex((m) => m.id === maskId) ?? -1;
  if (index < 0) throw new TimelineEditError("mask-not-found", `No mask "${maskId}" on clip "${clip.id}".`);
  return { mask: clip.masks![index], index };
}

function asMaskEditError(e: unknown): never {
  if (e instanceof InvalidMaskError) throw new TimelineEditError("invalid-mask", e.message);
  throw e;
}

export interface AddMaskOptions {
  /** polygon/freeform: vertices in normalized LAYER space (what was drawn over the layer). Omitted = a default shape. */
  layerPoints?: MaskPoint[];
  mode?: MaskMode;
  /** Initial overrides (box, feather, inversion...). */
  patch?: MaskPatch;
  /** Insert position (default: bottom of the list = combines last). */
  index?: number;
}

/** Adds a mask (rectangle/ellipse default to the middle 60% of the layer). */
export function addMask(timeline: TimelineModel, clipId: string, type: MaskShape, opts: AddMaskOptions = {}): { timeline: TimelineModel; mask: Mask } {
  const clip = requireMaskClip(timeline, clipId);
  if (!MASK_SHAPES.includes(type)) throw new TimelineEditError("invalid-mask", `Unknown mask shape "${String(type)}".`);
  let mask: Mask;
  try {
    mask = createMask(createId("mask"), type, { layerPoints: opts.layerPoints, mode: opts.mode });
    if (opts.patch) mask = applyMaskPatch(mask, opts.patch);
  } catch (e) {
    asMaskEditError(e);
  }
  const list = [...(clip.masks ?? [])];
  list.splice(opts.index === undefined ? list.length : Math.max(0, Math.min(list.length, Math.round(opts.index))), 0, mask);
  return { timeline: withPatchedClip(timeline, clipId, () => ({ ...clip, masks: list })), mask };
}

/** Removes a mask and its keyframe tracks (no orphaned animation). */
export function removeMask(timeline: TimelineModel, clipId: string, maskId: string): TimelineModel {
  const clip = requireMaskClip(timeline, clipId);
  requireMask(clip, maskId);
  const masks = clip.masks!.filter((m) => m.id !== maskId);
  let next: Clip = { ...clip, masks };
  if (masks.length === 0) delete next.masks;
  if (clip.animation) {
    const tracks = Object.fromEntries(Object.entries(clip.animation.tracks).filter(([p]) => parseMaskPath(p)?.maskId !== maskId));
    next = { ...next, animation: { tracks } };
    if (Object.keys(tracks).length === 0) delete next.animation;
  }
  return withPatchedClip(timeline, clipId, () => next);
}

/** Reorders the list (order matters: each mask combines into the result of the ones above it). */
export function moveMask(timeline: TimelineModel, clipId: string, maskId: string, newIndex: number): TimelineModel {
  const clip = requireMaskClip(timeline, clipId);
  const { mask, index } = requireMask(clip, maskId);
  if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= clip.masks!.length) throw new TimelineEditError("out-of-range", `Mask index ${newIndex} is out of range.`);
  if (newIndex === index) return timeline;
  const list = clip.masks!.filter((m) => m.id !== maskId);
  list.splice(newIndex, 0, mask);
  return withPatchedClip(timeline, clipId, () => ({ ...clip, masks: list }));
}

/** Copies a mask (new id, same keyframes) directly below the original. */
export function duplicateMask(timeline: TimelineModel, clipId: string, maskId: string): { timeline: TimelineModel; mask: Mask } {
  const clip = requireMaskClip(timeline, clipId);
  const { mask, index } = requireMask(clip, maskId);
  const copy: Mask = { ...mask, id: createId("mask"), ...(mask.points ? { points: mask.points.map((p) => ({ ...p })) } : {}) };
  const list = [...clip.masks!];
  list.splice(index + 1, 0, copy);
  let next: Clip = { ...clip, masks: list };
  if (clip.animation) {
    const tracks = { ...clip.animation.tracks };
    for (const [path, track] of Object.entries(clip.animation.tracks)) {
      const p = parseMaskPath(path);
      if (p?.maskId === maskId) tracks[maskParamPath(copy.id, p.param)] = { keyframes: track.keyframes.map((k) => ({ ...k, id: createKeyframeId() })) };
    }
    next = { ...next, animation: { tracks } };
  }
  return { timeline: withPatchedClip(timeline, clipId, () => next), mask: copy };
}

/**
 * Edits a mask. With a playhead `frame`, it's keyframe-aware like every other edit (Phase 8 auto-key): an animated
 * param gets a keyframe at the playhead (holding the value the user set THERE), a static one changes its base value.
 * Non-animatable fields (shape, mode, inversion, enabled, points, name) always change the base.
 */
export function updateMask(timeline: TimelineModel, clipId: string, maskId: string, patch: MaskPatch, frame?: number): TimelineModel {
  const clip = requireMaskClip(timeline, clipId);
  const { mask } = requireMask(clip, maskId);
  let next: Clip = clip;
  const staticPatch: MaskPatch = {};
  for (const [key, value] of Object.entries(patch) as [keyof MaskPatch, unknown][]) {
    if (value === undefined) continue;
    if (isMaskParam(key)) {
      const path = maskParamPath(maskId, key);
      const track = clip.animation?.tracks[path];
      if (frame !== undefined && track?.keyframes.length) {
        // Validate (and clamp) through the patch path first so an animated param gets the same checks as a static one.
        let probe: Mask;
        try {
          probe = applyMaskPatch(mask, { [key]: value } as MaskPatch);
        } catch (e) {
          asMaskEditError(e);
        }
        next = withTrack_(next, path, upsertKeyframe(next.animation?.tracks[path], Math.round(frame) - clip.timelineStart, probe[key]));
        continue;
      }
    }
    (staticPatch as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(staticPatch).length) {
    let patched: Mask;
    try {
      patched = applyMaskPatch(mask, staticPatch);
    } catch (e) {
      asMaskEditError(e);
    }
    next = { ...next, masks: next.masks!.map((m) => (m.id === maskId ? patched : m)) };
  }
  return withPatchedClip(timeline, clipId, () => next);
}

// ---------------------------------------------------------------------------
// GUIDES
// ---------------------------------------------------------------------------

function requireFinitePosition(position: number): void {
  if (!Number.isFinite(position)) throw new TimelineEditError("out-of-range", `Guide position must be finite, got ${position}.`);
}

export function addGuide(timeline: TimelineModel, axis: Guide["axis"], position: number): { timeline: TimelineModel; guide: Guide } {
  requireFinitePosition(position);
  const guide: Guide = { id: createId("guide"), axis, position };
  return { timeline: { ...timeline, guides: [...timeline.guides, guide] }, guide };
}

export function moveGuide(timeline: TimelineModel, guideId: string, position: number): TimelineModel {
  requireFinitePosition(position);
  if (!timeline.guides.some((g) => g.id === guideId)) throw new TimelineEditError("guide-not-found", `No guide with id "${guideId}".`);
  return { ...timeline, guides: timeline.guides.map((g) => (g.id === guideId ? { ...g, position } : g)) };
}

export function removeGuide(timeline: TimelineModel, guideId: string): TimelineModel {
  if (!timeline.guides.some((g) => g.id === guideId)) throw new TimelineEditError("guide-not-found", `No guide with id "${guideId}".`);
  return { ...timeline, guides: timeline.guides.filter((g) => g.id !== guideId) };
}

// ---------------------------------------------------------------------------
// Clip-kind constructors re-export (for symmetry with track kinds in the public API surface)
// ---------------------------------------------------------------------------

export { getTrackClips };

// ---------------------------------------------------------------------------
// TRANSITIONS (Phase 10 — TRANSITIONS_ARCHITECTURE.md §5)
// ---------------------------------------------------------------------------

function requireTransition(timeline: TimelineModel, transitionId: string): Transition {
  const t = timeline.transitions?.[transitionId];
  if (!t) throw new TimelineEditError("transition-not-found", `No transition with id "${transitionId}".`);
  return t;
}

function withTransitions(timeline: TimelineModel, transitions: Record<string, Transition>): TimelineModel {
  return { ...timeline, transitions };
}

/** Clamps a requested duration to the room the clips have; rejects when there's no room at all. */
function fitDuration(timeline: TimelineModel, t: Transition, requested: number): number {
  if (!Number.isFinite(requested)) throw new TimelineEditError("invalid-transition", "Transition duration must be a number.");
  const max = maxTransitionDuration(timeline, t);
  if (max < 1) throw new TimelineEditError("out-of-range", "There's no room for a transition here — the clip is fully used by its other transition.");
  return Math.max(1, Math.min(max, Math.round(requested)));
}

export interface AddTransitionOptions {
  /** Outgoing clip, or null for a transition-in at `toClipId`'s start. */
  fromClipId: string | null;
  /** Incoming clip, or null for a transition-out at `fromClipId`'s end. */
  toClipId: string | null;
  type: string;
  /** Frames; defaults to the type's default length. Clamped to the room the clips have. */
  duration?: number;
  alignment?: TransitionAlignment;
  params?: TransitionParams;
  direction?: TransitionDirection;
  easing?: unknown;
  enabled?: boolean;
}

/**
 * Adds a transition at an edit point: between two ADJACENT clips on the same visual track, or at one clip's start/end.
 * Each clip edge hosts at most one transition. One undo step.
 */
export function addTransition(timeline: TimelineModel, opts: AddTransitionOptions): { timeline: TimelineModel; transition: Transition } {
  if (!isTransitionType(opts.type)) throw new TimelineEditError("invalid-transition", `Unknown transition type "${String(opts.type)}".`);
  if (opts.fromClipId === null && opts.toClipId === null) throw new TimelineEditError("invalid-transition", "A transition needs at least one clip.");
  const from = opts.fromClipId === null ? null : requireClip(timeline, opts.fromClipId);
  const to = opts.toClipId === null ? null : requireClip(timeline, opts.toClipId);
  const trackId = (from ?? to)!.trackId;
  if (from && to && from.trackId !== to.trackId) throw new TimelineEditError("invalid-transition", "A transition's clips must be on the same track.");
  const track = requireTrack(timeline, trackId);
  requireUnlocked(track);
  if (!hasVisual(track.kind)) throw new TimelineEditError("kind-mismatch", "Audio tracks don't have visual transitions.");
  if (from && to && clipTimelineEnd(from) !== to.timelineStart) {
    throw new TimelineEditError("invalid-transition", "Clips must be adjacent (one ends exactly where the other starts) to transition between them.");
  }
  const existing = Object.values(timeline.transitions ?? {});
  if (from && existing.some((t) => t.fromClipId === from.id)) throw new TimelineEditError("invalid-transition", `The end of clip "${from.id}" already has a transition.`);
  if (to && existing.some((t) => t.toClipId === to.id)) throw new TimelineEditError("invalid-transition", `The start of clip "${to.id}" already has a transition.`);
  const easing = opts.easing === undefined ? DEFAULT_TRANSITION_EASING : normalizeEasing(opts.easing);
  if (!easing) throw new TimelineEditError("invalid-transition", "Invalid easing.");

  const def = getTransitionDefinition(opts.type)!;
  const draft: Transition = {
    id: createId("transition"),
    type: opts.type,
    trackId,
    fromClipId: from?.id ?? null,
    toClipId: to?.id ?? null,
    duration: 1,
    alignment: !from ? "start" : !to ? "end" : (opts.alignment ?? "center"),
    params: normalizeTransitionParams(opts.type, opts.params),
    easing,
    enabled: opts.enabled ?? true,
  };
  const direction = normalizeDirection(opts.type, opts.direction);
  if (direction) draft.direction = direction;
  draft.duration = fitDuration(timeline, draft, opts.duration ?? Math.round(def.defaultSeconds * timeline.frameRate));
  return { timeline: withTransitions(timeline, { ...timeline.transitions, [draft.id]: draft }), transition: draft };
}

export interface TransitionPatch {
  type?: string;
  duration?: number;
  alignment?: TransitionAlignment;
  params?: TransitionParams;
  direction?: TransitionDirection;
  easing?: unknown;
  enabled?: boolean;
  metadata?: Transition["metadata"];
}

/** Edits a transition (type, duration, alignment, params, direction, easing, enabled). Changing the type keeps params the new type shares. One undo step. */
export function updateTransition(timeline: TimelineModel, transitionId: string, patch: TransitionPatch): TimelineModel {
  const t = requireTransition(timeline, transitionId);
  requireUnlocked(requireTrack(timeline, t.trackId));
  const type = patch.type ?? t.type;
  if (!isTransitionType(type)) throw new TimelineEditError("invalid-transition", `Unknown transition type "${String(type)}".`);
  let easing = t.easing;
  if (patch.easing !== undefined) {
    const e = normalizeEasing(patch.easing);
    if (!e) throw new TimelineEditError("invalid-transition", "Invalid easing.");
    easing = e;
  }
  const paired = t.fromClipId !== null && t.toClipId !== null;
  if (patch.alignment !== undefined && !["center", "start", "end"].includes(patch.alignment)) throw new TimelineEditError("invalid-transition", `Invalid alignment "${String(patch.alignment)}".`);
  const next: Transition = {
    ...t,
    type,
    alignment: paired ? (patch.alignment ?? t.alignment) : t.alignment,
    params: normalizeTransitionParams(type, { ...t.params, ...patch.params }),
    easing,
    enabled: patch.enabled ?? t.enabled,
  };
  const direction = normalizeDirection(type, patch.direction ?? t.direction);
  if (direction) next.direction = direction;
  else delete next.direction;
  if (patch.metadata !== undefined) next.metadata = patch.metadata;
  next.duration = fitDuration(timeline, next, patch.duration ?? t.duration);
  return withTransitions(timeline, { ...timeline.transitions, [t.id]: next });
}

export function removeTransition(timeline: TimelineModel, transitionId: string): TimelineModel {
  const t = requireTransition(timeline, transitionId);
  requireUnlocked(requireTrack(timeline, t.trackId));
  const transitions = { ...timeline.transitions };
  delete transitions[transitionId];
  return withTransitions(timeline, transitions);
}

/**
 * Keeps transitions consistent with the clips after ANY edit (run by TimelineEngine after every op): a transition
 * whose clips were deleted, moved apart, moved to another track, or trimmed so they no longer touch is removed; one
 * whose clips got shorter is shortened to fit. Returns the same object when nothing changed. Undo restores both,
 * because history snapshots the whole timeline.
 */
export function reconcileTransitions(timeline: TimelineModel): TimelineModel {
  if (!timeline.transitions) return timeline;
  let current = timeline;
  let changed = false;
  for (const id of Object.keys(timeline.transitions).sort()) {
    const t = current.transitions![id];
    const w = transitionWindow(current, t);
    const transitions = { ...current.transitions };
    if (!w) {
      delete transitions[id];
    } else if (w.duration !== t.duration) {
      transitions[id] = { ...t, duration: w.duration };
    } else continue;
    current = withTransitions(current, transitions);
    changed = true;
  }
  return changed ? current : timeline;
}

// ---------------------------------------------------------------------------
// AUDIO (Phase 11 — AUDIO_ENGINE_ARCHITECTURE.md §5)
// ---------------------------------------------------------------------------

export type ClipAudioPatch = Partial<Omit<ClipAudio, "normalize">> & { normalize?: ClipAudio["normalize"] | null };

function requireAudibleClip(timeline: TimelineModel, clipId: string): Clip {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  if (!isAudibleKind(clip.content.kind)) throw new TimelineEditError("kind-mismatch", `"${clip.content.kind}" clips have no sound.`);
  return clip;
}

/**
 * Edits a clip's audio (volume, gain, fades, curve, mute, role, normalization). Keyframe-aware like visual edits: when
 * `frame` is given and volume/gain is animated, the new value becomes a keyframe at the playhead (auto-key) instead of
 * changing the static base. One undo step. Values are clamped (fades to >= 0 whole frames).
 */
export function setClipAudio(timeline: TimelineModel, clipId: string, patch: ClipAudioPatch, frame?: number): TimelineModel {
  const clip = requireAudibleClip(timeline, clipId);
  const base = clipAudioOf(clip);
  const merged: Record<string, unknown> = { ...base, ...patch };
  if (patch.normalize === null) delete merged.normalize;
  const next = normalizeClipAudio(merged)!;
  if (patch.volume !== undefined && !Number.isFinite(patch.volume)) throw new TimelineEditError("invalid-visual", "Volume must be a number.");
  if (patch.gainDb !== undefined && !Number.isFinite(patch.gainDb)) throw new TimelineEditError("invalid-visual", "Gain must be a number.");
  let out: Clip = { ...clip, audio: next };
  // Auto-key: animated volume/gain take the change as a keyframe at the playhead, keeping the stored base.
  for (const [key, path, clamp] of [["volume", "audio.volume", clampVolume], ["gainDb", "audio.gainDb", clampGainDb]] as const) {
    if (patch[key] === undefined || frame === undefined || !clip.animation?.tracks[path]?.keyframes.length) continue;
    out = { ...out, audio: { ...out.audio!, [key]: base[key] } };
    out = withTrack_(out, path, upsertKeyframe(out.animation?.tracks[path], Math.round(frame) - clip.timelineStart, clamp(patch[key]!)));
  }
  return withPatchedClip(timeline, clipId, () => out);
}

/**
 * Peak normalization: given the clip's measured peak (dBFS, over its source range — measured by the audio engine),
 * stores the make-up gain that brings the peak to `targetDb`. Non-destructive; clearing it is setClipAudio({ normalize: null }).
 */
export function normalizeClipAudioOp(timeline: TimelineModel, clipId: string, peakDb: number, targetDb = -1): TimelineModel {
  const clip = requireAudibleClip(timeline, clipId);
  let normalize: ClipAudio["normalize"];
  try {
    normalize = normalizationFor(peakDb, targetDb);
  } catch (e) {
    throw new TimelineEditError("out-of-range", (e as Error).message);
  }
  return withPatchedClip(timeline, clipId, () => ({ ...clip, audio: { ...clipAudioOf(clip), normalize } }));
}

// ---------------------------------------------------------------------------
// CAPTIONS (Phase 12 — CAPTIONS_ARCHITECTURE.md §6). Segments are clips on a "caption" track, so move/trim/split/
// delete/duplicate are the generic ops above; these cover what's caption-specific.
// ---------------------------------------------------------------------------

function requireCaptionTrack(timeline: TimelineModel, trackId: string): Track {
  const track = requireTrack(timeline, trackId);
  if (track.kind !== "caption") throw new TimelineEditError("kind-mismatch", `Track "${trackId}" isn't a caption track.`);
  return track;
}

function requireCaptionClip(timeline: TimelineModel, clipId: string): Clip & { content: AuthoredClipContent } {
  const clip = requireClip(timeline, clipId);
  requireUnlocked(requireTrack(timeline, clip.trackId));
  if (clip.content.kind !== "caption") throw new TimelineEditError("kind-mismatch", `Clip "${clipId}" isn't a caption.`);
  return clip as Clip & { content: AuthoredClipContent };
}

/** A new caption track at the FRONT of the stack (captions sit on top of everything). */
export function addCaptionTrack(timeline: TimelineModel, opts: { name?: string; settings?: Partial<CaptionTrackSettings> } = {}): { timeline: TimelineModel; track: Track } {
  const added = addTrack(timeline, "caption", opts.name ?? "Captions");
  const tl = reorderTrack(added.timeline, added.track.id, 0);
  const caption = normalizeCaptionTrackSettings({ ...opts.settings, style: { ...opts.settings?.style } });
  const track = withTrack(tl.tracks[added.track.id], { caption });
  return { timeline: { ...tl, tracks: { ...tl.tracks, [track.id]: track } }, track };
}

export type CaptionImportResult = {
  timeline: TimelineModel;
  trackId: string;
  clips: Clip[];
  /** Cues whose timing had to change to fit (overlaps trimmed, sub-frame cues widened, same-frame starts nudged). */
  adjusted: number;
};

/**
 * Places absolute-time cues (from speech-to-text or an SRT/VTT file) as caption clips. `target` = an existing caption
 * track to REPLACE the contents of (one undo step, like any op), or omitted for a new track. Times are converted to
 * frames; overlapping cues (legal in subtitle files, impossible on a track) are trimmed to end where the next begins.
 * Word timings are stored relative to each clip.
 */
export function importCaptionCues(
  timeline: TimelineModel,
  cues: readonly SubtitleCue[],
  opts: { target?: string; name?: string; settings?: Partial<CaptionTrackSettings>; offsetSec?: number } = {},
): CaptionImportResult {
  let tl = timeline;
  let trackId: string;
  if (opts.target) {
    const track = requireCaptionTrack(tl, opts.target);
    requireUnlocked(track);
    tl = deleteClips(tl, [...track.clipIds]);
    trackId = track.id;
  } else {
    const added = addCaptionTrack(tl, { name: opts.name, settings: opts.settings });
    tl = added.timeline;
    trackId = added.track.id;
  }
  const fps = tl.frameRate;
  const offset = opts.offsetSec ?? 0;
  const sorted = [...cues].filter((c) => c.text.trim() && Number.isFinite(c.start) && Number.isFinite(c.end)).sort((a, b) => a.start - b.start);
  const clips: Clip[] = [];
  let prevEnd = 0;
  let adjusted = 0;
  sorted.forEach((cue, i) => {
    let s = Math.max(0, Math.round((cue.start + offset) * fps));
    const next = sorted[i + 1];
    let e = Math.round((cue.end + offset) * fps);
    if (s < prevEnd) {
      s = prevEnd;
      adjusted++;
    }
    if (next && e > Math.round((next.start + offset) * fps) && Math.round((next.start + offset) * fps) > s) {
      e = Math.round((next.start + offset) * fps);
      adjusted++;
    }
    if (e <= s) {
      e = s + 1;
      adjusted++;
    }
    const startSec = s / fps;
    const durSec = (e - s) / fps;
    const words = cue.words
      ?.map((w) => ({ text: w.text, start: ms(Math.min(durSec, Math.max(0, w.start + offset - startSec))), end: ms(Math.min(durSec, Math.max(0, w.end + offset - startSec))) }))
      .filter((w) => w.end >= w.start);
    const content: ClipContent = { kind: "caption", text: cue.text.trim(), durationFrames: e - s, ...(words?.length ? { words } : {}), ...(cue.speaker ? { speaker: cue.speaker } : {}) };
    const r = insertClip(tl, trackId, content, s);
    tl = r.timeline;
    clips.push(r.clip);
    prevEnd = e;
  });
  return { timeline: tl, trackId, clips, adjusted };
}

/** The track's captions as absolute-time cues (SRT/VTT export). */
export function captionCuesOf(timeline: TimelineModel, trackId: string): SubtitleCue[] {
  const track = requireCaptionTrack(timeline, trackId);
  const fps = timeline.frameRate;
  return track.clipIds.map((id) => {
    const c = timeline.clips[id];
    const content = c.content as AuthoredClipContent;
    const start = c.timelineStart / fps;
    return {
      start,
      end: clipTimelineEnd(c) / fps,
      text: content.text ?? "",
      ...(content.speaker ? { speaker: content.speaker } : {}),
      ...(content.words?.length ? { words: content.words.map((w) => ({ text: w.text, start: ms(start + w.start), end: ms(start + w.end) })) } : {}),
    };
  });
}

/**
 * Manual correction of a caption's text. Word timings carry over word-for-word when the word count is unchanged
 * (typo fixes keep exact timing) and are re-spread over the caption otherwise. Empty text is rejected — deleting a
 * caption is deleteClip.
 */
export function updateCaptionText(timeline: TimelineModel, clipId: string, text: string): TimelineModel {
  const clip = requireCaptionClip(timeline, clipId);
  if (!text.trim()) throw new TimelineEditError("out-of-range", "A caption can't be empty — delete it instead.");
  const words = retimeWords(clip.content.words, text, clip.content.durationFrames / timeline.frameRate);
  const content: AuthoredClipContent = { ...clip.content, text };
  if (words) content.words = words;
  return withPatchedClip(timeline, clipId, (c) => withContent(c, content));
}

export function setCaptionSpeaker(timeline: TimelineModel, clipId: string, speaker: string | null): TimelineModel {
  const clip = requireCaptionClip(timeline, clipId);
  const content: AuthoredClipContent = { ...clip.content };
  const name = speaker?.trim();
  if (name) content.speaker = name;
  else delete content.speaker;
  return withPatchedClip(timeline, clipId, (c) => withContent(c, content));
}

/** Replaces a caption's word timings (e.g. after re-transcribing). Validated and clamped to the caption. */
export function setCaptionWords(timeline: TimelineModel, clipId: string, words: readonly CaptionWordTiming[] | null): TimelineModel {
  const clip = requireCaptionClip(timeline, clipId);
  const content: AuthoredClipContent = { ...clip.content };
  if (words === null) delete content.words;
  else {
    const v = normalizeWords(words);
    if (!v) throw new TimelineEditError("out-of-range", "Invalid word timings.");
    const dur = clip.content.durationFrames / timeline.frameRate;
    content.words = v.map((w) => ({ ...w, start: Math.min(w.start, dur), end: Math.min(w.end, dur) }));
  }
  return withPatchedClip(timeline, clipId, (c) => withContent(c, content));
}

export interface CaptionTrackPatch {
  style?: Partial<CaptionStyleSettings>;
  presetId?: string;
  language?: string;
  speakerColors?: Record<string, string>;
}

/** Restyles every caption on the track (fields not given keep their value). One undo step. */
export function setCaptionTrackSettings(timeline: TimelineModel, trackId: string, patch: CaptionTrackPatch): TimelineModel {
  const track = requireCaptionTrack(timeline, trackId);
  requireUnlocked(track);
  const cur = track.caption ?? normalizeCaptionTrackSettings({});
  // Hand-tuning the style makes it "Custom" (the preset label would otherwise claim a look the track no longer has).
  const { presetId: _prev, ...rest } = cur;
  void _prev;
  const caption = normalizeCaptionTrackSettings({
    ...(patch.style ? rest : cur),
    ...(patch.presetId !== undefined ? { presetId: patch.presetId } : {}),
    ...(patch.language !== undefined ? { language: patch.language } : {}),
    ...(patch.speakerColors !== undefined ? { speakerColors: patch.speakerColors } : {}),
    style: { ...cur.style, ...patch.style },
  });
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { caption }));
}

/** Applies a styling preset to the whole track (look AND placement). */
export function applyCaptionPreset(timeline: TimelineModel, trackId: string, presetId: string): TimelineModel {
  const preset = getCaptionPreset(presetId);
  if (!preset) throw new TimelineEditError("out-of-range", `Unknown caption preset "${presetId}".`);
  const track = requireCaptionTrack(timeline, trackId);
  requireUnlocked(track);
  const cur = track.caption ?? normalizeCaptionTrackSettings({});
  return withPatchedTrack(timeline, trackId, (t) => withTrack(t, { caption: { ...cur, style: normalizeCaptionStyle(preset.style), presetId } }));
}

/** Joins a caption with the next one on its track (text, words, and the span between them). */
export function mergeCaptionWithNext(timeline: TimelineModel, clipId: string): TimelineModel {
  const clip = requireCaptionClip(timeline, clipId);
  const track = timeline.tracks[clip.trackId];
  const idx = track.clipIds.indexOf(clipId);
  const nextId = track.clipIds[idx + 1];
  if (!nextId) throw new TimelineEditError("out-of-range", "There's no next caption to merge with.");
  const next = timeline.clips[nextId] as typeof clip;
  const fps = timeline.frameRate;
  const shift = (next.timelineStart - clip.timelineStart) / fps;
  const words = clip.content.words || next.content.words ? [...(clip.content.words ?? []), ...(next.content.words ?? []).map((w) => ({ ...w, start: ms(w.start + shift), end: ms(w.end + shift) }))] : undefined;
  const content: ClipContent = {
    ...clip.content,
    text: `${clip.content.text ?? ""} ${next.content.text ?? ""}`.trim(),
    durationFrames: clipTimelineEnd(next) - clip.timelineStart,
    ...(words ? { words } : {}),
  };
  const merged = withContent(clip, content);
  const clips = { ...timeline.clips, [clipId]: merged };
  delete clips[nextId];
  return { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds: track.clipIds.filter((id) => id !== nextId) }) } };
}

/**
 * Sets a caption's in/out on the timeline (frames) as ONE edit — the numeric timing fields in the captions list.
 * Built from trimClip, so the same clamping and overlap rules apply; word timings stay on their timeline moments.
 */
export function setCaptionTiming(timeline: TimelineModel, clipId: string, startFrame: number, endFrame: number): TimelineModel {
  const clip = requireCaptionClip(timeline, clipId);
  const s = Math.round(startFrame);
  const e = Math.round(endFrame);
  if (!(e > s)) throw new TimelineEditError("out-of-range", "A caption must end after it starts.");
  // Grow first, then shrink, so the intermediate state never needs to pass through a neighbor.
  const steps: ["start" | "end", number][] = s < clip.timelineStart ? [["start", s], ["end", e]] : [["end", e], ["start", s]];
  let tl = timeline;
  for (const [edge, f] of steps) tl = trimClip(tl, clipId, edge, f);
  return tl;
}
