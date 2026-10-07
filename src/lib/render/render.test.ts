import { describe, expect, it } from "vitest";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addEffect, addKeyframe, addMask, addTrack, addTransition, insertClip, setClipVisual } from "../timeline/operations";
import type { ClipContent } from "../timeline/clip";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { resolveFrame, type ResolvedFrame } from "../composition/resolve";
import { fakeContext } from "../composition/test-helpers";
import { sequenceFrameIndex } from "../composition/media-frame-provider";
import { checkRenderSettings, defaultVideoBitrate, OUTPUT_FRAME_RATES, OUTPUT_RESOLUTIONS, type RenderSettings } from "./settings";
import { buildRenderPlan, frameStep, RenderPlanError, timelineFrameAt } from "./plan";
import { buildRenderGraph, crossCheckFrame } from "./graph";
import { audioBlockers, audioChunks, renderAudio } from "./audio";
import { audioSyncCheck, fidelityCheck, flattenOverBlack, measureLag, psnr, structureCheck, technicalChecks, type ProbedOutput } from "./validate";

/**
 * PHASE 15 — FINAL RENDERING ENGINE, pure parts: settings, the render plan (frame count, duration, time mapping for
 * every supported rate pair), the render graph and its independent cross-check, the audio stage, and validation.
 * Encoding, decoding and pixels are tested for real in the browser (RENDER_ENGINE_TEST_REPORT.md).
 */

const SOURCES = { vid: { width: 1920, height: 1080 }, png: { width: 400, height: 400 }, aud: { width: 0, height: 0 } };
const rect = (fill: string, w = 400, h = 300) => normalizeShapeSpec({ type: "rect", width: w, height: h, fill, strokeWidth: 0, cornerRadius: 0 });

/** A 30 fps, 1920×1080, 4 s project touching every feature the final render must reproduce. */
function project(fps = 30, comp = { width: 1920, height: 1080 }) {
  let tl = createTimeline(fps, { ...comp, background: "#000000" });
  const ids: Record<string, string> = {};
  for (const [name, kind] of [["caption", "caption"], ["text", "text"], ["shapes", "graphic"], ["logo", "image"], ["main", "video"], ["music", "audio"]] as const) {
    const r = addTrack(tl, kind, name);
    tl = r.timeline;
    ids[name] = r.track.id;
  }
  const put = (track: string, content: ClipContent, start = 0) => {
    const r = insertClip(tl, ids[track], content, start);
    tl = r.timeline;
    return r.clip.id;
  };
  const sec = (s: number) => Math.round(s * fps);
  ids.v1 = put("main", { kind: "video", source: { sourceId: "vid" }, sourceInFrame: 0, sourceOutFrame: sec(2) });
  ids.v2 = put("main", { kind: "video", source: { sourceId: "vid" }, sourceInFrame: sec(2), sourceOutFrame: sec(4) }, sec(2));
  tl = addTransition(tl, { fromClipId: ids.v1, toClipId: ids.v2, type: "cross-dissolve", duration: sec(0.5) }).timeline;
  ids.logo = put("logo", { kind: "image", source: { sourceId: "png" }, durationFrames: sec(4) });
  ids.box = put("shapes", { kind: "graphic", shape: rect("#ff0000"), durationFrames: sec(4) });
  tl = addKeyframe(tl, ids.box, "visual.transform.x", 0, 200);
  tl = addKeyframe(tl, ids.box, "visual.transform.x", sec(3), 1700);
  tl = addEffect(tl, ids.box, "saturation", { amount: -1 }).timeline;
  tl = addMask(tl, ids.box, "ellipse").timeline;
  ids.title = put("text", { kind: "text", text: "FINAL", durationFrames: sec(4) });
  ids.cap = put("caption", { kind: "caption", text: "Hello there", durationFrames: sec(1.5) }, sec(1));
  ids.music = put("music", { kind: "audio", source: { sourceId: "aud" }, sourceInFrame: 0, sourceOutFrame: sec(4) });
  return { tl, ids };
}

const S = (fps: number, width = 1920, height = 1080): RenderSettings => ({ width, height, fps: fps as RenderSettings["fps"] });

