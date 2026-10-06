import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import type { TimelineModel } from "../timeline/model";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { normalizeTextStyle } from "../timeline/text-style";
import { deserializeTimeline, serializeTimeline, ProjectFormatError } from "../timeline/serialize";
import { resolveFrame, type ResolvedLayer } from "../composition/resolve";
import { drawResolvedFrame, type Ctx2D } from "../composition/draw";
import { fakeContext } from "../composition/test-helpers";
import { svgSpecFromMarkup } from "../graphics/svg";
import { GRAPHICS_LIBRARY } from "../graphics/library";
import { applyEffects, blurPremultiplied, effectsSpill, type EffectContext, type EvaluatedEffect } from "./process";
import { EFFECT_DEFINITIONS, type EffectType } from "./registry";
import { effectKeyframes, effectParamPath, normalizeEffect } from "./model";

/**
 * PHASE 9 — EFFECTS ENGINE acceptance suite. Kernels are tested on real pixel
 * buffers with exact expected values; integration is tested through
 * resolveFrame + drawResolvedFrame (what both renderers use).
 */

// ---- helpers -----------------------------------------------------------------

function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Float32Array {
  const b = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(fill(x, y), (y * w + x) * 4);
  return b;
}
const px = (b: Float32Array, w: number, x: number, y: number) => Array.from(b.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
const ctxFor = (w: number, h: number, extra: Partial<EffectContext> = {}): EffectContext => ({ width: w, height: h, renderScale: 1, frame: 0, originX: 0, originY: 0, layerRect: { x: 0, y: 0, width: w, height: h }, ...extra });
const fx = (type: EffectType, params: Record<string, number>, id = "fx-t"): EvaluatedEffect => ({ id, type, params });
const run = (b: Float32Array, w: number, h: number, effects: EvaluatedEffect[], extra: Partial<EffectContext> = {}) => applyEffects(b, effects, ctxFor(w, h, extra));
const close = (a: number[], e: number[], d = 3) => a.forEach((v, i) => expect(v).toBeCloseTo(e[i], d));

function project() {
  return new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw (r as unknown as { error: Error }).error;
  return r as Extract<T, { ok: true }>;
}
function addRect(e: TimelineEngine) {
  return ok(e.addGraphicLayer({ graphic: { shape: normalizeShapeSpec({ type: "rect", width: 200, height: 100 }) }, atFrame: 0, durationFrames: 120 })).clip.id;
}
const ctx = () => fakeContext({ v: { width: 1920, height: 1080 }, png: { width: 600, height: 400 }, cut: { width: 800, height: 1200 }, matte: { width: 400, height: 600 } });
const layer = (tl: TimelineModel, id: string, f = 0): ResolvedLayer => resolveFrame(tl, f, ctx()).layers.find((l) => l.clipId === id)!;

// ---- 12 kernels on real pixels ------------------------------------------------

describe("color kernels (exact values)", () => {
  const gray = () => img(1, 1, () => [0.5, 0.5, 0.5, 1]);
  it("brightness adds and clamps", () => {
    close(px(run(gray(), 1, 1, [fx("brightness", { amount: 0.2 })]), 1, 0, 0), [0.7, 0.7, 0.7, 1]);
    close(px(run(gray(), 1, 1, [fx("brightness", { amount: 1 })]), 1, 0, 0), [1, 1, 1, 1]);
  });
  it("contrast pivots around mid-gray", () => {
    close(px(run(img(1, 1, () => [0.75, 0.5, 0.25, 1]), 1, 1, [fx("contrast", { amount: 1 })]), 1, 0, 0), [1, 0.5, 0, 1]);
  });
  it("saturation -100% gives Rec.709 luma gray; +100% pushes away from it", () => {
    const y = 0.2126 * 0.8 + 0.7152 * 0.4 + 0.0722 * 0.2;
    close(px(run(img(1, 1, () => [0.8, 0.4, 0.2, 1]), 1, 1, [fx("saturation", { amount: -1 })]), 1, 0, 0), [y, y, y, 1]);
    const sat = px(run(img(1, 1, () => [0.6, 0.4, 0.4, 1]), 1, 1, [fx("saturation", { amount: 1 })]), 1, 0, 0);
    expect(sat[0] - sat[1]).toBeGreaterThan(0.2);
  });
  it("exposure is linear-light: +1 stop doubles linear intensity", () => {
    const out = px(run(gray(), 1, 1, [fx("exposure", { stops: 1 })]), 1, 0, 0)[0];
    const lin = Math.pow((0.5 + 0.055) / 1.055, 2.4) * 2;
    expect(out).toBeCloseTo(1.055 * Math.pow(lin, 1 / 2.4) - 0.055, 2);
    expect(px(run(gray(), 1, 1, [fx("exposure", { stops: 0 })]), 1, 0, 0)[0]).toBeCloseTo(0.5, 2);
  });
  it("temperature warms (R up, B down) / cools; tint shifts green-magenta", () => {
    const warm = px(run(gray(), 1, 1, [fx("temperature", { amount: 1 })]), 1, 0, 0);
    expect(warm[0]).toBeCloseTo(0.625, 6);
    expect(warm[2]).toBeCloseTo(0.375, 6);
    const magenta = px(run(gray(), 1, 1, [fx("tint", { amount: 1 })]), 1, 0, 0);
    expect(magenta[1]).toBeCloseTo(0.375, 6);
    expect(px(run(gray(), 1, 1, [fx("tint", { amount: -1 })]), 1, 0, 0)[1]).toBeCloseTo(0.625, 6);
  });
  it("opacity scales alpha only", () => {
    close(px(run(img(1, 1, () => [0.2, 0.4, 0.6, 0.8]), 1, 1, [fx("opacity", { amount: 0.5 })]), 1, 0, 0), [0.2, 0.4, 0.6, 0.4]);
  });
  it("transparent pixels are left alone by color effects", () => {
    close(px(run(img(1, 1, () => [0, 0, 0, 0]), 1, 1, [fx("brightness", { amount: 0.5 })]), 1, 0, 0), [0, 0, 0, 0]);
  });
});

describe("spatial kernels", () => {
  it("blur conserves energy and spreads a point", () => {
    const w = 41;
    const b = img(w, w, (x, y) => (x === 20 && y === 20 ? [1, 1, 1, 1] : [0, 0, 0, 0]));
    const out = blurPremultiplied(b, w, w, 3);
    let sum = 0;
    for (let i = 3; i < out.length; i += 4) sum += out[i];
    expect(sum).toBeCloseTo(1, 4);
    expect(out[(20 * w + 23) * 4 + 3]).toBeGreaterThan(0); // spread 3px away
  });
  it("blur on a white shape over transparency keeps edges WHITE (premultiplied: no dark fringe)", () => {
    const w = 40;
    const b = img(w, w, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? [1, 1, 1, 1] : [0, 0, 0, 0]));
    const out = run(b, w, w, [fx("blur", { radius: 8 })]);
    const edge = px(out, w, 9, 20); // just outside the original shape: now partially transparent
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(1);
    close(edge.slice(0, 3), [1, 1, 1], 2); // color stays white, not darkened toward black
  });
  it("blur radius scales with the render scale (preview matches export)", () => {
    const mk = (w: number) => img(w, 1, (x) => (x === Math.floor(w / 2) ? [1, 1, 1, 1] : [0, 0, 0, 0]));
    const full = run(mk(81), 81, 1, [fx("blur", { radius: 12 })], { renderScale: 1 });
    const half = run(mk(41), 41, 1, [fx("blur", { radius: 12 })], { renderScale: 0.5 });
    // alpha at "the same composition distance" (8 comp px) matches within resampling tolerance
    expect(half[(20 + 4) * 4 + 3] / 2).toBeCloseTo(full[(40 + 8) * 4 + 3], 1);
  });
  it("sharpen increases contrast across an edge and leaves flat areas alone", () => {
    const w = 20;
    const b = img(w, 1, (x) => (x < 10 ? [0.3, 0.3, 0.3, 1] : [0.7, 0.7, 0.7, 1]));
    const out = run(b, w, 1, [fx("sharpen", { amount: 1, radius: 2 })]);
    expect(px(out, w, 9, 0)[0]).toBeLessThan(0.3);
    expect(px(out, w, 10, 0)[0]).toBeGreaterThan(0.7);
    expect(px(out, w, 2, 0)[0]).toBeCloseTo(0.3, 3);
  });
  it("vignette darkens corners relative to the LAYER's bounds, not the region", () => {
    const w = 100;
    const b = img(w, w, () => [1, 1, 1, 1]);
    const out = run(b, w, w, [fx("vignette", { amount: 1, size: 0.5, softness: 0.4 })], { layerRect: { x: 25, y: 25, width: 50, height: 50 } });
    expect(px(out, w, 50, 50)[0]).toBeCloseTo(1, 6); // layer center untouched
    expect(px(out, w, 26, 26)[0]).toBeLessThan(0.2); // layer corner dark
  });
  it("grain: deterministic per frame, different across frames, ~zero-mean, anchored to composition space", () => {
    const w = 64;
    const gray = () => img(w, w, () => [0.5, 0.5, 0.5, 1]);
    const a = run(gray(), w, w, [fx("grain", { amount: 1, size: 1 }, "fx-9")], { frame: 3 });
    const a2 = run(gray(), w, w, [fx("grain", { amount: 1, size: 1 }, "fx-9")], { frame: 3 });
    const bOther = run(gray(), w, w, [fx("grain", { amount: 1, size: 1 }, "fx-9")], { frame: 4 });
    expect(Array.from(a)).toEqual(Array.from(a2));
    expect(Array.from(a)).not.toEqual(Array.from(bOther));
    let mean = 0;
    for (let i = 0; i < a.length; i += 4) mean += a[i];
    expect(mean / (w * w)).toBeCloseTo(0.5, 1);
    // same composition pixel (x=10) at render scale 1 vs 0.5 (x=5) -> same lattice cell -> same noise
    const half = run(img(32, 32, () => [0.5, 0.5, 0.5, 1]), 32, 32, [fx("grain", { amount: 1, size: 2 }, "fx-9")], { frame: 3, renderScale: 0.5 });
    const full = run(gray(), w, w, [fx("grain", { amount: 1, size: 2 }, "fx-9")], { frame: 3, renderScale: 1 });
    expect(px(half, 32, 5, 5)[0]).toBeCloseTo(px(full, w, 10, 10)[0], 6);
  });
  it("glow: bright areas bloom beyond their edges; dark areas below the threshold don't", () => {
    const w = 40;
    const bright = run(img(w, w, (x, y) => (x >= 15 && x < 25 && y >= 15 && y < 25 ? [1, 1, 1, 1] : [0, 0, 0, 0])), w, w, [fx("glow", { radius: 10, intensity: 1, threshold: 0.5 })]);
    expect(px(bright, w, 12, 20)[3]).toBeGreaterThan(0); // halo alpha outside the square
    const dark = run(img(w, w, (x, y) => (x >= 15 && x < 25 && y >= 15 && y < 25 ? [0.2, 0.2, 0.2, 1] : [0, 0, 0, 0])), w, w, [fx("glow", { radius: 10, intensity: 1, threshold: 0.5 })]);
    expect(px(dark, w, 12, 20)[3]).toBe(0);
  });
  it("stack order matters (brightness->contrast != contrast->brightness)", () => {
    const g = () => img(1, 1, () => [0.6, 0.6, 0.6, 1]);
    const a = px(run(g(), 1, 1, [fx("brightness", { amount: 0.2 }), fx("contrast", { amount: 1 })]), 1, 0, 0)[0];
    const b = px(run(g(), 1, 1, [fx("contrast", { amount: 1 }), fx("brightness", { amount: 0.2 })]), 1, 0, 0)[0];
    expect(a).not.toBeCloseTo(b, 3);
  });
  it("spill covers blur/glow/sharpen reach", () => {
    expect(effectsSpill([fx("blur", { radius: 10 }), fx("glow", { radius: 20, intensity: 1, threshold: 0.5 }), fx("brightness", { amount: 1 })])).toBe(45);
  });
});

