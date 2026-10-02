import { beforeEach, describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTrack, insertClip, setClipVisual, setClipVisuals, duplicateClipsAsLayers, setTrackLocked } from "../timeline/operations";
import { applyVisualPatch, type ClipVisual } from "../timeline/visual";
import type { ClipContent } from "../timeline/clip";
import { applyToPoint } from "./matrix";
import { resolveFrame, resolveClipLayer, type ResolvedLayer } from "./resolve";
import { drawResolvedFrame, type Ctx2D } from "./draw";
import { fakeContext } from "./test-helpers";
import {
  cropFromHandle,
  handleCompPoints,
  layerSize,
  moveAnchorTo,
  resizeFromHandle,
  rotateFromPointer,
  setLayerSize,
  translateVisual,
  visibleBounds,
} from "./transform-tools";
import { alignMany, marqueeHits, unionBounds } from "./multi-select";
import { buildSnapTargets, snapRect } from "./snap";

/**
 * PHASE 5 — TRANSFORM & CROP ENGINE acceptance suite. One describe per
 * required behavior. Geometry is asserted through resolveFrame (the exact
 * code the renderers use), so these test what gets DRAWN, not just the
 * numbers stored.
 */

const SOURCES = {
  portrait: { width: 720, height: 1280 }, // the real demo video's size
  landscape: { width: 1920, height: 1080 },
  square: { width: 800, height: 800 },
  transparentPng: { width: 512, height: 512 },
  cutout: { width: 600, height: 900 }, // a background-removal foreground canvas
  matte: { width: 300, height: 450 }, // a matte at half the source resolution
};

const near = (a: { x: number; y: number }, b: { x: number; y: number }, d = 6) => {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
};

function build(comp = { width: 1920, height: 1080 }) {
  let tl = createTimeline(30, { ...comp, background: "transparent" });
  const ids: Record<string, string> = {};
  const add = (name: string, kind: ClipContent["kind"], content: ClipContent) => {
    const t = addTrack(tl, kind, name);
    tl = t.timeline;
    const c = insertClip(tl, t.track.id, content, 0);
    tl = c.timeline;
    ids[name] = c.clip.id;
    ids[`${name}Track`] = t.track.id;
  };
  const video = (sourceId: string): ClipContent => ({ kind: "video", source: { sourceId }, sourceInFrame: 0, sourceOutFrame: 60 });
  add("text", "text", { kind: "text", text: "Title", durationFrames: 60 });
  add("shape", "graphic", { kind: "graphic", shape: { type: "rect", width: 300, height: 120, fill: "#f00", strokeWidth: 0, cornerRadius: 0 }, durationFrames: 60 });
  add("cutout", "image", { kind: "image", source: { sourceId: "cutout" }, durationFrames: 60 });
  add("png", "image", { kind: "image", source: { sourceId: "transparentPng" }, durationFrames: 60 });
  add("square", "image", { kind: "image", source: { sourceId: "square" }, durationFrames: 60 });
  add("landscape", "overlay", { kind: "overlay", source: { sourceId: "landscape" }, sourceInFrame: 0, sourceOutFrame: 60 });
  add("portrait", "video", video("portrait"));
  return { tl, ids };
}

const ctx = () => fakeContext(SOURCES);
const layerOf = (tl: TimelineModel, id: string): ResolvedLayer => resolveClipLayer(tl, id, 0, ctx())!;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

let env: ReturnType<typeof build>;
beforeEach(() => {
  env = build();
});

describe("1. move", () => {
  it("translating moves the drawn bounds by exactly the delta, for every layer kind", () => {
    for (const name of ["text", "shape", "cutout", "png", "square", "landscape", "portrait"]) {
      const before = layerOf(env.tl, env.ids[name]);
      const moved = setClipVisual(env.tl, env.ids[name], { transform: translateVisual(before.visual, 123.5, -40).transform });
      const after = layerOf(moved, env.ids[name]);
      expect(after.bounds.x - before.bounds.x).toBeCloseTo(123.5, 9);
      expect(after.bounds.y - before.bounds.y).toBeCloseTo(-40, 9);
      expect(after.bounds.width).toBeCloseTo(before.bounds.width, 9);
    }
  });
});