describe("output settings", () => {
  it("exactly the four resolutions and five frame rates of the spec", () => {
    expect(OUTPUT_RESOLUTIONS.map((r) => `${r.width}x${r.height}`)).toEqual(["1080x1920", "1920x1080", "1080x1080", "2160x3840"]);
    expect([...OUTPUT_FRAME_RATES]).toEqual([24, 25, 30, 50, 60]);
  });

  it("same aspect at another size renders at a scale; a different aspect, size or rate is refused with the reason", () => {
    const tl916 = createTimeline(30, { width: 1080, height: 1920 });
    expect(checkRenderSettings(tl916, S(30, 2160, 3840))).toMatchObject({ ok: true, renderScale: 2 });
    expect(checkRenderSettings(tl916, S(30, 1080, 1920))).toMatchObject({ ok: true, renderScale: 1 });
    const bad = checkRenderSettings(tl916, S(30, 1920, 1080));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/16:9.*doesn't match the composition.*9:16/);
    expect(checkRenderSettings(tl916, S(30, 720, 1280)).errors[0]).toMatch(/Unsupported output size/);
    expect(checkRenderSettings(tl916, S(29.97, 1080, 1920)).errors[0]).toMatch(/Unsupported frame rate/);
  });

  it("high-quality default bitrate scales with pixels x fps and is clamped", () => {
    expect(defaultVideoBitrate(1920, 1080, 30)).toBe(Math.round(1920 * 1080 * 30 * 0.15));
    expect(defaultVideoBitrate(2160, 3840, 60)).toBe(74_649_600);
    expect(defaultVideoBitrate(1080, 1080, 24)).toBe(4_199_040);
    expect(defaultVideoBitrate(10, 10, 24)).toBe(4e6);
  });
});

describe("render plan: frame count, duration, time mapping", () => {
  it("native rate: one output frame per timeline frame, no media offset — final == preview frame for frame", () => {
    const { tl } = project(30);
    const p = buildRenderPlan(tl, S(30));
    expect(p.frameCount).toBe(120);
    expect(p.durationSec).toBe(4);
    expect(p.mediaFrameOffset).toBe(0);
    for (const k of [0, 1, 59, 119]) expect(frameStep(p, k)).toEqual({ index: k, timestamp: k / 30, duration: 1 / 30, timelineFrame: k });
  });

  it("every supported output rate covers the timeline exactly, with the right frame count and duration", () => {
    const { tl } = project(30); // 4.000 s
    for (const fps of OUTPUT_FRAME_RATES) {
      const p = buildRenderPlan(tl, S(fps));
      expect(p.frameCount).toBe(4 * fps);
      expect(p.durationSec).toBeCloseTo(4, 12);
      expect(p.audioSamples).toBe(192_000);
    }
  });

  it("a duration that isn't a whole number of output frames rounds UP (nothing on the timeline is cut off)", () => {
    let tl = createTimeline(30, { width: 1920, height: 1080 });
    const t = addTrack(tl, "graphic", "g");
    tl = insertClip(t.timeline, t.track.id, { kind: "graphic", shape: rect("#fff"), durationFrames: 31 }, 0).timeline; // 1.0333 s
    const p = buildRenderPlan(tl, S(25));
    expect(p.frameCount).toBe(26); // 25.83 -> 26
    expect(p.durationSec).toBeCloseTo(1.04, 12);
    expect(frameStep(p, 25).timelineFrame).toBe(30); // last output frame still starts inside the clip
  });

  it("time mapping is exact for every rate pair (no float drift over long renders)", () => {
    for (const proj of [24, 25, 30, 50, 60])
      for (const out of OUTPUT_FRAME_RATES) {
        const k = out * 3600; // one hour in
        expect(timelineFrameAt(k, proj, out)).toBe(proj * 3600);
      }
    expect(timelineFrameAt(1, 30, 60)).toBe(0.5);
    expect(timelineFrameAt(5, 30, 25)).toBe(6);
  });

  it("media is sampled at the centre of each output frame for any rate pair", () => {
    // Provider convention: a source frame sf is shown by seeking to (sf + 0.5) / projectFps.
    for (const proj of [24, 30, 60])
      for (const out of OUTPUT_FRAME_RATES) {
        const tl = createTimeline(proj, { width: 1920, height: 1080 });
        const t = addTrack(tl, "graphic", "g");
        const p = buildRenderPlan(insertClip(t.timeline, t.track.id, { kind: "graphic", shape: rect("#fff"), durationFrames: proj * 2 }, 0).timeline, S(out));
        for (const k of [0, 1, 7, out - 1]) {
          const sf = frameStep(p, k).timelineFrame + p.mediaFrameOffset; // clip at 0, in-point 0
          const seekSec = (sf + 0.5) / proj;
          expect(seekSec).toBeCloseTo((k + 0.5) / out, 12);
          // ... which is never on a source frame boundary when the rates match, and lands inside the right frame otherwise.
          expect(Math.floor(seekSec * proj + 1e-9)).toBe(Math.floor(((k + 0.5) * proj) / out));
        }
      }
  });

  it("a per-frame matte sequence shows the same source frame the video seek does (fractional frames)", () => {
    for (const sf of [0, 3, 0.25, 0.74, 5.5, 9.999]) expect(sequenceFrameIndex(sf)).toBe(Math.floor(sf + 0.5));
    expect(sequenceFrameIndex(7)).toBe(7); // identity on whole frames (preview unchanged)
  });

  it("checkpoints include first, last, clip edges and the transition midpoint", () => {
    const { tl } = project(30);
    const p = buildRenderPlan(tl, S(30));
    expect(p.checkpoints[0]).toBe(0);
    expect(p.checkpoints.at(-1)).toBe(119);
    expect(p.checkpoints).toContain(60); // cut / transition centre (crossfade straddles the cut)
    expect(p.checkpoints).toContain(30); // caption starts
    expect(p.checkpoints).toContain(29);
    expect(new Set(p.checkpoints).size).toBe(p.checkpoints.length);
  });

  it("an empty timeline or invalid settings throw a RenderPlanError with every reason", () => {
    expect(() => buildRenderPlan(createTimeline(30, { width: 1920, height: 1080 }), S(30))).toThrow(RenderPlanError);
    try {
      buildRenderPlan(project().tl, { width: 1080, height: 1920, fps: 23 as RenderSettings["fps"] });
    } catch (e) {
      expect((e as RenderPlanError).errors.length).toBe(2);
    }
  });

  it("no audible clip -> no audio track; audio: null forces none", () => {
    let tl = createTimeline(30, { width: 1920, height: 1080 });
    const t = addTrack(tl, "graphic", "g");
    tl = insertClip(t.timeline, t.track.id, { kind: "graphic", shape: rect("#fff"), durationFrames: 30 }, 0).timeline;
    expect(buildRenderPlan(tl, S(30)).settings.audio).toBeNull();
    expect(buildRenderPlan(project().tl, S(30)).settings.audio).toMatchObject({ sampleRate: 48000, channels: 2, codec: "aac" });
    expect(buildRenderPlan(project().tl, { ...S(30), audio: null }).settings.audio).toBeNull();
  });
});