// ---- engine ops ---------------------------------------------------------------

describe("effect ops: add / edit / reorder / enable / remove — each one undo step", () => {
  it("full lifecycle", () => {
    const e = project();
    const id = addRect(e);
    const b = ok(e.addEffect(id, "brightness", { amount: 0.3 })).effect;
    const c = ok(e.addEffect(id, "contrast")).effect;
    expect(e.timeline.clips[id].effects!.map((x) => x.type)).toEqual(["brightness", "contrast"]);
    expect(c.params).toEqual({ amount: 0 }); // defaults
    ok(e.moveEffect(id, c.id, 0));
    expect(e.timeline.clips[id].effects!.map((x) => x.type)).toEqual(["contrast", "brightness"]);
    ok(e.setEffectEnabled(id, b.id, false));
    expect(layer(e.timeline, id).effects.map((x) => x.type)).toEqual(["contrast"]); // disabled = not processed
    ok(e.updateEffectParams(id, c.id, { amount: 99 }));
    expect(e.timeline.clips[id].effects![0].params.amount).toBe(1); // clamped
    ok(e.removeEffect(id, b.id));
    expect(e.timeline.clips[id].effects!.map((x) => x.id)).toEqual([c.id]);
    const snapshots: TimelineModel[] = [];
    for (let i = 0; i < 6; i++) {
      snapshots.push(e.timeline);
      e.undo();
    }
    expect(e.timeline.clips[id].effects).toBeUndefined();
    for (let i = 5; i >= 0; i--) {
      e.redo();
      expect(e.timeline).toBe(snapshots[i]);
    }
  });
  it("rejects unknown types/params, audio clips, locked tracks", () => {
    const e = project();
    const id = addRect(e);
    expect(e.addEffect(id, "lens-flare").ok).toBe(false);
    const fxId = ok(e.addEffect(id, "blur")).effect.id;
    expect(e.updateEffectParams(id, fxId, { nope: 1 }).ok).toBe(false);
    expect(e.updateEffectParams(id, fxId, { radius: NaN }).ok).toBe(false);
    e.setTrackLocked(e.timeline.clips[id].trackId, true);
    expect(e.addEffect(id, "grain").ok).toBe(false);
    const a = e.addTrack("audio", "A");
    if (!a.ok) throw a.error;
    const ac = ok(e.insertClip(a.track.id, { kind: "audio", source: { sourceId: "s" }, sourceInFrame: 0, sourceOutFrame: 10 }, 0)).clip.id;
    expect(e.addEffect(ac, "blur").ok).toBe(false);
  });
});

