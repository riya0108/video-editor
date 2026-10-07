import type { Clip } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { evaluateTrack } from "../animation/keyframes";
import { getProperty, isAudioPath } from "../animation/properties";
import { activeTransitionAt, transitionsByTrack } from "../transitions/model";
import { isClipActiveAt, resolveClipLayer, type ResolveContext, type ResolvedFrame, type ResolvedLayer } from "../composition/resolve";

/**
 * RENDER GRAPH (RENDER_ENGINE_ARCHITECTURE.md §4).
 *
 * The COMPOSITION GRAPH of a frame is `resolveFrame()`'s output: the ordered layers with every property evaluated.
 * The RENDER GRAPH is what the compositor will execute for it — per layer, back to front, the chain
 *   source pixels -> effects -> masks -> matte -> transition -> opacity + blend -> composite
 * `buildRenderGraph` describes that chain (it is what `drawResolvedFrame` executes; the description is for the render
 * report and for tests). `crossCheckFrame` re-derives, from the RAW timeline and independently of the resolver's
 * code path, what each frame must contain, and reports every disagreement — so a resolver bug cannot quietly reach
 * an export.
 */

export interface RenderNode {
  z: number;
  clipId: string;
  trackId: string;
  source: "media" | "still" | "text" | "shape" | "svg";
  sourceFrame?: number;
  effects: string[];
  masks: number;
  matte: null | { channel: "alpha" | "luma"; invert: boolean };
  transition: null | { type: string; role: "from" | "to"; progress: number };
  opacity: number;
  blend: string;
}

export function buildRenderGraph(frame: ResolvedFrame): RenderNode[] {
  return frame.layers.map((l, z) => ({
    z,
    clipId: l.clipId,
    trackId: l.trackId,
    source: l.content.type === "media" ? (l.content.still ? "still" : "media") : l.content.type,
    ...(l.content.type === "media" && !l.content.still ? { sourceFrame: l.content.sourceFrame } : {}),
    effects: l.effects.map((e) => e.type),
    masks: l.masks.length,
    matte: l.matte ? { channel: l.matte.channel, invert: l.matte.invert } : null,
    transition: l.transition ? { type: l.transition.type, role: l.transition.role, progress: l.transition.progress } : null,
    opacity: l.opacity,
    blend: l.blendMode,
  }));
}

export interface CrossCheckIssue {
  check: "layer-order" | "missing-layer" | "unexpected-layer" | "effects" | "masks" | "matte" | "keyframes" | "transition" | "text";
  clipId?: string;
  message: string;
}

const EPS = 1e-6;

/**
 * Independent structural validation of one resolved frame against the timeline:
 *  - layer order: back-to-front paint order follows the track order (trackIds[0] = front);
 *  - presence: every clip active at `frame` on a visible, non-audio track is drawn — or is legitimately culled
 *    (opacity 0 / fully off-canvas) — and nothing else is;
 *  - effects / masks / matte: exactly the clip's enabled ones, in stack order;
 *  - keyframes: every animated property equals its track evaluated at the clip-local frame;
 *  - transitions: both sides of an active transition are tagged with it, at the expected progress;
 *  - text and captions: a non-empty text/caption clip is drawn as text.
 */
