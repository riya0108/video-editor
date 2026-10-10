import { createTimeline, type TimelineModel } from "../timeline/model";
import { addEffect, addKeyframe, addMask, addTrack, addTransition, insertClip, updateMask } from "../timeline/operations";
import type { ClipContent } from "../timeline/clip";
import type { ClipVisualPatch } from "../timeline/visual";
import { normalizeShapeSpec } from "../timeline/shape-style";

/**
 * BENCHMARK PROJECT (PERFORMANCE_BASELINE.md §2) — a realistic, deliberately busy 1920×1080 / 30 fps edit used by
 * every Phase 18 measurement, so before/after numbers are taken on the same work:
 *
 *   main video    full-frame 1080p H.264, split at 5 s with a 0.5 s cross-dissolve (two decoders during the dissolve)
 *   PiP video     the same source 20 s later, scaled 0.4, brightness effect + feathered ellipse mask (isolated path)
 *   logo          still image, screen blend
 *   lower third   rounded rect + blur effect (spatial effect kernel)
 *   badge         ellipse, x keyframed across the frame
 *   title         text with stroke + shadow
 *   caption       caption-track text
 *   music         the video's own soundtrack on an audio track
 *
 * Pure: builds only the timeline. Sources are registered by the harness under BENCH_SOURCES ids.
 */

export const BENCH_SOURCES = { video: "bench-video", logo: "bench-logo" } as const;
export const BENCH_FPS = 30;
export const BENCH_WIDTH = 1920;
export const BENCH_HEIGHT = 1080;

export function buildBenchProject(opts: { durationFrames?: number; sourceFrames?: number } = {}): { timeline: TimelineModel; ids: Record<string, string> } {
  const dur = opts.durationFrames ?? 300;
  const srcFrames = opts.sourceFrames ?? 1800;
  const split = Math.floor(dur / 2);
  let tl = createTimeline(BENCH_FPS, { width: BENCH_WIDTH, height: BENCH_HEIGHT, background: "#000000" });
  const ids: Record<string, string> = {};
  // trackIds[0] is FRONTMOST: added front to back.
  for (const [name, kind] of [["caption", "caption"], ["title", "text"], ["badge", "graphic"], ["lower", "graphic"], ["logo", "image"], ["pip", "overlay"], ["main", "video"], ["music", "audio"]] as const) {
    const r = addTrack(tl, kind, name);
    tl = r.timeline;
    ids[name] = r.track.id;
  }
  const put = (track: string, content: ClipContent, start: number, visual?: ClipVisualPatch) => {
    const r = insertClip(tl, ids[track], content, start, visual);
    tl = r.timeline;
    return r.clip.id;
  };
  const video = (inF: number, outF: number) => ({ source: { sourceId: BENCH_SOURCES.video, sourceDurationFrames: srcFrames }, sourceInFrame: inF, sourceOutFrame: outF });

  ids.mainA = put("main", { kind: "video", ...video(0, split) }, 0, { fit: "cover" });
  ids.mainB = put("main", { kind: "video", ...video(split + 120, dur + 120) }, split, { fit: "cover" });
  tl = addTransition(tl, { fromClipId: ids.mainA, toClipId: ids.mainB, type: "cross-dissolve", duration: 15 }).timeline;

  ids.pip = put("pip", { kind: "overlay", ...video(600, 600 + dur) }, 0, { fit: "contain", transform: { x: 1500, y: 300, scaleX: 0.4, scaleY: 0.4 } });
  tl = addEffect(tl, ids.pip, "brightness", { amount: 0.1 }).timeline;
  const m = addMask(tl, ids.pip, "ellipse");
  tl = updateMask(m.timeline, ids.pip, m.mask.id, { feather: 24 });

  ids.logo = put("logo", { kind: "image", source: { sourceId: BENCH_SOURCES.logo }, durationFrames: dur }, 0, { fit: "none", opacity: 0.9, blendMode: "screen", transform: { x: 160, y: 120, scaleX: 0.5, scaleY: 0.5 } });

  ids.lower = put("lower", { kind: "graphic", shape: normalizeShapeSpec({ type: "rectangle", width: 900, height: 140, fill: true, fillColor: "#111827", cornerRadius: 24, stroke: false }), durationFrames: dur }, 0, { fit: "none", opacity: 0.85, transform: { x: 560, y: 900 } });
  tl = addEffect(tl, ids.lower, "blur", { radius: 6 }).timeline;

  ids.badge = put("badge", { kind: "graphic", shape: normalizeShapeSpec({ type: "ellipse", width: 160, height: 160, fill: true, fillColor: "#f59e0b", stroke: true, strokeColor: "#ffffff", strokeWidth: 6 }), durationFrames: dur }, 0, { fit: "none" });
  tl = addKeyframe(tl, ids.badge, "visual.transform.x", 0, 200);
  tl = addKeyframe(tl, ids.badge, "visual.transform.x", dur - 1, 1720);

  ids.title = put("title", { kind: "text", text: "Performance Benchmark", durationFrames: dur, textStyle: { fontSize: 84, color: "#ffffff", stroke: true, strokeColor: "#000000", strokeWidth: 4, shadow: true, shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 4, shadowColor: "rgba(0,0,0,0.6)" } as never }, 0, { transform: { x: 960, y: 140 } });
  ids.caption = put("caption", { kind: "caption", text: "Captions render through the text engine", durationFrames: dur }, 0);
  ids.music = put("music", { kind: "audio", ...video(0, dur) }, 0);
  return { timeline: tl, ids };
}