describe("keyframe compatibility (Phase 8 engine, no second system)", () => {
  it("effect params animate through the existing keyframe engine; auto-key at the playhead", () => {
    const e = project();
    const id = addRect(e);
    const blur = ok(e.addEffect(id, "blur", { radius: 0 })).effect;
    const path = effectParamPath(blur.id, "radius");
    ok(e.addKeyframe(id, path, 0, 0));
    ok(e.addKeyframe(id, path, 30, 30, { type: "linear" }));
    expect(layer(e.timeline, id, 15).effects[0].params.radius).toBeCloseTo(15, 6);
    expect(layer(e.timeline, id, 90).effects[0].params.radius).toBe(30);
    ok(e.updateEffectParams(id, blur.id, { radius: 50 }, 60)); // animated -> keyframe at frame 60
    expect(effectKeyframes(e.timeline.clips[id].animation, blur.id).radius.keyframes.map((k) => [k.frame, k.value])).toEqual([[0, 0], [30, 30], [60, 50]]);
    expect(e.timeline.clips[id].effects![0].params.radius).toBe(0); // static base untouched
    // keyframed values are clamped to the param range, like edits
    ok(e.addKeyframe(id, path, 90, 9999));
    expect(layer(e.timeline, id, 90).effects[0].params.radius).toBe(200);
    // removing the effect removes its keyframe tracks (no orphans)
    ok(e.removeEffect(id, blur.id));
    expect(e.timeline.clips[id].animation).toBeUndefined();
  });
  it("clips without effects keep the unchanged draw path", () => {
    const e = project();
    const id = addRect(e);
    expect(layer(e.timeline, id).effects).toEqual([]);
  });
});

