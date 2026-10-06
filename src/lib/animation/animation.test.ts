import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import type { TimelineModel } from "../timeline/model";
import { deserializeTimeline, serializeTimeline, ProjectFormatError } from "../timeline/serialize";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { resolveClipLayer, resolveFrame, type ResolvedLayer } from "../composition/resolve";
import { applyToPoint } from "../composition/matrix";
import { fakeContext } from "../composition/test-helpers";
import { cubicBezier, easingFn, normalizeEasing, registerEasing } from "./easing";
import { evaluateTrack, type KeyframeTrack } from "./keyframes";
import { applyAnimation, ANIMATABLE_PROPERTIES, valueAt } from "./properties";

/**
 * PHASE 8 — KEYFRAME ENGINE acceptance suite. Animation is asserted through
 * resolveFrame — the exact function the preview AND final renderers use — so
 * these test what gets drawn at each frame, not just stored numbers.
 */

const ctx = () => fakeContext({ v: { width: 1920, height: 1080 } });
const X = "visual.transform.x";
const Y = "visual.transform.y";
const SX = "visual.transform.scaleX";
const SY = "visual.transform.scaleY";
const ROT = "visual.transform.rotation";
const OP = "visual.opacity";

function project() {
  return new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
}
function addRect(e: TimelineEngine, atFrame = 0, durationFrames = 120) {
  const r = e.addGraphicLayer({ graphic: { shape: normalizeShapeSpec({ type: "rect", width: 200, height: 100 }) }, atFrame, durationFrames });
  if (!r.ok) throw r.error;
  return r.clip.id;
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw (r as unknown as { error: Error }).error;
  return r as Extract<T, { ok: true }>;
}
const layer = (tl: TimelineModel, id: string, frame: number): ResolvedLayer => resolveFrame(tl, frame, ctx()).layers.find((l) => l.clipId === id)!;
const center = (l: ResolvedLayer) => applyToPoint(l.matrix, { x: l.width / 2, y: l.height / 2 });

