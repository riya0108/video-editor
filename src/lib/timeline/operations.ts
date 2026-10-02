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
  type Clip,
  type ClipContent,
} from "./clip";
import { createTrack, withTrack, type Track, type TrackKind } from "./track";
import { findOverlap, getClip, getTrack, getTrackClips, validateCompositionSize, type CompositionSettings, type Guide, type TimelineModel } from "./model";
import { applyVisualPatch, defaultClipVisual, InvalidVisualError, type ClipVisual, type ClipVisualPatch, type ShapeSpec } from "./visual";
import { patchTextStyle, type TextStylePatch } from "./text-style";
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
  // Spread from the original so the right piece inherits `visual` (transform/crop/opacity/matte) — a split must never make half the clip jump to a different place on screen.
  const right: Clip = { ...clip, id: createId("clip"), timelineStart: atFrame, content: rightContent };

  const clips = { ...timeline.clips, [left.id]: left, [right.id]: right };
  const clipIds = sortedByStart([...track.clipIds, right.id], clips); // right.id wasn't in track.clipIds yet; left.id already was
  return {
    timeline: { ...timeline, clips, tracks: { ...timeline.tracks, [track.id]: withTrack(track, { clipIds }) } },
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
  const base = clip.visual ?? defaultClipVisual(timeline.composition.width, timeline.composition.height);
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
export function editClips(timeline: TimelineModel, edits: Readonly<Record<string, ClipEdit>>): TimelineModel {
  let tl = timeline;
  for (const [clipId, edit] of Object.entries(edits)) {
    if (edit.content) tl = updateAuthoredContent(tl, clipId, edit.content);
    if (edit.visual) tl = setClipVisual(tl, clipId, edit.visual);
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
