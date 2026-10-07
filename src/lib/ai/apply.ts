import { clipTimelineEnd, isTrimmableContent, type Clip } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { defaultClipVisual } from "../timeline/visual";
import { maskParamPath } from "../masks/model";
import { isAudibleKind } from "../audio/model";
import { TimelineEditError } from "../timeline/errors";
import * as ops from "../timeline/operations";
import type { AIResult, Box, BrollItem, DetectionTrackItem, ObjectRemovalItem, ReframeItem, TrackItem } from "./types";

/**
 * APPLY ACTIONS (AI_EDITING_ARCHITECTURE.md §7) — the ONLY place AI results touch the project, and only on an explicit
 * user action. Each is a pure function (timeline -> timeline) built from the existing operations in
 * timeline/operations.ts, run through `TimelineEngine.transact` as ONE undo step. Only ACCEPTED items are used.
 * Source media is never modified: edits are splits/deletes of clip ranges (pointers into the media), keyframes,
 * masks, effects, and new layers.
 *
 * Time mapping: results are in SOURCE seconds; a clip shows source frame f at timeline frame
 * timelineStart + (f - sourceIn). Items outside the clip's current span (it was trimmed since analysis) are skipped.
 */

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

function requireClip(tl: TimelineModel, clipId: string): Clip {
  const c = tl.clips[clipId];
  if (!c) throw new ApplyError("The analysed clip no longer exists.");
  return c;
}

/** Source seconds -> timeline frame for a clip (null when outside the clip's current span). */
export function sourceToTimeline(tl: TimelineModel, clip: Clip, t: number): number | null {
  const f = Math.round(t * tl.frameRate);
  const sourceIn = isTrimmableContent(clip.content) ? clip.content.sourceInFrame : 0;
  const frame = clip.timelineStart + (f - sourceIn);
  return frame >= clip.timelineStart && frame <= clipTimelineEnd(clip) ? frame : null;
}

const accepted = <T extends { accepted: boolean }>(items: T[]) => items.filter((i) => i.accepted);

/** Splits the clip at every accepted shot/scene start (and highlight boundary). Returns the new timeline and how many cuts were made. */
export function splitAtBoundaries(tl: TimelineModel, result: AIResult): { timeline: TimelineModel; cuts: number } {
  const clip = requireClip(tl, result.target.clipId);
  const times = new Set<number>();
  for (const it of accepted(result.items)) {
    if (it.kind === "shot" || it.kind === "scene") times.add(it.start);
    if (it.kind === "highlight") {
      times.add(it.start);
      times.add(it.end);
    }
  }
  // Scene results also carry their shots: when scenes exist, split at SCENE starts only.
  if (result.feature === "scene-detection") {
    times.clear();
    for (const it of accepted(result.items)) if (it.kind === "scene") times.add(it.start);
  }
  const frames = [...times]
    .map((t) => sourceToTimeline(tl, clip, t))
    .filter((f): f is number => f !== null && f > clip.timelineStart && f < clipTimelineEnd(clip))
    .sort((a, b) => a - b);
  let timeline = tl;
  let current = clip.id;
  let cuts = 0;
  for (const f of [...new Set(frames)]) {
    const c = timeline.clips[current];
    if (f <= c.timelineStart || f >= clipTimelineEnd(c)) continue;
    const r = ops.splitClip(timeline, current, f);
    timeline = r.timeline;
    current = r.right.id;
    cuts++;
  }
  return { timeline, cuts };
}

/**
 * Removes accepted silence/filler ranges from the clip. `closeGaps`: later clips on the SAME track move left by the
 * removed duration (ripple on this track only — other tracks are not shifted, so the UI warns when they hold
 * clips after the edit). Returns how many frames were removed.
 */