export function crossCheckFrame(timeline: TimelineModel, frame: number, resolved: ResolvedFrame, ctx: ResolveContext): CrossCheckIssue[] {
  const issues: CrossCheckIssue[] = [];
  const trackIndex = new Map(timeline.trackIds.map((id, i) => [id, i]));
  const byTrack = timeline.transitions ? transitionsByTrack(timeline) : undefined;

  // Layer order: track index must never INCREASE going front-wards (lower index = nearer the viewer).
  for (let i = 1; i < resolved.layers.length; i++) {
    const a = trackIndex.get(resolved.layers[i - 1].trackId) ?? -1;
    const b = trackIndex.get(resolved.layers[i].trackId) ?? -1;
    if (b > a) issues.push({ check: "layer-order", clipId: resolved.layers[i].clipId, message: `Layer ${resolved.layers[i].clipId} (track #${b}) is painted over a layer of track #${a}, which is in front of it.` });
  }

  // Expected clips, straight from the timeline.
  const expected = new Map<string, { clip: Clip; transitionId?: string; progress?: number }>();
  for (const trackId of timeline.trackIds) {
    const track = timeline.tracks[trackId];
    if (!track || !track.visible || track.kind === "audio") continue;
    const active = byTrack && activeTransitionAt(timeline, byTrack.get(trackId), frame);
    if (active) {
      for (const c of [active.window.from, active.window.to]) if (c) expected.set(c.id, { clip: c, transitionId: active.transition.id, progress: active.progress });
      continue;
    }
    for (const id of track.clipIds) {
      const c = timeline.clips[id];
      if (c && isClipActiveAt(c, frame)) expected.set(id, { clip: c });
    }
  }
  const drawn = new Map(resolved.layers.map((l) => [l.clipId, l]));
  for (const l of resolved.layers) if (!expected.has(l.clipId)) issues.push({ check: "unexpected-layer", clipId: l.clipId, message: `Clip ${l.clipId} is drawn at frame ${frame} but isn't active there.` });

  for (const [id, exp] of expected) {
    const layer = drawn.get(id);
    const c = exp.clip;
    const hasText = (c.content.kind === "text" || c.content.kind === "caption") && !!c.content.text;
    if (!layer) {
      if (resolved.missingSources.length > 0) continue; // reported separately; final rendering refuses such frames
      const solo = resolveClipLayer(timeline, id, frame, ctx);
      const culled = !solo || solo.opacity <= 0 || !intersectsComp(solo, timeline);
      if (!culled) issues.push({ check: "missing-layer", clipId: id, message: `Clip ${id} is active and visible at frame ${frame} but isn't drawn.` });
      continue;
    }
    if (hasText && layer.content.type !== "text") issues.push({ check: "text", clipId: id, message: `Text clip ${id} isn't drawn as text.` });
    const wantFx = (c.effects ?? []).filter((e) => e.enabled).map((e) => e.id);
    const gotFx = layer.effects.map((e) => e.id);
    if (wantFx.join() !== gotFx.join()) issues.push({ check: "effects", clipId: id, message: `Effects [${gotFx}] drawn, expected [${wantFx}].` });
    const wantMasks = (c.masks ?? []).filter((m) => m.enabled).map((m) => m.id);
    if (wantMasks.join() !== layer.masks.map((m) => m.id).join()) issues.push({ check: "masks", clipId: id, message: `Masks [${layer.masks.map((m) => m.id)}] drawn, expected [${wantMasks}].` });
    const wantMatte = c.visual?.matte ?? null;
    if (!!wantMatte !== !!layer.matte || (wantMatte && layer.matte && (wantMatte.sourceId !== layer.matte.sourceId || !!wantMatte.invert !== layer.matte.invert))) {
      issues.push({ check: "matte", clipId: id, message: `Matte mismatch on ${id}.` });
    }
    if (exp.transitionId) {
      if (layer.transition?.id !== exp.transitionId || Math.abs(layer.transition.progress - (exp.progress ?? 0)) > EPS) {
        issues.push({ check: "transition", clipId: id, message: `Clip ${id} should be in transition ${exp.transitionId} at progress ${exp.progress?.toFixed(4)}; got ${layer.transition ? `${layer.transition.id} @ ${layer.transition.progress.toFixed(4)}` : "none"}.` });
      }
    } else if (layer.transition) {
      issues.push({ check: "transition", clipId: id, message: `Clip ${id} is tagged with a transition outside any transition window.` });
    }
    if (c.content.kind !== "caption") issues.push(...checkKeyframes(timeline, c, layer, frame - c.timelineStart));
  }
  return issues;
}

function intersectsComp(l: ResolvedLayer, tl: TimelineModel): boolean {
  const b = l.bounds;
  return b.x < tl.composition.width && b.y < tl.composition.height && b.x + b.width > 0 && b.y + b.height > 0;
}

/** Animated values from the raw keyframe tracks, set through each property's own setter, vs. what was resolved. */
function checkKeyframes(timeline: TimelineModel, clip: Clip, layer: ResolvedLayer, local: number): CrossCheckIssue[] {
  const tracks = clip.animation?.tracks;
  if (!tracks) return [];
  const comp = timeline.composition;
  const asResolved: Clip = {
    ...clip,
    visual: layer.visual,
    effects: layer.effects.map((e) => ({ ...e, enabled: true })) as Clip["effects"],
    masks: layer.masks,
  };
  const out: CrossCheckIssue[] = [];
  for (const [path, track] of Object.entries(tracks)) {
    if (isAudioPath(path) || track.keyframes.length === 0) continue;
    const prop = getProperty(path);
    if (!prop) continue;
    const want = prop.get(prop.set(clip, evaluateTrack(track, local), comp), comp);
    const got = prop.get(asResolved, comp);
    if (!(Math.abs(want - got) <= 1e-6 * Math.max(1, Math.abs(want)))) out.push({ check: "keyframes", clipId: clip.id, message: `${path} = ${got} at local frame ${local}, keyframes give ${want}.` });
  }
  return out;
}
