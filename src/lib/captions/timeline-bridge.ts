import type { Clip } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { defaultClipVisual, type ClipVisual } from "../timeline/visual";
import { captionDefaultVisual, normalizeCaptionTrackSettings, type CaptionTrackSettings } from "./caption-model";

/** A caption track's settings, defaults filled in (never throws for a missing track). */
export function captionSettingsOf(timeline: TimelineModel, trackId: string): CaptionTrackSettings {
  return timeline.tracks[trackId]?.caption ?? DEFAULTS;
}
const DEFAULTS = normalizeCaptionTrackSettings({});

/**
 * The visual a clip has when it doesn't store its own: the composition default for ordinary layers, the TRACK's
 * caption placement for captions (so restyling a caption track moves every caption that wasn't individually placed).
 */
export function clipBaseVisual(timeline: TimelineModel, clip: Clip): ClipVisual {
  if (clip.visual) return clip.visual;
  if (clip.content.kind === "caption") return captionDefaultVisual(captionSettingsOf(timeline, clip.trackId).style, timeline.composition);
  return defaultClipVisual(timeline.composition.width, timeline.composition.height);
}

/** For keyframing a caption: its placement must be concrete first, so the first keyframe holds where it is on screen. */
export function withConcreteVisual(timeline: TimelineModel, clip: Clip): Clip {
  return clip.visual || clip.content.kind !== "caption" ? clip : { ...clip, visual: clipBaseVisual(timeline, clip) };
}