export function removeRanges(tl: TimelineModel, result: AIResult, opts: { closeGaps: boolean }): { timeline: TimelineModel; removedFrames: number; ranges: number } {
  const clip = requireClip(tl, result.target.clipId);
  const ranges = accepted(result.items)
    .filter((i): i is Extract<typeof i, { start: number; end: number }> => i.kind === "silence" || i.kind === "filler")
    .map((i) => [sourceToTimeline(tl, clip, i.start), sourceToTimeline(tl, clip, i.end)] as const)
    .filter((r): r is readonly [number, number] => r[0] !== null && r[1] !== null && r[1] - r[0] >= 1)
    .sort((a, b) => b[0] - a[0]); // last first: earlier frames stay valid
  // Merge overlaps.
  const merged: [number, number][] = [];
  for (const [s, e] of [...ranges].reverse()) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let timeline = tl;
  let removed = 0;
  const trackId = clip.trackId;
  for (const [s, e] of merged.reverse()) {
    // Find the piece of the (possibly already split) clip covering [s, e).
    const covering = timeline.tracks[trackId].clipIds.map((id) => timeline.clips[id]).find((c) => c.timelineStart <= s && clipTimelineEnd(c) >= e);
    if (!covering) continue;
    let target = covering.id;
    if (e < clipTimelineEnd(covering)) timeline = ops.splitClip(timeline, target, e).timeline;
    if (s > covering.timelineStart) {
      const r = ops.splitClip(timeline, target, s);
      timeline = r.timeline;
      target = r.right.id;
    }
    const cut = timeline.clips[target];
    const len = clipTimelineEnd(cut) - cut.timelineStart;
    timeline = ops.deleteClip(timeline, target);
    removed += len;
    if (opts.closeGaps) {
      const later = timeline.tracks[trackId].clipIds.map((id) => timeline.clips[id]).filter((c) => c.timelineStart >= e).sort((a, b) => a.timelineStart - b.timelineStart);
      for (const c of later) timeline = ops.moveClip(timeline, c.id, c.timelineStart - len);
    }
  }
  return { timeline, removedFrames: removed, ranges: merged.length };
}

/** Labels caption clips with the speaker whose turn covers each caption's midpoint (Phase 12 captions). */
export function labelCaptionSpeakers(tl: TimelineModel, result: AIResult): { timeline: TimelineModel; labelled: number } {
  const clip = requireClip(tl, result.target.clipId);
  const turns = accepted(result.items)
    .filter((i) => i.kind === "speaker-turn")
    .map((t) => ({ start: sourceToTimeline(tl, clip, t.start), end: sourceToTimeline(tl, clip, t.end), speaker: t.speaker }))
    .filter((t): t is { start: number; end: number; speaker: string } => t.start !== null && t.end !== null);
  let timeline = tl;
  let labelled = 0;
  for (const c of Object.values(tl.clips)) {
    if (c.content.kind !== "caption") continue;
    const mid = (c.timelineStart + clipTimelineEnd(c)) / 2;
    const turn = turns.find((t) => mid >= t.start && mid < t.end);
    if (!turn || c.content.speaker === turn.speaker) continue;
    timeline = ops.setCaptionSpeaker(timeline, c.id, turn.speaker);
    labelled++;
  }
  return { timeline, labelled };
}

/** Keyframes (absolute timeline frame, normalized box) for a detection track or tracker output. */
function boxKeys(tl: TimelineModel, clip: Clip, item: DetectionTrackItem | TrackItem): { frame: number; box: Box }[] {
  const raw = item.kind === "track" ? item.keys.map((k) => ({ time: k.time, box: k.box })) : item.detections.map((d) => ({ time: d.time, box: d.box }));
  const out: { frame: number; box: Box }[] = [];
  for (const k of raw) {
    const f = sourceToTimeline(tl, clip, k.time);
    if (f === null || out.some((o) => o.frame === f)) continue;
    out.push({ frame: f, box: k.box });
  }
  return out;
}

/**
 * Adds an ELLIPSE MASK (Phase 13) to the clip whose position/size is keyframed to follow a detected face/object or a
 * tracked region. `mode: "blur"` instead duplicates the clip as a layer above it with a Blur effect and that mask —
 * the classic "blur this face" — muting the copy's audio so sound isn't doubled.
 */
export function maskFromTrack(tl: TimelineModel, result: AIResult, itemId: string, opts: { mode: "mask" | "blur"; blurRadius?: number; padding?: number }): { timeline: TimelineModel; clipId: string; maskId: string } {
  const clip = requireClip(tl, result.target.clipId);
  const item = result.items.find((i) => i.id === itemId);
  if (!item || (item.kind !== "detection-track" && item.kind !== "track")) throw new ApplyError("Pick a detected face/object or a track.");
  const keys = boxKeys(tl, clip, item);
  if (keys.length === 0) throw new ApplyError("None of this item's positions fall inside the clip's current range.");
  let timeline = tl;
  let targetId = clip.id;
  if (opts.mode === "blur") {
    const dup = ops.duplicateClipsAsLayers(timeline, [clip.id]);
    timeline = dup.timeline;
    targetId = dup.clips[0].id;
    if (isAudibleKind(dup.clips[0].content.kind)) timeline = ops.setClipAudio(timeline, targetId, { muted: true });
    timeline = ops.addEffect(timeline, targetId, "blur", { radius: opts.blurRadius ?? 24 }).timeline;
  }
  const pad = opts.padding ?? 0.15;
  const first = keys[0].box;
  const added = ops.addMask(timeline, targetId, "ellipse", { patch: { x: first.x + first.w / 2, y: first.y + first.h / 2, width: first.w * (1 + pad), height: first.h * (1 + pad), feather: 6 } });
  timeline = added.timeline;
  const mid = added.mask.id;
  if (keys.length > 1) {
    for (const p of ["x", "y", "width", "height"] as const) {
      for (const k of keys) {
        const v = p === "x" ? k.box.x + k.box.w / 2 : p === "y" ? k.box.y + k.box.h / 2 : p === "width" ? k.box.w * (1 + pad) : k.box.h * (1 + pad);
        timeline = ops.addKeyframe(timeline, targetId, maskParamPath(mid, p), k.frame, v);
      }
    }
  }
  return { timeline, clipId: targetId, maskId: mid };
}

