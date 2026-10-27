import { clipTimelineEnd, isTrimmableContent, type ClipContent } from "../timeline/clip";
import { TimelineEditError } from "../timeline/errors";
import type { TimelineModel } from "../timeline/model";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { addEffect, addTrack, insertClip, removeTrack, reorderTrack, setClipAudio } from "../timeline/operations";

/**
 * BACKGROUND SWAP — after background removal cuts the subject out (a matte on the layer), put something behind it:
 * a solid color, an image (or any media already in the project), or a blurred copy of the original footage
 * (the "portrait mode" look). The new background is an ordinary layer on its own track directly BEHIND the
 * subject's track, spanning the subject clip's time. Swapping again replaces it. One undo step.
 */

export type BackgroundChoice = { kind: "color"; color: string } | { kind: "media"; sourceId: string; label: string; mediaKind: "image" | "video"; durationFrames?: number } | { kind: "blur"; radius: number };

export const backgroundTrackName = (clipLabel: string) => `Background · ${clipLabel}`;

export function swapBackground(timeline: TimelineModel, clipId: string, choice: BackgroundChoice): { timeline: TimelineModel; clipId: string } {
  const subject = timeline.clips[clipId];
  if (!subject) throw new TimelineEditError("clip-not-found", "The layer no longer exists.");
  if (subject.content.kind === "audio") throw new TimelineEditError("kind-mismatch", "Audio has no background to swap.");
  const label = (subject.content as { source?: { label?: string } }).source?.label ?? timeline.tracks[subject.trackId]?.name ?? "layer";
  const name = backgroundTrackName(label);
  let tl = timeline;

  // Replace an earlier swap for this layer (the track directly behind it with our name).
  const idx = tl.trackIds.indexOf(subject.trackId);
  const behind = tl.trackIds[idx + 1];
  if (behind && tl.tracks[behind].name === name) tl = removeTrack(tl, behind);

  const start = subject.timelineStart;
  const length = clipTimelineEnd(subject) - start;
  const { width, height } = tl.composition;
  let content: ClipContent;
  let trackKind: "graphic" | "image" | "video" | "overlay";
  let visual: Parameters<typeof insertClip>[4] = undefined;
  if (choice.kind === "color") {
    trackKind = "graphic";
    content = { kind: "graphic", shape: normalizeShapeSpec({ type: "rect", width, height, fill: true, fillColor: choice.color, strokeWidth: 0, cornerRadius: 0 }), durationFrames: length };
  } else if (choice.kind === "media") {
    if (choice.mediaKind === "image") {
      trackKind = "image";
      content = { kind: "image", source: { sourceId: choice.sourceId, label: choice.label }, durationFrames: length };
    } else {
      trackKind = "overlay";
      const n = Math.max(1, Math.min(length, choice.durationFrames ?? length));
      content = { kind: "overlay", source: { sourceId: choice.sourceId, label: choice.label, sourceDurationFrames: choice.durationFrames ?? n }, sourceInFrame: 0, sourceOutFrame: n };
    }
    visual = { fit: "cover" };
  } else {
    if (!isTrimmableContent(subject.content)) throw new TimelineEditError("kind-mismatch", "Only video and image layers can use a blurred copy as their background.");
    trackKind = subject.content.kind === "video" ? "video" : "overlay";
    // The same footage, without the cut-out, blurred and slightly enlarged so the blur doesn't reveal the edges.
    content = { ...subject.content } as ClipContent;
    const v = subject.visual;
    visual = { fit: v?.fit ?? "cover", transform: { ...(v?.transform ?? {}), scaleX: (v?.transform.scaleX ?? 1) * 1.08, scaleY: (v?.transform.scaleY ?? 1) * 1.08 }, crop: v?.crop };
  }
  const added = addTrack(tl, trackKind, name);
  tl = reorderTrack(added.timeline, added.track.id, tl.trackIds.indexOf(subject.trackId) + 1);
  const ins = insertClip(tl, added.track.id, content, start, visual);
  tl = ins.timeline;
  if (choice.kind === "blur") {
    tl = addEffect(tl, ins.clip.id, "blur", { radius: choice.radius }).timeline;
    // The subject layer already plays this sound — the copy stays silent.
    tl = setClipAudio(tl, ins.clip.id, { muted: true });
  }
  if (choice.kind === "media" && choice.mediaKind === "video") tl = setClipAudio(tl, ins.clip.id, { muted: true });
  return { timeline: tl, clipId: ins.clip.id };
}