describe("render graph + independent cross-check", () => {
  const ctx = fakeContext(SOURCES);

  it("describes each layer's chain back to front", () => {
    const { tl, ids } = project();
    const g = buildRenderGraph(resolveFrame(tl, 45, ctx));
    expect(g.map((n) => n.clipId)).toEqual([ids.v1, ids.logo, ids.box, ids.title, ids.cap]);
    const box = g.find((n) => n.clipId === ids.box)!;
    expect(box).toMatchObject({ source: "shape", effects: ["saturation"], masks: 1, matte: null, transition: null });
    expect(g[0]).toMatchObject({ source: "media", sourceFrame: 45 });
    const mid = buildRenderGraph(resolveFrame(tl, 60, ctx)).filter((n) => n.transition);
    expect(mid.map((n) => n.transition!.role)).toEqual(["from", "to"]);
  });

  it("a correct frame passes at every frame, native and at fractional (rate-converted) frames", () => {
    const { tl } = project();
    for (let f = 0; f < 120; f += 0.5) expect(crossCheckFrame(tl, f, resolveFrame(tl, f, ctx), ctx)).toEqual([]);
  });

  it("catches a wrong layer order, a dropped layer, an extra layer", () => {
    const { tl, ids } = project();
    const good = resolveFrame(tl, 45, ctx);
    const swapped: ResolvedFrame = { ...good, layers: [good.layers[1], good.layers[0], ...good.layers.slice(2)] };
    expect(crossCheckFrame(tl, 45, swapped, ctx).map((i) => i.check)).toContain("layer-order");
    const dropped: ResolvedFrame = { ...good, layers: good.layers.filter((l) => l.clipId !== ids.title) };
    expect(crossCheckFrame(tl, 45, dropped, ctx)).toEqual([expect.objectContaining({ check: "missing-layer", clipId: ids.title })]);
    const early = resolveFrame(tl, 20, ctx); // caption not on yet
    const extra: ResolvedFrame = { ...early, layers: [...early.layers, good.layers.find((l) => l.clipId === ids.cap)!] };
    expect(crossCheckFrame(tl, 20, extra, ctx).map((i) => i.check)).toContain("unexpected-layer");
  });

  it("culled layers (opacity 0, off-canvas) are legitimately absent", () => {
    const { tl: base, ids } = project();
    const tl = setClipVisual(base, ids.box, { opacity: 0 });
    const f = resolveFrame(tl, 45, ctx);
    expect(f.layers.some((l) => l.clipId === ids.box)).toBe(false);
    expect(crossCheckFrame(tl, 45, f, ctx)).toEqual([]);
  });

  it("catches wrong keyframe values, missing effects/masks/matte and a wrong transition progress", () => {
    const { tl, ids } = project();
    const good = resolveFrame(tl, 45, ctx);
    const edit = (fn: (l: ResolvedFrame["layers"][number]) => ResolvedFrame["layers"][number]): ResolvedFrame => ({ ...good, layers: good.layers.map((l) => (l.clipId === ids.box ? fn(l) : l)) });
    const kf = edit((l) => ({ ...l, visual: { ...l.visual, transform: { ...l.visual.transform, x: l.visual.transform.x + 3 } } }));
    expect(crossCheckFrame(tl, 45, kf, ctx)).toEqual([expect.objectContaining({ check: "keyframes", clipId: ids.box })]);
    expect(crossCheckFrame(tl, 45, edit((l) => ({ ...l, effects: [] })), ctx).map((i) => i.check)).toEqual(["effects"]);
    expect(crossCheckFrame(tl, 45, edit((l) => ({ ...l, masks: [] })), ctx).map((i) => i.check)).toEqual(["masks"]);
    expect(crossCheckFrame(tl, 45, edit((l) => ({ ...l, matte: { sourceId: "png", sourceFrame: 0, invert: false, channel: "alpha", decontaminate: false } })), ctx).map((i) => i.check)).toEqual(["matte"]);
    const mid = resolveFrame(tl, 58, ctx);
    const off: ResolvedFrame = { ...mid, layers: mid.layers.map((l) => (l.transition ? { ...l, transition: { ...l.transition, progress: l.transition.progress + 0.1 } } : l)) };
    expect(crossCheckFrame(tl, 58, off, ctx).filter((i) => i.check === "transition").length).toBe(2);
  });
});

