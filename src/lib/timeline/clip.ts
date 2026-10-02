import { createId } from "./id";
import type { ClipVisual, ShapeSpec, TextStyle } from "./visual";

/** Opaque reference to source media — never bytes, never a File/Blob/URL. Resolving sourceId to real media is a different layer's job; see TIMELINE_ARCHITECTURE.md §2. */
export interface MediaSourceRef {
  sourceId: string;
  label?: string;
  /** The source's own known duration, in project frames (see TIMELINE_ARCHITECTURE.md §3's frame-rate-conforming simplification) — when present, trimClip clamps sourceOutFrame to it so a clip can never be trimmed into content the source doesn't have. Undefined when the real duration isn't known yet; trimming is then only clamped to a 1-frame minimum, not an upper bound. */
  sourceDurationFrames?: number;
}

export type ClipKind = "video" | "image" | "audio" | "text" | "graphic" | "overlay";

/** Trim-capable: duration is DERIVED (sourceOutFrame - sourceInFrame) — never stored separately, so it can't drift. See TIMELINE_ARCHITECTURE.md §4. */
export interface TrimmableClipContent {
  kind: "video" | "audio" | "overlay";
  source: MediaSourceRef;
  /** Inclusive start, in project frames, into the source's own timeline. */
  sourceInFrame: number;
  /** Exclusive end, in project frames, into the source's own timeline. */
  sourceOutFrame: number;
}

/** Timeline-authored: no source in/out concept (a still image or text block has no inherent duration) — durationFrames IS the trim target. */
export interface AuthoredClipContent {
  kind: "image" | "graphic" | "text";
  source?: MediaSourceRef; // present for image/graphic, absent for text
  text?: string; // present for text only
  /** text only — undefined means DEFAULT_TEXT_STYLE. */
  textStyle?: TextStyle;
  /** graphic only — a vector shape drawn by the compositor instead of a sourced image (a graphic clip has a source OR a shape). */
  shape?: ShapeSpec;
  durationFrames: number;
}

export type ClipContent = TrimmableClipContent | AuthoredClipContent;

export interface Clip {
  id: string;
  trackId: string;
  /** Frames, >= 0 — position of this clip's start on the timeline. */
  timelineStart: number;
  content: ClipContent;
  /** Placement on the canvas (transform/crop/opacity/blend/matte). Undefined = defaultClipVisual() for the timeline's composition — so changing the composition size re-centers untouched clips automatically. Never present on audio clips. See visual.ts. */
  visual?: ClipVisual;
}

export function isTrimmableContent(content: ClipContent): content is TrimmableClipContent {
  return content.kind === "video" || content.kind === "audio" || content.kind === "overlay";
}

/** Single source of truth for a clip's duration — every other module must call this rather than branching on content.kind itself. */
export function clipDurationFrames(clip: Clip): number {
  return isTrimmableContent(clip.content) ? clip.content.sourceOutFrame - clip.content.sourceInFrame : clip.content.durationFrames;
}

export function clipTimelineEnd(clip: Clip): number {
  return clip.timelineStart + clipDurationFrames(clip);
}

export function clipKind(clip: Clip): ClipKind {
  return clip.content.kind;
}

function createClip(trackId: string, timelineStart: number, content: ClipContent): Clip {
  return { id: createId("clip"), trackId, timelineStart, content };
}

export function createVideoClip(trackId: string, timelineStart: number, source: MediaSourceRef, sourceInFrame: number, sourceOutFrame: number): Clip {
  return createClip(trackId, timelineStart, { kind: "video", source, sourceInFrame, sourceOutFrame });
}

export function createAudioClip(trackId: string, timelineStart: number, source: MediaSourceRef, sourceInFrame: number, sourceOutFrame: number): Clip {
  return createClip(trackId, timelineStart, { kind: "audio", source, sourceInFrame, sourceOutFrame });
}

export function createOverlayClip(trackId: string, timelineStart: number, source: MediaSourceRef, sourceInFrame: number, sourceOutFrame: number): Clip {
  return createClip(trackId, timelineStart, { kind: "overlay", source, sourceInFrame, sourceOutFrame });
}

export function createImageClip(trackId: string, timelineStart: number, source: MediaSourceRef, durationFrames: number): Clip {
  return createClip(trackId, timelineStart, { kind: "image", source, durationFrames });
}

export function createGraphicClip(trackId: string, timelineStart: number, source: MediaSourceRef, durationFrames: number): Clip {
  return createClip(trackId, timelineStart, { kind: "graphic", source, durationFrames });
}

export function createTextClip(trackId: string, timelineStart: number, text: string, durationFrames: number, textStyle?: TextStyle): Clip {
  return createClip(trackId, timelineStart, textStyle ? { kind: "text", text, textStyle, durationFrames } : { kind: "text", text, durationFrames });
}

export function createShapeClip(trackId: string, timelineStart: number, shape: ShapeSpec, durationFrames: number): Clip {
  return createClip(trackId, timelineStart, { kind: "graphic", shape, durationFrames });
}

/** Audio is the only kind with no visual representation — every other kind is a compositor layer. */
export function hasVisual(kind: ClipKind): boolean {
  return kind !== "audio";
}

/** Returns a new Clip with the same id/trackId/timelineStart but a fresh content object — used internally by operations.ts (trim/split) to produce an updated clip without ever mutating the original. */
export function withContent(clip: Clip, content: ClipContent): Clip {
  return { ...clip, content };
}

export function withTimelineStart(clip: Clip, timelineStart: number): Clip {
  return { ...clip, timelineStart };
}

export function withTrackId(clip: Clip, trackId: string): Clip {
  return { ...clip, trackId };
}