describe("interpolation", () => {
  it("linear / presets / hold hit their endpoints; eases have the right shape", () => {
    for (const type of ["linear", "ease-in", "ease-out", "ease-in-out", "hold"] as const) {
      const f = easingFn({ type });
      expect(f(0)).toBeCloseTo(0, 6);
      expect(f(1)).toBeCloseTo(1, 6);
    }
    expect(easingFn({ type: "linear" })(0.3)).toBeCloseTo(0.3, 9);
    expect(easingFn({ type: "ease-in" })(0.3)).toBeLessThan(0.3); // slow start
    expect(easingFn({ type: "ease-out" })(0.3)).toBeGreaterThan(0.3); // fast start
    expect(easingFn({ type: "ease-in-out" })(0.5)).toBeCloseTo(0.5, 5); // symmetric
    expect(easingFn({ type: "hold" })(0.99)).toBe(0);
  });
  it("cubic-bezier solver matches known CSS values and is monotonic", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1); // CSS "ease"
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = easingFn({ type: "ease-in-out" })(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
  it("is extensible: a registered easing type is used by evaluation (e.g. a future spring)", () => {
    registerEasing("test-square", () => (t) => t * t);
    const track = { keyframes: [{ id: "a", frame: 0, value: 0, easing: { type: "test-square" } as never }, { id: "b", frame: 10, value: 100, easing: { type: "linear" } as const }] };
    expect(evaluateTrack(track, 5)).toBeCloseTo(25, 9);
  });
  it("validates easing from untrusted data", () => {
    expect(normalizeEasing({ type: "ease-in" })).toEqual({ type: "ease-in" });
    expect(normalizeEasing({ type: "cubic-bezier", x1: 0.1, y1: 2, x2: 0.9, y2: -1 })).toEqual({ type: "cubic-bezier", x1: 0.1, y1: 2, x2: 0.9, y2: -1 });
    expect(normalizeEasing({ type: "cubic-bezier", x1: 1.5, y1: 0, x2: 0.5, y2: 1 })).toBeNull(); // x must be in [0,1]
    expect(normalizeEasing({ type: "bounce" })).toBeNull();
  });
});

describe("track evaluation", () => {
  const t: KeyframeTrack = { keyframes: [{ id: "a", frame: 10, value: 100, easing: { type: "linear" } }, { id: "b", frame: 20, value: 300, easing: { type: "hold" } }, { id: "c", frame: 30, value: 0, easing: { type: "linear" } }] };
  it("holds before the first and after the last key, interpolates between, honors the outgoing easing", () => {
    expect(evaluateTrack(t, 0)).toBe(100);
    expect(evaluateTrack(t, 15)).toBe(200);
    expect(evaluateTrack(t, 25)).toBe(300); // hold segment
    expect(evaluateTrack(t, 30)).toBe(0);
    expect(evaluateTrack(t, 999)).toBe(0);
  });
});

describe("position / scale / rotation / opacity / crop animation", () => {
  it("position", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 200));
    ok(e.addKeyframe(id, X, 60, 1700));
    expect(center(layer(e.timeline, id, 0)).x).toBeCloseTo(200, 6);
    expect(center(layer(e.timeline, id, 30)).x).toBeCloseTo(950, 6);
    expect(center(layer(e.timeline, id, 60)).x).toBeCloseTo(1700, 6);
    expect(center(layer(e.timeline, id, 100)).x).toBeCloseTo(1700, 6); // holds after last key
  });
  it("scale (and scale never goes non-positive even if keyed to 0)", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, SX, 0, 1));
    ok(e.addKeyframe(id, SX, 30, 3));
    ok(e.addKeyframe(id, SY, 0, 1));
    ok(e.addKeyframe(id, SY, 30, 0));
    expect(layer(e.timeline, id, 15).bounds.width).toBeCloseTo(400, 6);
    expect(layer(e.timeline, id, 30).visual.transform.scaleY).toBeGreaterThan(0);
  });
  it("rotation (unwrapped: 0 -> 720 spins twice)", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, ROT, 0, 0));
    ok(e.addKeyframe(id, ROT, 80, 720));
    expect(layer(e.timeline, id, 10).visual.transform.rotation).toBeCloseTo(90, 6);
    expect(layer(e.timeline, id, 50).visual.transform.rotation).toBeCloseTo(450, 6);
  });
  it("opacity (clamped to [0,1]; fully transparent frames are culled)", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, OP, 0, 0));
    ok(e.addKeyframe(id, OP, 10, 1));
    expect(resolveFrame(e.timeline, 0, ctx()).layers).toHaveLength(0);
    expect(layer(e.timeline, id, 5).opacity).toBeCloseTo(0.5, 6);
    ok(e.updateKeyframe(id, OP, e.timeline.clips[id].animation!.tracks[OP].keyframes[1].id, { value: 5 }));
    expect(layer(e.timeline, id, 10).opacity).toBe(1);
  });
  it("crop (each side; stays normalized)", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, "visual.crop.left", 0, 0));
    ok(e.addKeyframe(id, "visual.crop.left", 20, 0.5));
    ok(e.addKeyframe(id, "visual.crop.right", 0, 0));
    ok(e.addKeyframe(id, "visual.crop.right", 20, 0.9));
    const mid = layer(e.timeline, id, 10);
    expect(mid.visual.crop.left).toBeCloseTo(0.25, 6);
    expect(mid.crop.x).toBeCloseTo(50, 6);
    const end = layer(e.timeline, id, 20).visual.crop;
    expect(end.left + end.right).toBeLessThanOrEqual(0.99 + 1e-9); // never crops everything away
  });
});