describe("2. resize", () => {
  it("width/height edit sizes the drawn layer exactly, around the anchor", () => {
    const l = layerOf(env.tl, env.ids.shape);
    const v = setLayerSize(l.visual, l.box, { width: 600 }, true);
    const after = layerOf(setClipVisual(env.tl, env.ids.shape, { transform: v.transform }), env.ids.shape);
    expect(after.bounds.width).toBeCloseTo(600, 9);
    expect(after.bounds.height).toBeCloseTo(240, 9);
    near({ x: after.bounds.x + 300, y: after.bounds.y + 120 }, { x: 960, y: 540 });
  });

  it("handle resize lands the dragged corner on the pointer with the opposite corner pinned", () => {
    const l = layerOf(env.tl, env.ids.square);
    const pinned = handleCompPoints(l.visual, l.box).nw;
    const v = resizeFromHandle(l.visual, l.box, "se", { x: 1500, y: 1000 }, { keepAspect: false, fromAnchor: false });
    const after = layerOf(setClipVisual(env.tl, env.ids.square, { transform: v.transform }), env.ids.square);
    near(applyToPoint(after.matrix, { x: 0, y: 0 }), pinned);
    near(applyToPoint(after.matrix, { x: 800, y: 800 }), { x: 1500, y: 1000 });
  });
});

describe("3. rotate", () => {
  it("rotates about the anchor; the anchor's screen position is invariant", () => {
    const l = layerOf(env.tl, env.ids.landscape);
    const v = rotateFromPointer(l.visual, { x: 1500, y: 540 }, { x: 960, y: 1000 });
    const after = layerOf(setClipVisual(env.tl, env.ids.landscape, { transform: v.transform }), env.ids.landscape);
    expect(after.visual.transform.rotation).toBeCloseTo(90, 9);
    // content center (anchor 0.5,0.5) stays at the composition center
    near(applyToPoint(after.matrix, { x: 960, y: 540 }), { x: 960, y: 540 });
    // a 16:9 layer turned 90° has swapped bounds
    expect(after.bounds.width).toBeCloseTo(before(l).height, 6);
  });
  const before = (l: ResolvedLayer) => l.bounds;
});

describe("4. crop", () => {
  it("crops in place: the matrix is untouched and the visible region shrinks", () => {
    const l = layerOf(env.tl, env.ids.portrait);
    const v = cropFromHandle(l.visual, l.box, "n", applyToPoint(l.matrix, { x: 360, y: 320 }));
    const after = layerOf(setClipVisual(env.tl, env.ids.portrait, { crop: v.crop }), env.ids.portrait);
    expect(after.visual.crop.top).toBeCloseTo(0.25, 9);
    expect(after.matrix).toEqual(l.matrix);
    expect(after.crop).toEqual({ x: 0, y: 320, width: 720, height: 960 }); // source px
  });
});

describe("5. flip", () => {
  it("mirrors content about the anchor without moving the bounds", () => {
    const l = layerOf(env.tl, env.ids.square);
    const flipped = layerOf(setClipVisual(env.tl, env.ids.square, { transform: { flipX: true, flipY: true } }), env.ids.square);
    near(applyToPoint(flipped.matrix, { x: 0, y: 0 }), applyToPoint(l.matrix, { x: 800, y: 800 }));
    expect(flipped.bounds).toEqual(l.bounds);
  });
});

describe("6. opacity", () => {
  it("clamps to [0,1], resolves onto the layer, and a 0-opacity layer is not drawn", () => {
    const half = setClipVisual(env.tl, env.ids.png, { opacity: 0.5 });
    expect(layerOf(half, env.ids.png).opacity).toBe(0.5);
    expect(setClipVisual(env.tl, env.ids.png, { opacity: 7 }).clips[env.ids.png].visual?.opacity).toBe(1);
    const hidden = setClipVisual(env.tl, env.ids.png, { opacity: 0 });
    expect(resolveFrame(hidden, 0, ctx()).layers.map((l) => l.clipId)).not.toContain(env.ids.png);
  });
});

describe("7. anchor point", () => {
  it("moving the anchor never moves the layer, but changes the rotation pivot", () => {
    const l = layerOf(env.tl, env.ids.shape);
    const corner = handleCompPoints(l.visual, l.box).nw;
    const v = moveAnchorTo(l.visual, l.box, corner);
    const moved = layerOf(setClipVisual(env.tl, env.ids.shape, { transform: v.transform }), env.ids.shape);
    for (const k of ["a", "b", "c", "d", "e", "f"] as const) expect(moved.matrix[k]).toBeCloseTo(l.matrix[k], 9);
    const rotated = layerOf(setClipVisual(env.tl, env.ids.shape, { transform: { ...v.transform, rotation: 45 } }), env.ids.shape);
    near(applyToPoint(rotated.matrix, { x: 0, y: 0 }), corner); // pivots about the new anchor (top-left)
  });
});

