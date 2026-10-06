import { describe, expect, it } from "vitest";
import { createTimeline, timelineDurationFrames, type TimelineModel } from "../timeline/model";
import { addTrack, addTransition, deleteClip, insertClip, moveClip, removeTransition, setTrackLocked, splitClip, trimClip, updateTransition, reconcileTransitions } from "../timeline/operations";
import { TimelineEngine } from "../timeline/engine";
import { TimelineEditError } from "../timeline/errors";
import { deserializeTimeline, ProjectFormatError, serializeTimeline } from "../timeline/serialize";
import { resolveFrame, type ResolvedFrame } from "../composition/resolve";
import { hitTest } from "../composition/viewport";
import { drawResolvedFrame, type Ctx2D } from "../composition/draw";
import { fakeContext } from "../composition/test-helpers";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { getTransitionDefinition, listTransitionDefinitions, registerTransition, type TransitionDirection } from "./registry";
import { activeTransitionAt, maxTransitionDuration, transitionsByTrack, transitionWindow, type Transition } from "./model";
import { SoftwarePainter, solidSurface, createSurface, type SoftwareSurface } from "./software-painter";

const FPS = 30;
const SOURCES = { a: { width: 100, height: 100 }, b: { width: 100, height: 100 }, c: { width: 100, height: 100 }, img1: { width: 50, height: 50 }, img2: { width: 50, height: 50 } };

/** Video track: A [0,60) src 0..60 of 100 (has handles), B [60,120) src 10..70 of 100, C [120,180) src 0..60 with NO known handles. */
function scene() {
  let tl = createTimeline(FPS, { width: 100, height: 100, background: "#000000" });
  const v = addTrack(tl, "video", "V1");
  tl = v.timeline;
  const a = insertClip(tl, v.track.id, { kind: "video", source: { sourceId: "a", sourceDurationFrames: 100 }, sourceInFrame: 0, sourceOutFrame: 60 }, 0);
  tl = a.timeline;
  const b = insertClip(tl, v.track.id, { kind: "video", source: { sourceId: "b", sourceDurationFrames: 100 }, sourceInFrame: 10, sourceOutFrame: 70 }, 60);
  tl = b.timeline;
  const c = insertClip(tl, v.track.id, { kind: "video", source: { sourceId: "c" }, sourceInFrame: 0, sourceOutFrame: 60 }, 120);
  tl = c.timeline;
  return { tl, track: v.track.id, A: a.clip.id, B: b.clip.id, C: c.clip.id };
}

const ctx = fakeContext(SOURCES);
const tr = (tl: TimelineModel, id: string) => tl.transitions![id];
const layersAt = (tl: TimelineModel, f: number) => resolveFrame(tl, f, ctx).layers;