describe("multiple properties / multiple objects / every layer kind", () => {
  it("several properties on one clip, several clips, one engine for text, shapes and SVG", () => {
    const e = project();
    const shape = addRect(e);
    const text = ok(e.addTextLayer({ text: "Hello", atFrame: 0, durationFrames: 120 })).clip.id;
    for (const id of [shape, text]) {
      ok(e.addKeyframe(id, X, 0, 100));
      ok(e.addKeyframe(id, X, 40, 500));
      ok(e.addKeyframe(id, ROT, 0, 0));
      ok(e.addKeyframe(id, ROT, 40, 90, { type: "ease-in-out" }));
      ok(e.addKeyframe(id, OP, 0, 1));
      ok(e.addKeyframe(id, OP, 40, 0.5));
    }
    for (const id of [shape, text]) {
      const l = layer(e.timeline, id, 20);
      expect(l.visual.transform.x).toBeCloseTo(300, 6);
      expect(l.visual.transform.rotation).toBeCloseTo(45, 4); // ease-in-out is symmetric
      expect(l.opacity).toBeCloseTo(0.75, 6);
    }
  });
});

describe("scrubbing and playback", () => {
  it("evaluation is a pure function of the frame: random-order scrubbing equals sequential playback", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 0, { type: "ease-out" }));
    ok(e.addKeyframe(id, X, 90, 900));
    const sequential = Array.from({ length: 100 }, (_, f) => layer(e.timeline, id, f).visual.transform.x);
    const order = [...sequential.keys()].sort(() => Math.random() - 0.5);
    for (const f of order) expect(layer(e.timeline, id, f).visual.transform.x).toBe(sequential[f]);
    // playback: monotonic for an ease-out move, reaches the end and holds
    for (let f = 1; f < 100; f++) expect(sequential[f]).toBeGreaterThanOrEqual(sequential[f - 1]);
    expect(sequential[90]).toBe(900);
    expect(sequential[99]).toBe(900);
  });
  it("keyframes are clip-relative: moving the clip moves the animation", () => {
    const e = project();
    const id = addRect(e, 0, 120);
    ok(e.addKeyframe(id, X, 0, 0));
    ok(e.addKeyframe(id, X, 30, 300));
    ok(e.moveClip(id, 100));
    expect(layer(e.timeline, id, 115).visual.transform.x).toBeCloseTo(150, 6);
  });
});