describe("save / reload", () => {
  it("effects (order, enabled, params, metadata) and their keyframes round-trip", () => {
    const e = project();
    const id = addRect(e);
    const a = ok(e.addEffect(id, "glow", { radius: 30, intensity: 1.5, threshold: 0.4 })).effect;
    const b = ok(e.addEffect(id, "vignette")).effect;
    ok(e.setEffectEnabled(id, b.id, false));
    ok(e.addKeyframe(id, effectParamPath(a.id, "intensity"), 0, 0));
    ok(e.addKeyframe(id, effectParamPath(a.id, "intensity"), 20, 2, { type: "ease-in" }));
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    expect(loaded.clips[id].effects).toEqual(e.timeline.clips[id].effects);
    expect(loaded.clips[id].animation).toEqual(e.timeline.clips[id].animation);
    for (const f of [0, 7, 20, 40]) expect(layer(loaded, id, f).effects).toEqual(layer(e.timeline, id, f).effects);
  });
  it("rejects unknown effect types, duplicate ids, and keyframes pointing at missing effects/params", () => {
    const e = project();
    const id = addRect(e);
    const a = ok(e.addEffect(id, "blur")).effect;
    ok(e.addKeyframe(id, effectParamPath(a.id, "radius"), 0, 4));
    const base = () => JSON.parse(serializeTimeline(e.timeline));
    const bad: [string, (p: any) => void][] = [
      ["unknown type", (p) => (p.timeline.clips[id].effects[0].type = "lens-flare")],
      ["duplicate id", (p) => p.timeline.clips[id].effects.push({ ...p.timeline.clips[id].effects[0] })],
      ["track to missing effect", (p) => (p.timeline.clips[id].animation.tracks[effectParamPath("fx-999", "radius")] = p.timeline.clips[id].animation.tracks[effectParamPath(a.id, "radius")])],
      ["track to missing param", (p) => (p.timeline.clips[id].animation.tracks[effectParamPath(a.id, "nope")] = p.timeline.clips[id].animation.tracks[effectParamPath(a.id, "radius")])],
    ];
    for (const [name, mutate] of bad) {
      const p = base();
      mutate(p);
      expect(() => deserializeTimeline(JSON.stringify(p)), name).toThrow(ProjectFormatError);
    }
    // out-of-range params are clamped, not rejected
    const p = base();
    p.timeline.clips[id].effects[0].params.radius = 1e9;
    expect(deserializeTimeline(JSON.stringify(p)).clips[id].effects![0].params.radius).toBe(200);
  });
  it("normalizeEffect fills missing params with defaults", () => {
    expect(normalizeEffect({ id: "fx-1", type: "sharpen", params: {} })).toEqual({ id: "fx-1", type: "sharpen", params: { amount: 0.6, radius: 2 }, enabled: true });
  });
});