describe("audio stage", () => {
  const tone = (sec: number, sr = 44100) => Float32Array.from({ length: sec * sr }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));

  it("renders exactly the video duration at 48 kHz stereo, resampled from the source rate", () => {
    const { tl } = project();
    for (const fps of [24, 25, 60] as const) {
      const plan = buildRenderPlan(tl, S(fps));
      const a = renderAudio(tl, (id) => (id === "aud" ? { sampleRate: 44100, channels: [tone(4)] } : undefined), plan);
      expect(a.channels[0].length).toBe(plan.audioSamples);
      expect(a.channels[1].length).toBe(plan.audioSamples);
      expect(a.channels[0][1000]).toBeCloseTo(a.channels[1][1000], 6); // mono source on both channels
    }
  });

  it("over-full-scale mixes are clamped and reported, never wrapped", () => {
    const { tl } = project();
    const plan = buildRenderPlan(tl, S(30));
    const loud = Float32Array.from({ length: 4 * 48000 }, (_, i) => (i % 2 ? 1.6 : -1.6));
    const a = renderAudio(tl, (id) => (id === "aud" ? { sampleRate: 48000, channels: [loud] } : undefined), plan);
    expect(Math.max(...a.channels[0].subarray(0, 1000))).toBe(1);
    expect(a.clippedSamples).toBeGreaterThan(0);
    expect(a.peak).toBeCloseTo(1.6, 5);
  });

  it("chunks cover every sample once, planar L then R, with exact timestamps", () => {
    const { tl } = project();
    const plan = buildRenderPlan(tl, S(30));
    const a = renderAudio(tl, () => ({ sampleRate: 48000, channels: [tone(4, 48000)] }), plan);
    let total = 0;
    for (const c of audioChunks(a, 4800)) {
      expect(c.timestamp).toBeCloseTo(total / 48000, 12);
      expect(c.data[0]).toBe(a.channels[0][total]);
      expect(c.data[c.frames]).toBe(a.channels[1][total]);
      total += c.frames;
    }
    expect(total).toBe(plan.audioSamples);
  });

  it("audio still decoding (or missing) blocks a final render; a video without a soundtrack doesn't", () => {
    const { tl } = project();
    const plan = buildRenderPlan(tl, S(30));
    expect(audioBlockers(tl, plan, () => "ready")).toEqual([]);
    expect(audioBlockers(tl, plan, (id) => (id === "aud" ? "loading" : "ready"))[0]).toMatch(/still decoding/);
    expect(audioBlockers(tl, plan, (id) => (id === "aud" ? "ready" : "no-audio"))).toEqual([]);
    expect(audioBlockers(tl, plan, (id) => (id === "aud" ? "error" : "ready"))[0]).toMatch(/isn't available/);
  });
});