describe("editing semantics", () => {
  it("auto-key: editing an animated property at the playhead writes a keyframe; static properties change the base", () => {
    const e = project();
    const id = addRect(e);
    ok(e.setPropertyAnimated(id, X, true, 0)); // stopwatch on at frame 0
    ok(e.setClipVisualsAtFrame({ [id]: { transform: { x: 1500, y: 200 } } }, 45));
    const c = e.timeline.clips[id];
    expect(c.animation!.tracks[X].keyframes.map((k) => [k.frame, k.value])).toEqual([[0, 960], [45, 1500]]);
    expect(c.animation!.tracks[Y]).toBeUndefined();
    expect(c.visual!.transform.y).toBe(200); // static: base changed
    expect(c.visual!.transform.x).toBe(960); // animated: base untouched
    e.undo();
    expect(e.timeline.clips[id].animation!.tracks[X].keyframes).toHaveLength(1); // one undo step
  });
  it("add keyframe defaults to the current value (no jump); remove last / stopwatch off keep the value at the playhead", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 100));
    ok(e.addKeyframe(id, X, 60, 700));
    ok(e.addKeyframe(id, X, 30)); // value defaults to the evaluated 400
    expect(e.timeline.clips[id].animation!.tracks[X].keyframes.map((k) => k.value)).toEqual([100, 400, 700]);
    ok(e.setPropertyAnimated(id, X, false, 30));
    expect(e.timeline.clips[id].animation).toBeUndefined();
    expect(e.timeline.clips[id].visual!.transform.x).toBe(400);
    ok(e.addKeyframe(id, ROT, 10, 33));
    ok(e.removeKeyframe(id, ROT, e.timeline.clips[id].animation!.tracks[ROT].keyframes[0].id));
    expect(e.timeline.clips[id].visual!.transform.rotation).toBe(33);
  });
  it("move keyframe; collisions are rejected without changing anything", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 0));
    ok(e.addKeyframe(id, X, 30, 300));
    const [a, b] = e.timeline.clips[id].animation!.tracks[X].keyframes;
    ok(e.moveKeyframe(id, X, b.id, 60));
    expect(layer(e.timeline, id, 30).visual.transform.x).toBeCloseTo(150, 6);
    const before = e.timeline;
    const r = e.moveKeyframe(id, X, a.id, 60);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.reason).toBe("keyframe-conflict");
    expect(e.timeline).toBe(before);
  });
  it("trim start keeps keyframes at the same moment; split keeps both halves identical; duplicate offsets animated position", () => {
    const e = project();
    const id = addRect(e, 0, 120);
    ok(e.addKeyframe(id, X, 0, 0, { type: "ease-in-out" }));
    ok(e.addKeyframe(id, X, 100, 1000));
    const at = (f: number, cid = id) => layer(e.timeline, cid, f).visual.transform.x;
    const original = [20, 50, 70, 90].map((f) => at(f));
    ok(e.trimClip(id, "start", 20));
    expect([20, 50, 70, 90].map((f) => at(f))).toEqual(original);
    const split = ok(e.splitClip(id, 60));
    expect([at(20, split.left.id), at(50, split.left.id), at(70, split.right.id), at(90, split.right.id)]).toEqual(original);
    const dup = ok(e.duplicateClipsAsLayers([split.right.id], { x: 24, y: 24 }));
    expect(at(70, dup.clips[0].id) - at(70, split.right.id)).toBeCloseTo(24, 6);
  });
  it("locked tracks reject keyframe edits", () => {
    const e = project();
    const id = addRect(e);
    e.setTrackLocked(e.timeline.clips[id].trackId, true);
    expect(e.addKeyframe(id, X, 0, 1).ok).toBe(false);
    expect(e.addKeyframe(id, "visual.nope", 0, 1).ok).toBe(false);
  });
});

describe("save / reload", () => {
  it("keyframes (values, frames, easings incl. Bézier) round-trip and render identically at every frame", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 100, { type: "cubic-bezier", x1: 0.2, y1: 1.4, x2: 0.6, y2: -0.2 }));
    ok(e.addKeyframe(id, X, 60, 1600));
    ok(e.addKeyframe(id, OP, 0, 0.2, { type: "hold" }));
    ok(e.addKeyframe(id, OP, 30, 1));
    ok(e.addKeyframe(id, "visual.crop.top", 0, 0));
    ok(e.addKeyframe(id, "visual.crop.top", 60, 0.4));
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    expect(loaded.clips[id].animation).toEqual(e.timeline.clips[id].animation);
    for (let f = 0; f < 120; f += 7) {
      const a = layer(e.timeline, id, f);
      const b = layer(loaded, id, f);
      expect(b.matrix).toEqual(a.matrix);
      expect(b.opacity).toBe(a.opacity);
      expect(b.crop).toEqual(a.crop);
    }
  });
  it("rejects invalid animation in project files", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 1));
    const base = () => JSON.parse(serializeTimeline(e.timeline));
    const bad: [string, (p: any) => void][] = [
      ["unknown property", (p) => (p.timeline.clips[id].animation.tracks["visual.matte"] = p.timeline.clips[id].animation.tracks[X])],
      ["NaN value", (p) => (p.timeline.clips[id].animation.tracks[X].keyframes[0].value = null)],
      ["fractional frame", (p) => (p.timeline.clips[id].animation.tracks[X].keyframes[0].frame = 1.5)],
      ["bad easing", (p) => (p.timeline.clips[id].animation.tracks[X].keyframes[0].easing = { type: "bounce" })],
      ["duplicate frame", (p) => p.timeline.clips[id].animation.tracks[X].keyframes.push({ ...p.timeline.clips[id].animation.tracks[X].keyframes[0], id: "dup" })],
      ["empty track", (p) => (p.timeline.clips[id].animation.tracks[X].keyframes = [])],
    ];
    for (const [name, mutate] of bad) {
      const p = base();
      mutate(p);
      expect(() => deserializeTimeline(JSON.stringify(p)), name).toThrow(ProjectFormatError);
    }
  });
});

