import { createTimeline, type TimelineModel } from "../timeline/model";
import { addEffect, addKeyframe, addMask, addTrack, addTransition, insertClip } from "../timeline/operations";
import type { ClipContent } from "../timeline/clip";
import type { ClipVisualPatch } from "../timeline/visual";
import { normalizeShapeSpec } from "../timeline/shape-style";

/**
 * PROBE PROJECT (RENDER_ENGINE_TEST_REPORT.md) — a 4 s, 30 fps timeline that puts every feature the final render
 * must reproduce at a KNOWN place, for any composition shape, so an encoded file can be checked pixel-probe by
 * pixel-probe with an independent decoder (ffmpeg):
 *
 *   counter video  frame number as 10 binary blocks in the top 1/6 (fit: fill) — which SOURCE frame every output
 *                  frame shows; a CUT at 2 s (source jumps 59 -> 90) under a 0.5 s CROSS-DISSOLVE
 *   logo           50%-alpha red PNG                                — alpha compositing
 *   yellow rect    + saturation -1 effect                           — effects
 *   green rect     + ellipse mask (middle 60%)                      — masks
 *   blue box       x keyframed 0.15W -> 0.85W over 0..3 s, above the yellow rect — keyframes, transforms, layer order
 *   title text     "FINAL RENDER"                                   — text
 *   caption        "CAPTION TEST", 1.0-2.5 s                        — captions
 *   tone           1 kHz beeps at source 1.0 s and 2.5 s, clip at 0.5 s -> heard at 1.5 s and 3.0 s — audio + sync
 *
 * Pure: the Node eval test rebuilds expectations from the same layout numbers.
 */

export const PROBE_SOURCES = { counter: "probe-counter30", logo: "probe-logo", tone: "probe-tone" } as const;
export const PROBE_FPS = 30;

export interface ProbeLayout {
  width: number;
  height: number;
  /** Scale unit: min(W, H) / 1080. */
  u: number;
  counterRows: number;
  logo: { x: number; y: number; size: number };
  fx: { x: number; y: number; w: number; h: number };
  box: { y: number; size: number; x0: number; x1: number; keyEndFrame: number };
  mask: { x: number; y: number; size: number };
  title: { y: number };
  caption: { startFrame: number; endFrame: number };
  cut: { frame: number; sourceJump: [number, number] };
  audio: { clipStartFrame: number; beepsSec: number[] };
}

export function probeLayout(width: number, height: number): ProbeLayout {
  const u = Math.min(width, height) / 1080;
  return {
    width,
    height,
    u,
    counterRows: Math.round(height / 6),
    logo: { x: 0.15 * width, y: 0.45 * height, size: 200 * u },
    fx: { x: 0.5 * width, y: 0.62 * height, w: 300 * u, h: 200 * u },
    box: { y: 0.62 * height, size: 160 * u, x0: 0.15 * width, x1: 0.85 * width, keyEndFrame: 90 },
    mask: { x: 0.82 * width, y: 0.45 * height, size: 260 * u },
    title: { y: 0.3 * height },
    caption: { startFrame: 30, endFrame: 75 },
    cut: { frame: 60, sourceJump: [59, 90] },
    audio: { clipStartFrame: 15, beepsSec: [1.5, 3.0] },
  };
}

const rect = (fill: string, w: number, h: number) => normalizeShapeSpec({ type: "rect", width: w, height: h, fill, strokeWidth: 0, cornerRadius: 0 });

export function buildProbeProject(width: number, height: number): { timeline: TimelineModel; layout: ProbeLayout; ids: Record<string, string> } {
  const L = probeLayout(width, height);
  let tl = createTimeline(PROBE_FPS, { width, height, background: "#000000" });
  const ids: Record<string, string> = {};
  // trackIds[0] is FRONTMOST: added front to back.
  for (const [name, kind] of [["caption", "caption"], ["title", "text"], ["box", "graphic"], ["mask", "graphic"], ["fx", "graphic"], ["logo", "image"], ["video", "video"], ["tone", "audio"]] as const) {
    const r = addTrack(tl, kind, name);
    tl = r.timeline;
    ids[name] = r.track.id;
  }
  const put = (track: string, content: ClipContent, start: number, visual?: ClipVisualPatch) => {
    const r = insertClip(tl, ids[track], content, start, visual);
    tl = r.timeline;
    return r.clip.id;
  };
  const at = (x: number, y: number, scale = 1): ClipVisualPatch => ({ fit: "none", transform: { x, y, scaleX: scale, scaleY: scale } });

  ids.videoA = put("video", { kind: "video", source: { sourceId: PROBE_SOURCES.counter, sourceDurationFrames: 180 }, sourceInFrame: 0, sourceOutFrame: 60 }, 0, { fit: "fill" });
  ids.videoB = put("video", { kind: "video", source: { sourceId: PROBE_SOURCES.counter, sourceDurationFrames: 180 }, sourceInFrame: 90, sourceOutFrame: 150 }, 60, { fit: "fill" });
  tl = addTransition(tl, { fromClipId: ids.videoA, toClipId: ids.videoB, type: "cross-dissolve", duration: 15 }).timeline;
  ids.logoClip = put("logo", { kind: "image", source: { sourceId: PROBE_SOURCES.logo }, durationFrames: 120 }, 0, at(L.logo.x, L.logo.y, L.logo.size / 400));
  ids.fxClip = put("fx", { kind: "graphic", shape: rect("#ffff00", L.fx.w, L.fx.h), durationFrames: 120 }, 0, at(L.fx.x, L.fx.y));
  tl = addEffect(tl, ids.fxClip, "saturation", { amount: -1 }).timeline;
  ids.maskClip = put("mask", { kind: "graphic", shape: rect("#00ff00", L.mask.size, L.mask.size), durationFrames: 120 }, 0, at(L.mask.x, L.mask.y));
  tl = addMask(tl, ids.maskClip, "ellipse").timeline;
  ids.boxClip = put("box", { kind: "graphic", shape: rect("#0000ff", L.box.size, L.box.size), durationFrames: 120 }, 0, at(L.box.x0, L.box.y));
  tl = addKeyframe(tl, ids.boxClip, "visual.transform.x", 0, L.box.x0);
  tl = addKeyframe(tl, ids.boxClip, "visual.transform.x", L.box.keyEndFrame, L.box.x1);
  ids.titleClip = put("title", { kind: "text", text: "FINAL RENDER", durationFrames: 120, textStyle: { fontSize: Math.round(72 * L.u), color: "#ffffff" } as never }, 0, { transform: { x: width / 2, y: L.title.y } });
  ids.captionClip = put("caption", { kind: "caption", text: "CAPTION TEST", durationFrames: L.caption.endFrame - L.caption.startFrame }, L.caption.startFrame);
  ids.toneClip = put("tone", { kind: "audio", source: { sourceId: PROBE_SOURCES.tone }, sourceInFrame: 0, sourceOutFrame: 105 }, L.audio.clipStartFrame);
  return { timeline: tl, layout: L, ids };
}