describe("8/9. undo + redo", () => {
  it("every transform kind is one undoable, redoable step", () => {
    const e = new TimelineEngine(30);
    e.loadTimeline(env.tl);
    const id = env.ids.square;
    const steps: Parameters<TimelineEngine["setClipVisual"]>[1][] = [
      { transform: { x: 100 } },
      { transform: { scaleX: 2, scaleY: 2 } },
      { transform: { rotation: 30 } },
      { transform: { anchorX: 0, anchorY: 0 } },
      { crop: { left: 0.2 } },
      { transform: { flipX: true } },
      { opacity: 0.3 },
      { blendMode: "screen" },
    ];
    const snapshots: (ClipVisual | undefined)[] = [e.timeline.clips[id].visual];
    for (const p of steps) {
      expect(e.setClipVisual(id, p).ok).toBe(true);
      snapshots.push(e.timeline.clips[id].visual);
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      e.undo();
      expect(e.timeline.clips[id].visual).toEqual(snapshots[i]);
    }
    expect(e.canUndo).toBe(false);
    for (let i = 1; i <= steps.length; i++) {
      e.redo();
      expect(e.timeline.clips[id].visual).toEqual(snapshots[i]);
    }
  });
});

describe("10. multi-select", () => {
  it("multi-object move is atomic: one undo step for N clips", () => {
    const e = new TimelineEngine(30);
    e.loadTimeline(env.tl);
    const ids = [env.ids.shape, env.ids.png, env.ids.text];
    const patches = Object.fromEntries(ids.map((id) => [id, { transform: translateVisual(layerOf(e.timeline, id).visual, 50, 25).transform }]));
    expect(e.setClipVisuals(patches).ok).toBe(true);
    for (const id of ids) expect(e.timeline.clips[id].visual?.transform.x).toBeCloseTo(layerOf(env.tl, id).visual.transform.x + 50, 9);
    e.undo();
    for (const id of ids) expect(e.timeline.clips[id].visual).toEqual(env.tl.clips[id].visual);
  });

  it("a batch touching a locked track changes nothing at all", () => {
    const locked = setTrackLocked(env.tl, env.ids.pngTrack, true);
    expect(() => setClipVisuals(locked, { [env.ids.shape]: { opacity: 0.1 }, [env.ids.png]: { opacity: 0.1 } })).toThrow(/locked/);
    const e = new TimelineEngine(30);
    e.loadTimeline(locked);
    expect(e.setClipVisuals({ [env.ids.shape]: { opacity: 0.1 }, [env.ids.png]: { opacity: 0.1 } }).ok).toBe(false);
    expect(e.timeline.clips[env.ids.shape].visual).toBeUndefined();
    expect(e.canUndo).toBe(false);
  });

  it("marquee selects every layer it touches, front-most first", () => {
    const f = resolveFrame(env.tl, 0, ctx());
    expect(marqueeHits(f, { x: 950, y: 530, width: 20, height: 20 })).toEqual(f.layers.map((l) => l.clipId).reverse());
    expect(marqueeHits(f, { x: -50, y: -50, width: 10, height: 10 })).toEqual([]);
  });

  it("align-to-selection moves every member to the shared edge", () => {
    const ids = [env.ids.shape, env.ids.png];
    let tl = setClipVisual(env.tl, env.ids.shape, { transform: { x: 300 } });
    tl = setClipVisual(tl, env.ids.png, { transform: { x: 1400 }, fit: "none" });
    const items = ids.map((id) => ({ clipId: id, bounds: layerOf(tl, id).bounds }));
    const deltas = alignMany(items, "selection", "left");
    const left = Math.min(...items.map((i) => i.bounds.x));
    const patched = setClipVisuals(tl, Object.fromEntries(Object.entries(deltas).map(([id, d]) => [id, { transform: translateVisual(layerOf(tl, id).visual, d.dx, d.dy).transform }])));
    for (const id of ids) expect(layerOf(patched, id).bounds.x).toBeCloseTo(left, 9);
  });

  it("duplicate makes independent layers stacked directly above, sharing the source", () => {
    const { timeline, clips } = duplicateClipsAsLayers(env.tl, [env.ids.square, env.ids.text], { x: 24, y: 24 });
    const [sq] = clips;
    expect(timeline.trackIds.indexOf(sq.trackId)).toBe(timeline.trackIds.indexOf(env.ids.squareTrack) - 1);
    expect(sq.timelineStart).toBe(env.tl.clips[env.ids.square].timelineStart);
    expect(sq.content).toBe(env.tl.clips[env.ids.square].content); // same source ref object — nothing copied
    expect(layerOf(timeline, sq.id).bounds.x - layerOf(env.tl, env.ids.square).bounds.x).toBeCloseTo(24, 9);
    expect(timeline.clips[env.ids.square]).toBe(env.tl.clips[env.ids.square]); // original untouched
  });
});