describe("undo / redo", () => {
  it("every keyframe operation is one step and replays to the identical timeline", () => {
    const e = project();
    const id = addRect(e);
    const ops: (() => void)[] = [
      () => ok(e.setPropertyAnimated(id, X, true, 0)),
      () => ok(e.addKeyframe(id, X, 40, 800)),
      () => ok(e.addKeyframe(id, ROT, 0, 0)),
      () => ok(e.addKeyframe(id, ROT, 40, 180)),
      () => ok(e.updateKeyframe(id, X, e.timeline.clips[id].animation!.tracks[X].keyframes[1].id, { easing: { type: "ease-out" } })),
      () => ok(e.moveKeyframe(id, ROT, e.timeline.clips[id].animation!.tracks[ROT].keyframes[1].id, 50)),
      () => ok(e.setClipVisualsAtFrame({ [id]: { transform: { x: 1200 } } }, 20)),
      () => ok(e.removeKeyframe(id, ROT, e.timeline.clips[id].animation!.tracks[ROT].keyframes[0].id)),
    ];
    const snaps = [e.timeline];
    for (const op of ops) {
      op();
      snaps.push(e.timeline);
    }
    for (let i = ops.length - 1; i >= 0; i--) {
      e.undo();
      expect(e.timeline).toBe(snaps[i]);
    }
    for (let i = 1; i <= ops.length; i++) {
      e.redo();
      expect(e.timeline).toBe(snaps[i]);
    }
  });
});

describe("static objects behave exactly as before", () => {
  it("applyAnimation returns the SAME clip object when there is no animation", () => {
    const e = project();
    const id = addRect(e);
    const clip = e.timeline.clips[id];
    expect(applyAnimation(clip, 10, e.timeline.composition)).toBe(clip);
  });
  it("a static clip resolves identically at every frame, and edits change the base exactly like setClipVisuals", () => {
    const e = project();
    const id = addRect(e);
    e.setClipVisual(id, { transform: { x: 300, rotation: 12 }, opacity: 0.6, crop: { left: 0.1 } });
    const first = layer(e.timeline, id, 0);
    for (const f of [1, 33, 119]) expect(layer(e.timeline, id, f)).toEqual(first);
    const a = e.timeline;
    ok(e.setClipVisualsAtFrame({ [id]: { transform: { x: 777 } } }, 50));
    const viaAtFrame = e.timeline.clips[id];
    e.undo();
    ok(e.setClipVisuals({ [id]: { transform: { x: 777 } } }));
    expect(e.timeline.clips[id]).toEqual(viaAtFrame);
    expect(a.clips[id].animation).toBeUndefined();
  });
  it("valueAt falls back to the static value, and every registered property round-trips get/set", () => {
    const e = project();
    const id = addRect(e);
    const clip = e.timeline.clips[id];
    for (const p of ANIMATABLE_PROPERTIES) {
      const v = valueAt(clip, p.path, 0, e.timeline.composition);
      expect(Number.isFinite(v)).toBe(true);
      expect(p.get(p.set(clip, v, e.timeline.composition), e.timeline.composition)).toBeCloseTo(v, 9);
    }
  });
  it("resolveClipLayer (inspector) shows the evaluated value at the playhead", () => {
    const e = project();
    const id = addRect(e);
    ok(e.addKeyframe(id, X, 0, 0));
    ok(e.addKeyframe(id, X, 10, 100));
    expect(resolveClipLayer(e.timeline, id, 5, ctx())!.visual.transform.x).toBeCloseTo(50, 6);
  });
});