/** Makes another layer FOLLOW a track: its position is keyframed so it keeps its offset from the tracked box's centre. */
export function attachLayerToTrack(tl: TimelineModel, result: AIResult, itemId: string, layerClipId: string, layerOf: (clipId: string, frame: number) => { boxCenterToComp: (nx: number, ny: number) => { x: number; y: number } } | null): { timeline: TimelineModel; keys: number } {
  const clip = requireClip(tl, result.target.clipId);
  const layer = requireClip(tl, layerClipId);
  const item = result.items.find((i) => i.id === itemId);
  if (!item || (item.kind !== "track" && item.kind !== "detection-track")) throw new ApplyError("Pick a track.");
  const keys = boxKeys(tl, clip, item);
  if (keys.length === 0) throw new ApplyError("The track doesn't overlap the clip's current range.");
  const map = layerOf(clip.id, keys[0].frame);
  if (!map) throw new ApplyError("The tracked clip isn't on screen.");
  const v = layer.visual ?? defaultClipVisual(tl.composition.width, tl.composition.height);
  const c0 = map.boxCenterToComp(keys[0].box.x + keys[0].box.w / 2, keys[0].box.y + keys[0].box.h / 2);
  const off = { x: v.transform.x - c0.x, y: v.transform.y - c0.y };
  let timeline = tl;
  let n = 0;
  for (const k of keys) {
    const m = layerOf(clip.id, k.frame);
    if (!m) continue;
    const c = m.boxCenterToComp(k.box.x + k.box.w / 2, k.box.y + k.box.h / 2);
    timeline = ops.addKeyframe(timeline, layerClipId, "visual.transform.x", k.frame, c.x + off.x);
    timeline = ops.addKeyframe(timeline, layerClipId, "visual.transform.y", k.frame, c.y + off.y);
    n++;
  }
  return { timeline, keys: n };
}