describe("11. snapping", () => {
  it("a multi-selection snaps as one group (union bounds)", () => {
    const a = { x: 100, y: 100, width: 50, height: 50 };
    const b = { x: 240, y: 300, width: 80, height: 20 };
    const u = unionBounds([a, b])!;
    expect(u).toEqual({ x: 100, y: 100, width: 220, height: 220 });
    const s = snapRect({ ...u, x: 960 - 110 + 4 }, buildSnapTargets({ composition: { width: 1920, height: 1080 } }), 6);
    expect(s.dx).toBe(-4); // group center -> canvas center
  });
});

describe("13/14. portrait and landscape media", () => {
  it("portrait 720x1280 fits a 16:9 canvas by height and keeps its aspect through resize", () => {
    const l = layerOf(env.tl, env.ids.portrait);
    expect(l.box.height).toBeCloseTo(1080, 9);
    expect(l.box.width).toBeCloseTo(607.5, 9);
    const v = resizeFromHandle(l.visual, l.box, "se", { x: 2000, y: 1500 }, { keepAspect: true, fromAnchor: false });
    const s = layerSize(v, l.box);
    expect(s.width / s.height).toBeCloseTo(720 / 1280, 9);
  });

  it("landscape fits a 9:16 canvas by width; crop maps through source pixels", () => {
    const vertical = build({ width: 1080, height: 1920 });
    const l = layerOf(vertical.tl, vertical.ids.landscape);
    expect(l.box.width).toBeCloseTo(1080, 9);
    expect(l.box.height).toBeCloseTo(607.5, 9);
    const cropped = layerOf(setClipVisual(vertical.tl, vertical.ids.landscape, { crop: { left: 0.25, right: 0.25 } }), vertical.ids.landscape);
    expect(cropped.crop).toEqual({ x: 480, y: 0, width: 960, height: 1080 });
    expect(cropped.bounds.width).toBeCloseTo(540, 9);
  });

  it("square media stays square under uniform scale and rotation", () => {
    const l = layerOf(env.tl, env.ids.square);
    const v = applyVisualPatch(l.visual, { transform: { scaleX: 0.5, scaleY: 0.5, rotation: 90 } });
    const b = visibleBounds(v, l.box);
    expect(b.width).toBeCloseTo(b.height, 9);
  });
});

/** Recording 2D context: logs drawImage/fillRect with the composite op + alpha in effect; throws if anything writes to a source. */
function recorder(width: number, height: number) {
  const calls: { op: string; args: unknown[]; gco: string; alpha: number }[] = [];
  const state = { globalCompositeOperation: "source-over", globalAlpha: 1 };
  const ctx2 = new Proxy({}, {
    get(_t, p: string) {
      if (p === "canvas") return { width, height };
      if (p in state) return state[p as keyof typeof state];
      return (...args: unknown[]) => calls.push({ op: p, args, gco: state.globalCompositeOperation, alpha: state.globalAlpha });
    },
    set(_t, p: string, v) {
      if (p in state) (state as Record<string, unknown>)[p] = v;
      return true;
    },
  }) as Ctx2D;
  return { ctx2, calls };
}

/** A source image that throws on any write — proves the renderer only ever READS the asset. */
function readOnlySource(width: number, height: number): CanvasImageSource {
  return new Proxy({ width, height }, {
    set() {
      throw new Error("renderer attempted to modify the source asset");
    },
    defineProperty() {
      throw new Error("renderer attempted to modify the source asset");
    },
  }) as unknown as CanvasImageSource;
}