describe("validation", () => {
  const plan = buildRenderPlan(project().tl, S(25));
  const good = (): ProbedOutput => ({
    mimeType: "video/mp4",
    video: { codec: "avc", width: 1920, height: 1080, frameCount: 100, timestamps: Array.from({ length: 100 }, (_, i) => Math.round((i / 25) * 90000) / 90000), durationSec: 4 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2, durationSec: 4.0003 },
  });

  it("a correct file passes every technical check", () => {
    const checks = technicalChecks(plan, good());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(["video-track", "resolution", "frame-count", "fps", "duration", "audio-track", "audio-format", "audio-duration"]);
  });

  it("each defect fails its own check", () => {
    const failing = (p: ProbedOutput) => technicalChecks(plan, p).filter((c) => !c.ok).map((c) => c.id);
    const g = good();
    expect(failing({ ...g, video: { ...g.video!, width: 1918 } })).toEqual(["resolution"]);
    const dropped = g.video!.timestamps.filter((_, i) => i !== 50);
    expect(failing({ ...g, video: { ...g.video!, frameCount: 99, timestamps: dropped } })).toEqual(["frame-count", "fps"]);
    expect(failing({ ...g, video: { ...g.video!, timestamps: g.video!.timestamps.map((t) => t * (25 / 24)) } })).toEqual(["fps"]);
    expect(failing({ ...g, video: { ...g.video!, durationSec: 4.05 } })).toEqual(["duration"]);
    expect(failing({ ...g, audio: { ...g.audio!, durationSec: 3.9 } })).toEqual(["audio-duration"]);
    expect(failing({ ...g, audio: { ...g.audio!, durationSec: 4.0307 } })).toEqual(["audio-duration"]); // encoder padding left in (live-test bug)
    expect(failing({ ...g, audio: { ...g.audio!, sampleRate: 44100 } })).toEqual(["audio-format"]);
    expect(failing({ ...g, audio: null })).toEqual(["audio-track"]);
  });

  it("PSNR: identical = Infinity, a one-level difference is ~48 dB, flattening over black premultiplies", () => {
    const a = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(psnr(a, a.slice())).toBe(Infinity);
    expect(psnr(a, a.map((v, i) => (i % 4 === 3 ? v : v + 1)))).toBeCloseTo(48.13, 1);
    expect([...flattenOverBlack(new Uint8ClampedArray([200, 100, 50, 128]))]).toEqual([100, 50, 25, 255]);
  });

  it("fidelity and structure checks report the worst frame / first issue", () => {
    expect(fidelityCheck([{ frame: 0, psnr: 44 }, { frame: 9, psnr: 21 }])).toMatchObject({ ok: false, detail: expect.stringContaining("frame 9") });
    expect(fidelityCheck([{ frame: 0, psnr: Infinity }]).ok).toBe(true);
    expect(fidelityCheck([]).ok).toBe(false);
    expect(structureCheck([], 100)).toMatchObject({ ok: true });
    expect(structureCheck([{ frame: 7, issues: [{ check: "masks", message: "x" }] }], 100)).toMatchObject({ ok: false, detail: expect.stringContaining("masks ×1") });
  });

  it("audio lag: a known shift is recovered to the sample, both directions; silence is reported as such", () => {
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const ref = new Float32Array(96000);
    for (let i = 30000; i < 40000; i++) ref[i] = noise() * Math.sin(i / 50);
    for (const shift of [0, 1, 2112, -37, 5000]) {
      const dec = new Float32Array(ref.length);
      for (let i = 0; i < ref.length; i++) if (i - shift >= 0 && i - shift < ref.length) dec[i] = ref[i - shift] * 0.8;
      const m = measureLag(ref, dec, 48000);
      expect(m.lag).toBe(shift);
      expect(m.corr).toBeGreaterThan(0.99);
    }
    expect(measureLag(new Float32Array(48000), new Float32Array(48000), 48000).silent).toBe(true);
    expect(audioSyncCheck({ lag: 2112, corr: 0.99, silent: false }, 48000)).toMatchObject({ ok: false, detail: expect.stringContaining("+44.00 ms") });
    expect(audioSyncCheck({ lag: 24, corr: 0.99, silent: false }, 48000).ok).toBe(true);
    expect(audioSyncCheck({ lag: 0, corr: 0.5, silent: false }, 48000).ok).toBe(false);
  });
});