function expectEditError(fn: () => unknown, reason: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TimelineEditError);
    expect((e as TimelineEditError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ${reason}`);
}

// --- pixel helpers ---------------------------------------------------------
const RED = (w = 8, h = 8) => solidSurface(w, h, 1, 0, 0);
const BLUE = (w = 8, h = 8) => solidSurface(w, h, 0, 0, 1);

function paint(type: string, progress: number, opts: { from?: SoftwareSurface | null; to?: SoftwareSurface | null; direction?: TransitionDirection; params?: Record<string, number | string>; paired?: boolean; renderScale?: number; w?: number; h?: number; seed?: number } = {}) {
  const w = opts.w ?? 8;
  const h = opts.h ?? 8;
  const from = opts.from === undefined ? RED(w, h) : opts.from;
  const to = opts.to === undefined ? BLUE(w, h) : opts.to;
  const p = new SoftwarePainter(w, h, from, to, opts.renderScale ?? 1);
  const def = getTransitionDefinition(type)!;
  def.render(p, { progress, params: { ...Object.fromEntries(def.params.map((d) => [d.key, d.default])), ...opts.params }, direction: opts.direction ?? def.directions?.[0], paired: opts.paired ?? (from !== null && to !== null), seed: opts.seed ?? 7 });
  return p;
}
const near = (actual: number[], expected: number[], eps = 1e-6) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], -Math.log10(eps)));

describe("transition registry & compositors (exact pixels, software painter)", () => {
  it("registers exactly the 8 required types", () => {
    expect(listTransitionDefinitions().map((d) => d.type).sort()).toEqual(["cross-dissolve", "cut", "dissolve", "fade", "push", "slide", "wipe", "zoom"]);
  });

  it("every type, every direction: progress 0 is exactly the outgoing clip and progress 1 exactly the incoming one", () => {
    for (const def of listTransitionDefinitions()) {
      for (const direction of def.directions ?? [undefined]) {
        const start = paint(def.type, 0, { direction });
        const end = paint(def.type, 1, { direction });
        for (const [x, y] of [[0, 0], [7, 7], [3, 4], [7, 0]]) {
          near(start.pixel(x, y), [1, 0, 0, 1]);
          near(end.pixel(x, y), [0, 0, 1, 1]);
        }
      }
    }
  });

  it("cut switches at the midpoint", () => {
    near(paint("cut", 0.49).pixel(3, 3), [1, 0, 0, 1]);
    near(paint("cut", 0.5).pixel(3, 3), [0, 0, 1, 1]);
  });

  it("cross dissolve is the exact linear mix A·(1-p)+B·p — and fades a transparent partner without a dip", () => {
    near(paint("cross-dissolve", 0.5).pixel(2, 2), [0.5, 0, 0.5, 1]);
    near(paint("cross-dissolve", 0.25).pixel(2, 2), [0.75, 0, 0.25, 1]);
    const toTransparent = paint("cross-dissolve", 0.5, { to: createSurface(8, 8) });
    near(toTransparent.pixel(2, 2), [1, 0, 0, 0.5]);
  });

  it("fade dips through the color between clips, only where the layer has content (respects a PiP's shape)", () => {
    near(paint("fade", 0.25).pixel(1, 1), [0.5, 0, 0, 1]); // halfway to black
    near(paint("fade", 0.5).pixel(1, 1), [0, 0, 0, 1]); // fully black at the cut
    near(paint("fade", 0.75, { params: { color: "#ffffff" } }).pixel(1, 1), [0.5, 0.5, 1, 1]); // white dip, coming back to blue
    const pip = createSurface(8, 8);
    pip.data.set([1, 0, 0, 1], 0); // only pixel (0,0) has content
    const p = paint("fade", 0.25, { from: pip, to: createSurface(8, 8) });
    expect(p.pixel(5, 5)[3]).toBe(0); // the dip never paints outside the layer
    near(p.pixel(0, 0), [0.5, 0, 0, 1]);
  });

  it("fade at a boundary fades the clip itself (to transparency)", () => {
    near(paint("fade", 0.3, { from: null, paired: false }).pixel(4, 4), [0, 0, 1, 0.3]);
    near(paint("fade", 0.3, { to: null, paired: false }).pixel(4, 4), [1, 0, 0, 0.7]);
  });

  it("dissolve: ~p of the pixels switch, deterministically, on a composition-anchored lattice", () => {
    const p = paint("dissolve", 0.5, { w: 64, h: 64, params: { grain: 1 } });
    let blue = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (p.pixel(x, y)[2] === 1) blue++;
    expect(blue / 4096).toBeGreaterThan(0.45);
    expect(blue / 4096).toBeLessThan(0.55);
    const again = paint("dissolve", 0.5, { w: 64, h: 64, params: { grain: 1 } });
    expect(Array.from(again.out.data)).toEqual(Array.from(p.out.data));
    const otherSeed = paint("dissolve", 0.5, { w: 64, h: 64, params: { grain: 1 }, seed: 99 });
    expect(Array.from(otherSeed.out.data)).not.toEqual(Array.from(p.out.data));
    // Monotonic: a pixel that has switched stays switched as progress grows.
    const later = paint("dissolve", 0.7, { w: 64, h: 64, params: { grain: 1 } });
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (p.pixel(x, y)[2] === 1) expect(later.pixel(x, y)[2]).toBe(1);
    // Half-resolution preview shows the same pattern as the full export.
    const full = paint("dissolve", 0.5, { w: 64, h: 64, params: { grain: 2 } });
    const half = paint("dissolve", 0.5, { w: 32, h: 32, params: { grain: 2 }, renderScale: 0.5 });
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) expect(half.pixel(x, y)).toEqual(full.pixel(2 * x, 2 * y));
  });

  it("slide: the incoming clip moves in over the stationary outgoing one", () => {
    const p = paint("slide", 0.5, { direction: "right" });
    for (let x = 0; x < 4; x++) near(p.pixel(x, 3), [0, 0, 1, 1]); // B entered from the left
    for (let x = 4; x < 8; x++) near(p.pixel(x, 3), [1, 0, 0, 1]); // A hasn't moved
    const up = paint("slide", 0.25, { direction: "up" });
    near(up.pixel(3, 7), [0, 0, 1, 1]); // B entering from the bottom
    near(up.pixel(3, 5), [1, 0, 0, 1]);
    // Boundary out: the clip itself slides away.
    const out = paint("slide", 0.5, { direction: "left", to: null, paired: false });
    expect(out.pixel(5, 3)[3]).toBe(0);
    near(out.pixel(1, 3), [1, 0, 0, 1]);
  });

  it("push: both move together, the outgoing one leaving as the incoming one enters", () => {
    const a = solidSurface(8, 8, 1, 0, 0);
    a.data.set([0, 1, 0, 1], (3 * 8 + 0) * 4); // mark A's left-most pixel on row 3 green
    const p = paint("push", 0.25, { direction: "left", from: a });
    near(p.pixel(0, 3), [1, 0, 0, 1]); // A's marked column (x=0) has been pushed off-frame by 2px
    for (let x = 0; x < 6; x++) expect(p.pixel(x, 3)[0]).toBe(1);
    for (let x = 6; x < 8; x++) near(p.pixel(x, 3), [0, 0, 1, 1]);
  });

  it("wipe: a moving edge reveals the incoming clip, in each direction", () => {
    const r = paint("wipe", 0.5, { direction: "right", params: { softness: 0 } });
    for (let x = 0; x < 4; x++) near(r.pixel(x, 0), [0, 0, 1, 1]);
    for (let x = 4; x < 8; x++) near(r.pixel(x, 0), [1, 0, 0, 1]);
    const l = paint("wipe", 0.5, { direction: "left", params: { softness: 0 } });
    for (let x = 4; x < 8; x++) near(l.pixel(x, 0), [0, 0, 1, 1]);
    for (let x = 0; x < 4; x++) near(l.pixel(x, 0), [1, 0, 0, 1]);
    const d = paint("wipe", 0.5, { direction: "down", params: { softness: 0 } });
    near(d.pixel(0, 1), [0, 0, 1, 1]);
    near(d.pixel(0, 6), [1, 0, 0, 1]);
    // Soft edge: a gradient between, always fully opaque (A under B).
    const soft = paint("wipe", 0.5, { direction: "right", params: { softness: 0.5 }, w: 32, h: 1 });
    const blues = Array.from({ length: 32 }, (_, x) => soft.pixel(x, 0)[2]);
    expect(blues[0]).toBeCloseTo(1, 5);
    expect(blues[31]).toBeCloseTo(0, 5);
    for (let x = 1; x < 32; x++) expect(blues[x]).toBeLessThanOrEqual(blues[x - 1] + 1e-9);
    for (let x = 0; x < 32; x++) expect(soft.pixel(x, 0)[3]).toBeCloseTo(1, 6);
  });

  it("zoom: A grows away and B grows into place; 'out' reverses it", () => {
    const p = paint("zoom", 0.5, { direction: "in", params: { amount: 2 }, w: 16, h: 16 });
    near(p.pixel(8, 8), [0.5, 0, 0.5, 1]); // center: both halves of the cross-zoom
    near(p.pixel(0, 0), [1, 0, 0, 0.5]); // corner: only A (enlarged) reaches it; B is shrunk
    const o = paint("zoom", 0.5, { direction: "out", params: { amount: 2 }, w: 16, h: 16 });
    near(o.pixel(0, 0), [0, 0, 1, 0.5]); // reversed: B is the enlarged one
  });

  it("is extensible: a registered custom mask transition renders through the same resolver/draw path", () => {
    registerTransition({
      type: "test-luma-mask",
      label: "Test mask",
      description: "custom",
      params: [],
      defaultSeconds: 1,
      render(p, { progress }) {
        p.mixPixels((a, b, out, w, h) => {
          for (let i = 0; i < w * h; i++) {
            const src = (i % w) / w < progress ? b : a; // a left-to-right mask
            if (src) for (let c = 0; c < 4; c++) out[i * 4 + c] = src[i * 4 + c];
          }
        });
      },
    });
    const p = paint("test-luma-mask", 0.5);
    near(p.pixel(1, 1), [0, 0, 1, 1]);
    near(p.pixel(6, 1), [1, 0, 0, 1]);
    const { tl, A, B } = scene();
    const r = addTransition(tl, { fromClipId: A, toClipId: B, type: "test-luma-mask" });
    expect(layersAt(r.timeline, 60).map((l) => l.transition?.type)).toEqual(["test-luma-mask", "test-luma-mask"]);
  });
});

describe("transition model & operations", () => {
  it("adds a centered transition between adjacent clips with the type's default length", () => {
    const { tl, A, B, track } = scene();
    const { timeline, transition } = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve" });
    expect(transition).toMatchObject({ type: "cross-dissolve", trackId: track, fromClipId: A, toClipId: B, duration: 30, alignment: "center", enabled: true, easing: { type: "ease-in-out" } });
    expect(transitionWindow(timeline, transition)).toMatchObject({ start: 45, end: 75, cut: 60 });
    // Clip positions and the timeline length never change.
    expect(timeline.clips).toBe(tl.clips);
    expect(timelineDurationFrames(timeline)).toBe(180);
  });

  it("alignment: centered, ending at the cut, starting at the cut", () => {
    const { tl, A, B } = scene();
    const mk = (alignment: "center" | "end" | "start", duration: number) => transitionWindow(addTransition(tl, { fromClipId: A, toClipId: B, type: "fade", duration, alignment }).timeline, addTransition(tl, { fromClipId: A, toClipId: B, type: "fade", duration, alignment }).transition);
    expect(mk("center", 11)).toMatchObject({ start: 55, end: 66 });
    expect(mk("end", 10)).toMatchObject({ start: 50, end: 60 });
    expect(mk("start", 10)).toMatchObject({ start: 60, end: 70 });
  });

  it("different durations: clamps to what the clips can host", () => {
    const { tl, A, B } = scene();
    expect(addTransition(tl, { fromClipId: A, toClipId: B, type: "wipe", duration: 1 }).transition.duration).toBe(1);
    expect(addTransition(tl, { fromClipId: A, toClipId: B, type: "wipe", duration: 90 }).transition.duration).toBe(90);
    expect(addTransition(tl, { fromClipId: A, toClipId: B, type: "wipe", duration: 1000 }).transition.duration).toBe(120); // 60 + 60
    expect(addTransition(tl, { fromClipId: A, toClipId: B, type: "wipe", duration: 1000, alignment: "end" }).transition.duration).toBe(60);
  });

  it("rejects invalid placements with typed errors", () => {
    const { tl, A, B, C, track } = scene();
    expectEditError(() => addTransition(tl, { fromClipId: A, toClipId: C, type: "fade" }), "invalid-transition"); // not adjacent
    expectEditError(() => addTransition(tl, { fromClipId: A, toClipId: B, type: "spin" }), "invalid-transition"); // unknown type
    expectEditError(() => addTransition(tl, { fromClipId: null, toClipId: null, type: "fade" }), "invalid-transition");
    expectEditError(() => addTransition(tl, { fromClipId: "nope", toClipId: B, type: "fade" }), "clip-not-found");
    const once = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade" }).timeline;
    expectEditError(() => addTransition(once, { fromClipId: A, toClipId: null, type: "fade" }), "invalid-transition"); // A's end edge already used
    expectEditError(() => addTransition(once, { fromClipId: null, toClipId: B, type: "fade" }), "invalid-transition"); // B's start edge already used
    expectEditError(() => addTransition(setTrackLocked(tl, track, true), { fromClipId: A, toClipId: B, type: "fade" }), "track-locked");
    // Other track, audio
    let t2 = addTrack(tl, "audio", "Music").timeline;
    const aud = insertClip(t2, t2.trackIds[1], { kind: "audio", source: { sourceId: "m" }, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    t2 = aud.timeline;
    expectEditError(() => addTransition(t2, { fromClipId: null, toClipId: aud.clip.id, type: "fade" }), "kind-mismatch");
  });

  it("transitions at timeline boundaries: in at the very first frame, out at the very last", () => {
    const { tl, A, C } = scene();
    const tin = addTransition(tl, { fromClipId: null, toClipId: A, type: "fade", duration: 15 });
    const tout = addTransition(tin.timeline, { fromClipId: C, toClipId: null, type: "fade", duration: 15 });
    expect(transitionWindow(tout.timeline, tin.transition)).toMatchObject({ start: 0, end: 15 });
    expect(transitionWindow(tout.timeline, tout.transition)).toMatchObject({ start: 165, end: 180 });
    expect(timelineDurationFrames(tout.timeline)).toBe(180);
    const first = layersAt(tout.timeline, 0);
    expect(first).toHaveLength(1);
    expect(first[0].transition).toMatchObject({ role: "to", paired: false, outsideClip: false });
    expect(first[0].transition!.progress).toBeGreaterThan(0);
    const last = layersAt(tout.timeline, 179);
    expect(last[0].transition).toMatchObject({ role: "from", paired: false });
    expect(last[0].transition!.progress).toBeLessThan(1);
    expect(layersAt(tout.timeline, 180)).toHaveLength(0);
  });

  it("multiple transitions share a clip without overlapping (in + out budgets)", () => {
    const { tl, A, B, C } = scene();
    let t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve", duration: 80 }).timeline; // B hosts 40 frames of it
    const second = addTransition(t, { fromClipId: B, toClipId: C, type: "push", duration: 1000 });
    t = second.timeline;
    // B (60 frames) has 20 frames left for its transition-out -> centered max = 2*20+1.
    expect(second.transition.duration).toBe(41);
    const third = addTransition(t, { fromClipId: null, toClipId: A, type: "fade", duration: 1000 });
    expect(third.transition.duration).toBe(20); // A: 60 minus the 40 its out-transition uses
    t = third.timeline;
    const wins = Object.values(t.transitions!).map((x) => transitionWindow(t, x)!).sort((a, b) => a.start - b.start);
    for (let i = 1; i < wins.length; i++) expect(wins[i].start).toBeGreaterThanOrEqual(wins[i - 1].end);
    // Every frame has at most one transition group per track.
    const groups = transitionsByTrack(t);
    for (let f = 0; f < 180; f++) expect(layersAt(t, f).filter((l) => l.transition?.role !== "to").length).toBeLessThanOrEqual(1);
    expect(groups.get(tl.trackIds[0])).toHaveLength(3);
  });

  it("edit & resize: type change keeps shared params / fixes direction; duration resizes with clamping", () => {
    const { tl, A, B } = scene();
    const add = addTransition(tl, { fromClipId: A, toClipId: B, type: "slide", direction: "up" });
    let t = updateTransition(add.timeline, add.transition.id, { direction: "left", duration: 20, easing: { type: "linear" } });
    expect(tr(t, add.transition.id)).toMatchObject({ direction: "left", duration: 20, easing: { type: "linear" } });
    t = updateTransition(t, add.transition.id, { type: "zoom" });
    expect(tr(t, add.transition.id)).toMatchObject({ type: "zoom", direction: "in", params: { amount: 2 } });
    t = updateTransition(t, add.transition.id, { type: "cross-dissolve" });
    expect(tr(t, add.transition.id).direction).toBeUndefined();
    expect(tr(t, add.transition.id).params).toEqual({});
    t = updateTransition(t, add.transition.id, { duration: 5000 });
    expect(tr(t, add.transition.id).duration).toBe(120);
    t = updateTransition(t, add.transition.id, { alignment: "end" });
    expect(tr(t, add.transition.id).duration).toBe(60); // re-fit to the new alignment
    t = updateTransition(t, add.transition.id, { type: "wipe", params: { softness: 9 } });
    expect(tr(t, add.transition.id).params.softness).toBe(0.5); // clamped
    expectEditError(() => updateTransition(t, add.transition.id, { easing: { type: "bounce" } }), "invalid-transition");
    expectEditError(() => updateTransition(t, "transition-x", { duration: 3 }), "transition-not-found");
  });

  it("disabled transitions render as a plain cut; removing restores the cut exactly", () => {
    const { tl, A, B } = scene();
    const add = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve" });
    const off = updateTransition(add.timeline, add.transition.id, { enabled: false });
    const removed = removeTransition(add.timeline, add.transition.id);
    for (const f of [44, 50, 59, 60, 70, 75]) {
      expect(resolveFrame(off, f, ctx)).toEqual(resolveFrame(tl, f, ctx));
      expect(resolveFrame(removed, f, ctx)).toEqual(resolveFrame(tl, f, ctx));
    }
  });

  it("reconcile: moving apart / deleting drops it, trimming shortens it, splitting moves it to the right piece", () => {
    const { tl, A, B } = scene();
    const add = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve", duration: 100 });
    const id = add.transition.id;
    // Move C away first so B can move.
    const movedApart = reconcileTransitions(moveClip(deleteClip(add.timeline, Object.keys(add.timeline.clips)[2]), B, 70));
    expect(movedApart.transitions![id]).toBeUndefined();
    expect(reconcileTransitions(deleteClip(add.timeline, A)).transitions![id]).toBeUndefined();
    // Trim A's start: A is now 20 frames long -> centered max 2*20+1.
    const trimmed = reconcileTransitions(trimClip(add.timeline, A, "start", 40));
    expect(trimmed.transitions![id].duration).toBe(41);
    // Split A: the transition belongs to A's END edge, which is now the right piece's.
    const split = splitClip(add.timeline, A, 30);
    const rec = reconcileTransitions(split.timeline);
    expect(rec.transitions![id]).toMatchObject({ fromClipId: split.right.id, toClipId: B });
    expect(rec.transitions![id].duration).toBe(61); // right piece is 30 long
    expect(reconcileTransitions(add.timeline)).toBe(add.timeline); // no-op returns the same object
  });

  it("undo/redo through the engine: add, edit, resize, delete — and edits that drop a transition undo it back", () => {
    const e = new TimelineEngine(FPS, { width: 100, height: 100 });
    const track = (e.addTrack("image", "I") as { track: { id: string } }).track.id;
    const i1 = e.insertClip(track, { kind: "image", source: { sourceId: "img1" }, durationFrames: 60 }, 0);
    const i2 = e.insertClip(track, { kind: "image", source: { sourceId: "img2" }, durationFrames: 60 }, 60);
    if (!i1.ok || !i2.ok) throw new Error();
    e.resetHistory();
    const snaps: TimelineModel[] = [e.timeline];
    const add = e.addTransition({ fromClipId: i1.clip.id, toClipId: i2.clip.id, type: "slide" });
    if (!add.ok) throw add.error;
    snaps.push(e.timeline);
    expect(e.updateTransition(add.transition.id, { direction: "down" }).ok).toBe(true);
    snaps.push(e.timeline);
    expect(e.updateTransition(add.transition.id, { duration: 12 }).ok).toBe(true);
    snaps.push(e.timeline);
    expect(e.moveClip(i2.clip.id, 90).ok).toBe(true); // drops it
    expect(e.timeline.transitions![add.transition.id]).toBeUndefined();
    snaps.push(e.timeline);
    expect(e.removeTransition(add.transition.id).ok).toBe(false); // already gone
    for (let k = snaps.length - 2; k >= 0; k--) {
      e.undo();
      expect(e.timeline).toBe(snaps[k]);
    }
    for (let k = 1; k < snaps.length; k++) {
      e.redo();
      expect(e.timeline).toBe(snaps[k]);
    }
    e.undo(); // back before the move
    expect(e.removeTransition(add.transition.id).ok).toBe(true);
    expect(e.timeline.transitions![add.transition.id]).toBeUndefined();
  });
});

describe("transition evaluation (resolve)", () => {
  it("window frames carry both sides in order (from, to); frames outside are untouched", () => {
    const { tl, A, B } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve", easing: { type: "linear" } }).timeline;
    expect(resolveFrame(t, 44, ctx)).toEqual(resolveFrame(tl, 44, ctx));
    expect(resolveFrame(t, 75, ctx)).toEqual(resolveFrame(tl, 75, ctx));
    for (const f of [45, 59, 60, 74]) {
      const ls = layersAt(t, f);
      expect(ls.map((l) => [l.clipId, l.transition!.role])).toEqual([[A, "from"], [B, "to"]]);
    }
    // Linear progress (f - start + 1) / (d + 1): strictly inside (0,1), monotonic, symmetric.
    const ps = Array.from({ length: 30 }, (_, k) => layersAt(t, 45 + k)[0].transition!.progress);
    expect(ps[0]).toBeCloseTo(1 / 31, 10);
    expect(ps[29]).toBeCloseTo(30 / 31, 10);
    for (let k = 1; k < 30; k++) expect(ps[k]).toBeGreaterThan(ps[k - 1]);
  });

  it("easing shapes the progress curve", () => {
    const { tl, A, B } = scene();
    const lin = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade", easing: { type: "linear" }, duration: 9 }).timeline;
    const eio = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade", easing: { type: "ease-in-out" }, duration: 9 }).timeline;
    const at = (t: TimelineModel, f: number) => layersAt(t, f)[0].transition!.progress;
    expect(at(lin, 56)).toBeCloseTo(0.1, 10); // window [56,65): (0+1)/10
    expect(at(eio, 56)).toBeLessThan(0.1); // slow start
    expect(at(eio, 60)).toBeCloseTo(0.5, 6); // symmetric curve through the midpoint
  });

  it("uses source handles past the out/in points, and holds the edge frame when the source has none", () => {
    const { tl, A, B, C } = scene();
    let t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve", duration: 30 }).timeline;
    t = addTransition(t, { fromClipId: B, toClipId: C, type: "cross-dissolve", duration: 30 }).timeline;
    const frameOf = (f: number, clipId: string) => {
      const l = layersAt(t, f).find((x) => x.clipId === clipId)!;
      return l.content.type === "media" ? l.content.sourceFrame : -1;
    };
    expect(frameOf(70, A)).toBe(70); // A (src 0..60 of 100) continues into its handle
    expect(frameOf(50, B)).toBe(0); // B (src in 10) starts 10 frames early: 10 - 10
    expect(frameOf(45, B)).toBe(0); // ... and holds frame 0 rather than asking for frame -5
    expect(frameOf(110, C)).toBe(0); // C has no known handles: holds its first frame
    expect(frameOf(125, B)).toBe(75); // B continues past its out (70) into its handle
    // Inside their own spans, nothing changed.
    expect(frameOf(59, A)).toBe(59);
    expect(frameOf(60, B)).toBe(10);
  });

  it("works between image clips and graphics/text (shape) clips", () => {
    let tl = createTimeline(FPS, { width: 100, height: 100 });
    const it1 = addTrack(tl, "image", "I");
    tl = it1.timeline;
    const a = insertClip(tl, it1.track.id, { kind: "image", source: { sourceId: "img1" }, durationFrames: 30 }, 0);
    const b = insertClip(a.timeline, it1.track.id, { kind: "image", source: { sourceId: "img2" }, durationFrames: 30 }, 30);
    tl = addTransition(b.timeline, { fromClipId: a.clip.id, toClipId: b.clip.id, type: "dissolve" }).timeline;
    expect(layersAt(tl, 30).map((l) => l.transition?.role)).toEqual(["from", "to"]);
    const g = addTrack(tl, "graphic", "G");
    tl = g.timeline;
    const s1 = insertClip(tl, g.track.id, { kind: "graphic", shape: normalizeShapeSpec({ type: "rect", width: 40, height: 40 }), durationFrames: 30 }, 0);
    const s2 = insertClip(s1.timeline, g.track.id, { kind: "graphic", shape: normalizeShapeSpec({ type: "ellipse", width: 40, height: 40 }), durationFrames: 30 }, 30);
    tl = addTransition(s2.timeline, { fromClipId: s1.clip.id, toClipId: s2.clip.id, type: "push", direction: "up" }).timeline;
    const tx = addTrack(tl, "text", "T");
    tl = tx.timeline;
    const t1 = insertClip(tl, tx.track.id, { kind: "text", text: "Hello", durationFrames: 30 }, 0);
    tl = addTransition(t1.timeline, { fromClipId: t1.clip.id, toClipId: null, type: "wipe" }).timeline;
    const ls = layersAt(tl, 29);
    expect(ls.filter((l) => l.transition).map((l) => `${l.kind}:${l.transition!.type}:${l.transition!.role}`)).toEqual(["text:wipe:from", "graphic:push:from", "graphic:push:to", "image:dissolve:from", "image:dissolve:to"]); // back-to-front (new tracks are appended at the back)
  });

  it("scrubbing: random-access evaluation equals sequential playback, frame for frame", () => {
    const { tl, A, B, C } = scene();
    let t = addTransition(tl, { fromClipId: A, toClipId: B, type: "zoom", duration: 40 }).timeline;
    t = addTransition(t, { fromClipId: B, toClipId: C, type: "dissolve", duration: 20 }).timeline;
    t = addTransition(t, { fromClipId: null, toClipId: A, type: "fade", duration: 10 }).timeline;
    const sequential: ResolvedFrame[] = [];
    for (let f = 0; f < 180; f++) sequential.push(resolveFrame(t, f, ctx));
    const order = Array.from({ length: 180 }, (_, f) => f).sort((x, y) => ((x * 7919) % 180) - ((y * 7919) % 180));
    for (const f of order) expect(resolveFrame(t, f, ctx)).toEqual(sequential[f]);
    // Playback: progress rises monotonically through each window.
    let prev = -1;
    for (let f = 40; f < 80; f++) {
      const p = sequential[f].layers[0].transition!.progress;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("layers shown outside their own span aren't hit-testable (clicks pick the real clip)", () => {
    const { tl, A, B } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve" }).timeline;
    expect(hitTest(resolveFrame(t, 55, ctx), { x: 50, y: 50 })?.clipId).toBe(A); // B (front of the pair) is outside its span here
    expect(hitTest(resolveFrame(t, 65, ctx), { x: 50, y: 50 })?.clipId).toBe(B);
  });

  it("activeTransitionAt picks nothing on gaps / other tracks", () => {
    const { tl, A, B, track } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade" }).timeline;
    expect(activeTransitionAt(t, transitionsByTrack(t).get(track), 10)).toBeNull();
    expect(activeTransitionAt(t, transitionsByTrack(t).get("track-x"), 60)).toBeNull();
    expect(maxTransitionDuration(t, Object.values(t.transitions!)[0])).toBe(120);
  });
});

describe("persistence (project v7)", () => {
  it("save -> reload round-trips every field and renders identically", () => {
    const { tl, A, B, C } = scene();
    let t = addTransition(tl, { fromClipId: A, toClipId: B, type: "wipe", direction: "up", params: { softness: 0.2 }, easing: { type: "cubic-bezier", x1: 0.1, y1: 0.7, x2: 0.3, y2: 1 }, duration: 24, alignment: "end" }).timeline;
    t = addTransition(t, { fromClipId: C, toClipId: null, type: "fade", params: { color: "#FF0000" } }).timeline;
    const id = Object.keys(t.transitions!)[0];
    t = updateTransition(t, id, { enabled: false, metadata: { label: "Hero wipe" } });
    const loaded = deserializeTimeline(serializeTimeline(t));
    expect(loaded.transitions).toEqual(t.transitions);
    expect(loaded.transitions![Object.keys(t.transitions!)[1]].params.color).toBe("#ff0000");
    for (const f of [0, 40, 55, 59, 60, 150, 179]) expect(resolveFrame(loaded, f, ctx)).toEqual(resolveFrame(t, f, ctx));
    // Ids reserved: a new transition can't collide with a loaded one.
    const more = addTransition(loaded, { fromClipId: null, toClipId: A, type: "cut" });
    expect(Object.keys(loaded.transitions!)).not.toContain(more.transition.id);
  });

  it("rejects corrupt transitions instead of loading a half-valid project", () => {
    const { tl, A, B, C } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade", duration: 20 }).timeline;
    const id = Object.keys(t.transitions!)[0];
    const mutate = (fn: (x: Record<string, unknown>) => void) => {
      const doc = JSON.parse(serializeTimeline(t));
      fn(doc.timeline.transitions[id]);
      return () => deserializeTimeline(JSON.stringify(doc));
    };
    expect(mutate((x) => (x.type = "spin"))).toThrow(ProjectFormatError);
    expect(mutate((x) => (x.toClipId = C))).toThrow(ProjectFormatError); // not adjacent
    expect(mutate((x) => (x.fromClipId = "clip-999"))).toThrow(ProjectFormatError);
    expect(mutate((x) => (x.duration = 500))).toThrow(ProjectFormatError); // longer than the clips allow
    expect(mutate((x) => (x.duration = 2.5))).toThrow(ProjectFormatError);
    expect(mutate((x) => (x.easing = { type: "nope" }))).toThrow(ProjectFormatError);
    const dup = JSON.parse(serializeTimeline(t));
    dup.timeline.transitions["transition-dup"] = { ...dup.timeline.transitions[id], id: "transition-dup" };
    expect(() => deserializeTimeline(JSON.stringify(dup))).toThrow(/share the clip edge/);
  });

  it("older projects (v6, no transitions) still load", () => {
    const { tl } = scene();
    const doc = JSON.parse(serializeTimeline(tl));
    doc.version = 6;
    expect(deserializeTimeline(JSON.stringify(doc)).transitions).toBeUndefined();
  });
});

describe("draw path (recording canvas)", () => {
  type Call = { surface: string; op: string; args: unknown[]; gco?: string; alpha?: number };
  function recordingCtx(surface: string, log: Call[], w: number, h: number): Ctx2D {
    const state: Record<string, unknown> = { globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "" };
    const canvas = { width: w, height: h, __surface: surface };
    return new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "canvas") return canvas;
        if (prop in state) return state[prop];
        return (...args: unknown[]) => log.push({ surface, op: prop, args, gco: state.globalCompositeOperation as string, alpha: state.globalAlpha as number });
      },
      set(_t, prop: string, value) {
        state[prop] = value;
        return true;
      },
    }) as Ctx2D;
  }

  function drawAt(t: TimelineModel, f: number, pixels: Map<string, { image?: CanvasImageSource }>) {
    const log: Call[] = [];
    const scratch = new Map<number, Ctx2D>();
    const stats = drawResolvedFrame(recordingCtx("main", log, 100, 100), resolveFrame(t, f, ctx), pixels, {
      renderScale: 1,
      smoothing: "high",
      getScratch: (slot = 0) => {
        if (!scratch.has(slot)) scratch.set(slot, recordingCtx(`slot${slot}`, log, 100, 100));
        return scratch.get(slot)!;
      },
    });
    return { log, stats };
  }

  it("each side renders to its own surface, the registered compositor mixes them, and the mix composites once at the track's z-position", () => {
    const { tl, A, B } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cross-dissolve", easing: { type: "linear" } }).timeline;
    const imgA = { width: 100, height: 100, n: "A" } as unknown as CanvasImageSource;
    const imgB = { width: 100, height: 100, n: "B" } as unknown as CanvasImageSource;
    const { log, stats } = drawAt(t, 59, new Map([[A, { image: imgA }], [B, { image: imgB }]]));
    const draws = log.filter((c) => c.op === "drawImage");
    expect(draws.map((d) => d.surface)).toEqual(["slot1", "slot2", "slot3", "slot3", "main"]);
    expect(draws[0].args[0]).toBe(imgA);
    expect(draws[1].args[0]).toBe(imgB);
    // Cross dissolve at p = 15/31: A at 1-p over, B at p additive.
    expect(draws[2]).toMatchObject({ gco: "source-over" });
    expect(draws[2].alpha).toBeCloseTo(16 / 31, 10);
    expect(draws[3]).toMatchObject({ gco: "lighter" });
    expect(draws[3].alpha).toBeCloseTo(15 / 31, 10);
    expect(draws[4]).toMatchObject({ gco: "source-over", alpha: 1 });
    expect(stats).toEqual({ drawn: 2, skipped: [] });
  });

  it("a side without pixels is reported as skipped (final render fails loudly) and the other side still mixes", () => {
    const { tl, A, B } = scene();
    const t = addTransition(tl, { fromClipId: A, toClipId: B, type: "cut" }).timeline;
    const { log, stats } = drawAt(t, 55, new Map([[A, { image: { width: 100, height: 100 } as unknown as CanvasImageSource }]]));
    expect(stats.skipped).toEqual([B]);
    expect(log.filter((c) => c.op === "drawImage").map((d) => d.surface)).toEqual(["slot1", "slot3", "main"]);
  });

  it("an unregistered type falls back to a cut instead of breaking the frame", () => {
    const { tl, A, B } = scene();
    let t = addTransition(tl, { fromClipId: A, toClipId: B, type: "fade" }).timeline;
    const id = Object.keys(t.transitions!)[0];
    t = { ...t, transitions: { [id]: { ...t.transitions![id], type: "removed-plugin" } as Transition } };
    const img = { width: 100, height: 100 } as unknown as CanvasImageSource;
    const { log } = drawAt(t, 50, new Map([[A, { image: img }], [B, { image: img }]]));
    expect(log.filter((c) => c.op === "drawImage" && c.surface === "slot3")).toHaveLength(1);
  });
});