describe("duplicate / split keep effects", () => {
  it("both copies render the same stack", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addEffect(id, "saturation", { amount: -1 }));
    const dup = ok(e.duplicateClipsAsLayers([id]));
    expect(layer(e.timeline, dup.clips[0].id).effects).toEqual(layer(e.timeline, id).effects);
    const split = ok(e.splitClip(id, 60));
    expect(layer(e.timeline, split.right.id, 70).effects).toEqual(layer(e.timeline, split.left.id, 10).effects);
  });
});

// ---- integration: every layer kind uses the same isolated effect path -------------

/** 2D context fake with REAL get/putImageData over a byte buffer (records calls). */
function pixelCtx(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  const calls: { op: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, shadowColor: "transparent", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: "low", font: "", textAlign: "start", textBaseline: "alphabetic", lineCap: "butt", lineJoin: "miter", miterLimit: 10 };
  const canvas = { width: w, height: h };
  const proxy = new Proxy(
    {},
    {
      has: (_t, p) => p in state || p === "canvas",
      get(_t, p: string) {
        if (p === "canvas") return canvas;
        if (p in state) return state[p];
        if (p === "measureText") return (t: string) => ({ width: t.length * 10 });
        if (p === "getImageData")
          return (x: number, y: number, rw: number, rh: number) => {
            calls.push({ op: p, args: [x, y, rw, rh] });
            return { data: new Uint8ClampedArray(rw * rh * 4).fill(200), width: rw, height: rh };
          };
        return (...args: unknown[]) => calls.push({ op: p, args });
      },
      set(_t, p: string, v) {
        state[p] = v;
        return true;
      },
    },
  );
  return { ctx: proxy as unknown as Ctx2D, calls, data };
}