/** Drops keys a linear interpolation already predicts within `tol` (1-D Ramer–Douglas–Peucker over (frame, value)). */
export function simplifyKeys(keys: { frame: number; value: number }[], tol: number): { frame: number; value: number }[] {
  if (keys.length <= 2) return keys;
  const keep = new Uint8Array(keys.length);
  keep[0] = keep[keys.length - 1] = 1;
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (keys[i].frame - keys[a].frame) / (keys[b].frame - keys[a].frame);
      const err = Math.abs(keys[i].value - (keys[a].value + t * (keys[b].value - keys[a].value)));
      if (err > worst) {
        worst = err;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return keys.filter((_, i) => keep[i]);
}

/**
 * Applies an auto-reframe path to the clip for the CURRENT composition: fit "none", a static cover scale (the crop
 * window fills the frame), and position keyframes so the crop centre sits at the frame centre. Static clips keep
 * their keys editable in the keyframe panel; the media is untouched.
 */
export function applyReframe(tl: TimelineModel, result: AIResult, sourceSize: { width: number; height: number }): { timeline: TimelineModel; keys: number } {
  const clip = requireClip(tl, result.target.clipId);
  const item = accepted(result.items).find((i): i is ReframeItem => i.kind === "reframe");
  if (!item) throw new ApplyError("No accepted reframe path.");
  const comp = tl.composition;
  // The path crops TO the composition's shape; on a different-shaped composition the cover scale would zoom far into
  // a sliver of the picture (a 9:16 path on 16:9 = 4.7x), which is never what reframing means.
  const compAspect = comp.width / comp.height;
  if (Math.abs(compAspect / item.aspect - 1) > 0.02) {
    throw new ApplyError(`This path reframes to ${aspectLabel(item.aspect)}, but the composition is ${aspectLabel(compAspect)}. Switch the composition to ${aspectLabel(item.aspect)} first, or re-run Auto reframe for ${aspectLabel(compAspect)}.`);
  }
  const W = sourceSize.width;
  const H = sourceSize.height;
  const s = Math.max(comp.width / (item.cropW * W), comp.height / (item.cropH * H));
  const pos = (cx: number, cy: number) => ({ x: comp.width / 2 - (cx - 0.5) * W * s, y: comp.height / 2 - (cy - 0.5) * H * s });
  const frames = item.keys
    .map((k) => ({ frame: sourceToTimeline(tl, clip, k.time), ...pos(k.cx, k.cy) }))
    .filter((k): k is { frame: number; x: number; y: number } => k.frame !== null);
  if (frames.length === 0) throw new ApplyError("The reframe path doesn't overlap the clip's current range.");
  // Clear any existing position animation first, so the path isn't mixed with old keys.
  let timeline = tl;
  for (const p of ["visual.transform.x", "visual.transform.y"]) if (timeline.clips[clip.id].animation?.tracks[p]) timeline = ops.setPropertyAnimated(timeline, clip.id, p, false, frames[0].frame);
  timeline = ops.setClipVisual(timeline, clip.id, { fit: "none", transform: { scaleX: s, scaleY: s, anchorX: 0.5, anchorY: 0.5, rotation: 0, ...pos(item.keys[0].cx, item.keys[0].cy) } });
  let n = 0;
  if (frames.length > 1) {
    for (const axis of ["x", "y"] as const) {
      const simplified = simplifyKeys(
        frames.map((f) => ({ frame: f.frame, value: f[axis] })),
        1.5,
      );
      for (const k of simplified) {
        timeline = ops.addKeyframe(timeline, clip.id, `visual.transform.${axis}`, k.frame, k.value);
        n++;
      }
    }
  }
  return { timeline, keys: n };
}

/** "9:16", "1:1", "4:5", "16:9"… for common aspects; otherwise a decimal ratio. */
function aspectLabel(a: number): string {
  for (const [w, h] of [[9, 16], [1, 1], [4, 5], [16, 9], [4, 3], [3, 4], [21, 9]]) if (Math.abs(a / (w / h) - 1) < 0.02) return `${w}:${h}`;
  return a.toFixed(2);
}

/** Object removal: the clean-plate patch as an overlay layer directly above the clip, placed exactly like the clip. */
export function addObjectRemovalLayer(tl: TimelineModel, result: AIResult, itemId: string, plateSize: { width: number; height: number }, sourceSize: { width: number; height: number }): { timeline: TimelineModel; clipId: string } {
  const clip = requireClip(tl, result.target.clipId);
  const item = result.items.find((i): i is ObjectRemovalItem => i.id === itemId && i.kind === "object-removal");
  if (!item) throw new ApplyError("Pick an object-removal result.");
  const v = clip.visual ?? defaultClipVisual(tl.composition.width, tl.composition.height);
  // With fit "none" the layer box is the image's own size: compensate the plate's analysis resolution.
  const k = v.fit === "none" ? sourceSize.width / plateSize.width : 1;
  const added = ops.addTrack(tl, "image", "Object removal patch");
  let timeline = ops.reorderTrack(added.timeline, added.track.id, tl.trackIds.indexOf(clip.trackId));
  const duration = clipTimelineEnd(clip) - clip.timelineStart;
  const r = ops.insertClip(timeline, added.track.id, { kind: "image", source: { sourceId: item.plateSourceId, label: "Clean plate" }, durationFrames: duration }, clip.timelineStart, {
    ...v,
    transform: { ...v.transform, scaleX: v.transform.scaleX * k, scaleY: v.transform.scaleY * k },
    matte: null,
  });
  timeline = r.timeline;
  return { timeline, clipId: r.clip.id };
}

/** B-roll: editable placeholder text layers on one new track at each accepted suggestion. */
export function addBrollPlaceholders(tl: TimelineModel, result: AIResult): { timeline: TimelineModel; added: number } {
  const clip = requireClip(tl, result.target.clipId);
  const items = accepted(result.items).filter((i): i is BrollItem => i.kind === "broll");
  if (items.length === 0) throw new ApplyError("No accepted suggestions.");
  const t = ops.addTrack(tl, "text", "B-roll suggestions");
  let timeline = ops.reorderTrack(t.timeline, t.track.id, 0);
  let added = 0;
  for (const it of items) {
    const s = sourceToTimeline(timeline, clip, it.start);
    const e = sourceToTimeline(timeline, clip, it.end);
    if (s === null || e === null || e - s < 1) continue;
    try {
      timeline = ops.insertClip(timeline, t.track.id, { kind: "text", text: `B-roll: ${it.query}`, durationFrames: e - s }, s, { transform: { x: tl.composition.width / 2, y: tl.composition.height * 0.12 } }).timeline;
      added++;
    } catch (err) {
      if (!(err instanceof TimelineEditError) || err.reason !== "overlap") throw err;
    }
  }
  return { timeline, added };
}