describe("15. transparent media", () => {
  it("a transparent PNG is composited straight from the source — no backdrop, no flattening, alpha intact", () => {
    const tl = setClipVisual(env.tl, env.ids.png, { transform: { rotation: 33, scaleX: 0.7, scaleY: 0.7 }, opacity: 0.8 });
    const frame = resolveFrame(tl, 0, ctx());
    const only = { ...frame, layers: frame.layers.filter((l) => l.clipId === env.ids.png) };
    const src = readOnlySource(512, 512);
    const { ctx2, calls } = recorder(1920, 1080);
    drawResolvedFrame(ctx2, only, new Map([[env.ids.png, { image: src }]]), { renderScale: 1, smoothing: "high", getScratch: () => { throw new Error("no scratch for an unmatted layer"); } });
    expect(calls.filter((c) => c.op === "fillRect")).toHaveLength(0); // transparent comp: nothing painted behind it
    const draw = calls.find((c) => c.op === "drawImage")!;
    expect(draw.args[0]).toBe(src); // the original asset, not a pre-transformed copy
    expect(draw.args.slice(1, 5)).toEqual([0, 0, 512, 512]); // full source rect: one resample, from source
    expect(draw).toMatchObject({ gco: "source-over", alpha: 0.8 });
  });
});

describe("16. background-removed media", () => {
  it("a cutout (alpha foreground) transforms like any image, straight from the source", () => {
    const tl = setClipVisual(env.tl, env.ids.cutout, { transform: { x: 400, flipX: true, scaleX: 0.5, scaleY: 0.5 }, crop: { bottom: 0.2 } });
    const frame = resolveFrame(tl, 0, ctx());
    const only = { ...frame, layers: frame.layers.filter((l) => l.clipId === env.ids.cutout) };
    const src = readOnlySource(600, 900);
    const { ctx2, calls } = recorder(1920, 1080);
    drawResolvedFrame(ctx2, only, new Map([[env.ids.cutout, { image: src }]]), { renderScale: 1, smoothing: "high", getScratch: () => { throw new Error(); } });
    const draw = calls.find((c) => c.op === "drawImage")!;
    expect(draw.args[0]).toBe(src);
    expect(draw.args.slice(1, 5)).toEqual([0, 0, 600, 720]); // bottom 20% cropped, read from the source
  });

  it("a live matte stays aligned with its subject under move/scale/rotate/crop", () => {
    const tl = setClipVisual(env.tl, env.ids.portrait, {
      matte: { sourceId: "matte", invert: false },
      transform: { x: 700, rotation: -12, scaleX: 0.6, scaleY: 0.6 },
      crop: { left: 0.1, top: 0.2 },
    });
    const frame = resolveFrame(tl, 0, ctx());
    const only = { ...frame, layers: frame.layers.filter((l) => l.clipId === env.ids.portrait) };
    const src = readOnlySource(720, 1280);
    const matte = readOnlySource(300, 450);
    const main = recorder(1920, 1080);
    const scratch = recorder(1920, 1080);
    drawResolvedFrame(main.ctx2, only, new Map([[env.ids.portrait, { image: src, matte }]]), { renderScale: 1, smoothing: "high", getScratch: () => scratch.ctx2 });
    const [content, matteDraw] = scratch.calls.filter((c) => c.op === "drawImage");
    // Same destination rect (content space) for subject and matte -> same matrix -> pixel-aligned at any transform.
    expect(content.args.slice(5)).toEqual(matteDraw.args.slice(5));
    expect(matteDraw.gco).toBe("destination-in");
    // Matte crop maps through ITS OWN resolution (300x450 for a 720x1280 source).
    expect(matteDraw.args.slice(1, 5).map((n) => Number((n as number).toFixed(6)))).toEqual([30, 90, 270, 360]);
  });
});

describe("non-destructive: the original source is never modified", () => {
  it("every transform op leaves the input timeline (and its MediaSourceRefs) untouched", () => {
    const frozen = deepFreeze(build().tl);
    const id = Object.values(frozen.clips).find((c) => c.content.kind === "video")!.id;
    const sourceRef = (frozen.clips[id].content as { source: unknown }).source;
    // Any mutation of a frozen object throws in strict-mode modules — so completing proves no op mutates.
    let tl = setClipVisual(frozen, id, { transform: { x: 1, rotation: 45, scaleX: 3, flipX: true, anchorX: 0 }, crop: { top: 0.4 }, opacity: 0.2 });
    tl = setClipVisuals(tl, { [id]: { transform: { y: 9 } } });
    tl = duplicateClipsAsLayers(tl, [id], { x: 5, y: 5 }).timeline;
    expect((tl.clips[id].content as { source: unknown }).source).toBe(sourceRef);
    expect(frozen.clips[id].visual).toBeUndefined();
  });
});