describe("effects on every layer kind (video, image, transparent PNG, bg-removed, text, shape, SVG)", () => {
  it("each kind goes through the same isolate -> process -> composite path, region = bounds + spill", () => {
    const e = project();
    const add = (kind: "video" | "image" | "overlay", sourceId: string) => {
      const t = e.addTrack(kind, sourceId);
      if (!t.ok) throw t.error;
      const content = kind === "image" ? { kind, source: { sourceId }, durationFrames: 30 } : { kind, source: { sourceId }, sourceInFrame: 0, sourceOutFrame: 30 };
      return ok(e.insertClip(t.track.id, content as never, 0, { fit: "none", transform: { scaleX: 0.25, scaleY: 0.25 } })).clip.id;
    };
    const ids = {
      video: add("video", "v"),
      image: add("image", "v"),
      png: add("image", "png"),
      bgRemoved: add("overlay", "cut"),
      text: ok(e.addTextLayer({ text: "FX", atFrame: 0, durationFrames: 30, style: normalizeTextStyle({}) })).clip.id,
      shape: addRect(e),
      svg: ok(e.addGraphicLayer({ graphic: { svg: svgSpecFromMarkup(GRAPHICS_LIBRARY[0].markup, 100) }, atFrame: 0, durationFrames: 30 })).clip.id,
    };
    e.setClipVisual(ids.bgRemoved, { matte: { sourceId: "matte", invert: false } });
    for (const id of Object.values(ids)) ok(e.addEffect(id, "blur", { radius: 10 }));
    const f = resolveFrame(e.timeline, 0, ctx());
    const fake = { width: 100, height: 100 } as unknown as CanvasImageSource;
    for (const [kind, id] of Object.entries(ids)) {
      const l = f.layers.find((x) => x.clipId === id)!;
      expect(l.effects.map((x) => x.type), kind).toEqual(["blur"]);
      const main = pixelCtx(1920, 1080);
      const scratch = pixelCtx(1920, 1080);
      drawResolvedFrame(main.ctx, { ...f, layers: [l] }, new Map([[id, { image: fake, matte: kind === "bgRemoved" ? fake : undefined }]]), { renderScale: 1, smoothing: "high", getScratch: () => scratch.ctx });
      const get = scratch.calls.find((c) => c.op === "getImageData")!;
      const put = scratch.calls.find((c) => c.op === "putImageData")!;
      expect(get, kind).toBeDefined();
      expect(put, kind).toBeDefined();
      const [x, y] = get.args as number[];
      const spill = Math.ceil(10 * 1.5) + 1;
      expect(x).toBe(Math.max(0, Math.floor(l.bounds.x) - spill));
      expect(y).toBe(Math.max(0, Math.floor(l.bounds.y) - spill));
      expect(main.calls.filter((c) => c.op === "drawImage").length, kind).toBe(1); // composited once from scratch
    }
  });
});

describe("registry", () => {
  it("defines exactly the 12 required effects with sane param ranges", () => {
    expect(EFFECT_DEFINITIONS.map((d) => d.type).sort()).toEqual(["blur", "brightness", "contrast", "exposure", "glow", "grain", "opacity", "saturation", "sharpen", "temperature", "tint", "vignette"]);
    for (const d of EFFECT_DEFINITIONS) for (const p of d.params) expect(p.default >= p.min && p.default <= p.max, `${d.type}.${p.key}`).toBe(true);
  });
});

describe("edge handling", () => {
  it("blurring a full-frame opaque layer does NOT fade the frame border to transparent", () => {
    const w = 30;
    const out = run(img(w, w, () => [0.4, 0.6, 0.8, 1]), w, w, [fx("blur", { radius: 12 })]);
    close(px(out, w, 0, 0), [0.4, 0.6, 0.8, 1], 4); // corner keeps full alpha and color
    close(px(out, w, 15, 0), [0.4, 0.6, 0.8, 1], 4);
  });
});
