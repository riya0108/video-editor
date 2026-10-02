import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTrack, insertClip, setClipVisual } from "../timeline/operations";
import { normalizeShapeSpec, shapePreset, lineBoxHeight, type ShapePreset, type ShapeSpec } from "../timeline/shape-style";
import { deserializeTimeline, serializeTimeline } from "../timeline/serialize";
import { resolveClipLayer, resolveFrame, type ResolvedLayer } from "../composition/resolve";
import { drawResolvedFrame, svgRasterSizeFor, type Ctx2D } from "../composition/draw";
import { applyToPoint } from "../composition/matrix";
import { fakeContext } from "../composition/test-helpers";
import { handleCompPoints } from "../composition/transform-tools";
import { normalizeTextStyle } from "../timeline/text-style";
import { sanitizeSvg, svgIntrinsicSize, svgAtSize, svgSpecFromMarkup, svgRasterSize, SvgImportError } from "./svg";
import { graphicResize } from "./graphic-transform";
import { GRAPHICS_LIBRARY } from "./library";

/**
 * PHASE 7 — SHAPES & GRAPHICS acceptance suite. Geometry asserted through
 * resolveFrame (what renderers draw); painting asserted with a recording 2D
 * context (calls + the canvas state in effect at each call).
 */

const ctx = () => fakeContext({ video: { width: 1920, height: 1080 }, cutout: { width: 800, height: 1200 }, matte: { width: 400, height: 600 } });
const PRESETS: ShapePreset[] = ["rect", "rounded-rect", "circle", "ellipse", "polygon", "line", "arrow"];
const HEART = GRAPHICS_LIBRARY.find((g) => g.id === "heart")!.markup;

function project(comp = { width: 1920, height: 1080 }) {
  return new TimelineEngine(30, { ...comp, background: "#000000" });
}
function addShape(e: TimelineEngine, shape: Partial<ShapeSpec> | ShapePreset, atFrame = 0, durationFrames = 90) {
  const spec = typeof shape === "string" ? shapePreset(shape, e.timeline.composition.width, e.timeline.composition.height) : normalizeShapeSpec(shape);
  const r = e.addGraphicLayer({ graphic: { shape: spec }, atFrame, durationFrames });
  if (!r.ok) throw r.error;
  return r.clip.id;
}
function addSvg(e: TimelineEngine, markup = HEART, atFrame = 0) {
  const r = e.addGraphicLayer({ graphic: { svg: svgSpecFromMarkup(markup, 300) }, atFrame, durationFrames: 90 });
  if (!r.ok) throw r.error;
  return r.clip.id;
}
const layerOf = (tl: TimelineModel, id: string, frame = 0): ResolvedLayer => resolveClipLayer(tl, id, frame, ctx())!;
const shapeOf = (tl: TimelineModel, id: string): ShapeSpec => normalizeShapeSpec((tl.clips[id].content as { shape: ShapeSpec }).shape);

function recorder() {
  type Call = { op: string; args: unknown[]; state: Record<string, unknown> };
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, shadowColor: "transparent", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, imageSmoothingQuality: "low", lineCap: "butt", lineJoin: "miter", miterLimit: 10, font: "", textAlign: "start", textBaseline: "alphabetic" };
  const target = { canvas: { width: 1920, height: 1080 } };
  const proxy = new Proxy(target, {
    has: (_t, p) => p in state || p === "canvas",
    get(_t, p: string) {
      if (p === "canvas") return target.canvas;
      if (p in state) return state[p];
      if (p === "measureText") return (t: string) => ({ width: Array.from(t).length * 10 });
      return (...args: unknown[]) => calls.push({ op: p, args, state: { ...state } });
    },
    set(_t, p: string, v) {
      state[p] = v;
      return true;
    },
  });
  return { ctx: proxy as unknown as Ctx2D, calls };
}
function draw(tl: TimelineModel, ids?: string[], frame = 0, renderScale = 1, images = new Map<string, { image?: CanvasImageSource; matte?: CanvasImageSource }>()) {
  const f = resolveFrame(tl, frame, ctx());
  const r = recorder();
  const scratch = recorder();
  drawResolvedFrame(r.ctx, ids ? { ...f, layers: f.layers.filter((l) => ids.includes(l.clipId)) } : f, images, { renderScale, smoothing: "high", getScratch: () => scratch.ctx });
  return { calls: r.calls, scratch: scratch.calls, frame: f };
}
const img = (w: number, h: number) => ({ width: w, height: h }) as unknown as CanvasImageSource;

describe("create", () => {
  it("every shape preset creates a selected graphic layer on its own front track at the playhead (one undo step)", () => {
    for (const p of PRESETS) {
      const e = project();
      const id = addShape(e, p, 45);
      const clip = e.timeline.clips[id];
      expect(clip.content.kind).toBe("graphic");
      expect(e.timeline.trackIds[0]).toBe(clip.trackId);
      expect(clip.timelineStart).toBe(45);
      expect([...e.selection.selectedClipIds]).toEqual([id]);
      expect(resolveFrame(e.timeline, 45, ctx()).layers.map((l) => l.clipId)).toEqual([id]);
      e.undo();
      expect(e.timeline.clips[id]).toBeUndefined();
      expect(e.timeline.trackIds).toHaveLength(0);
    }
  });
  it("presets: rounded rect has a radius, circle is round, line/arrow are stroked open shapes", () => {
    expect(shapePreset("rounded-rect", 1920, 1080).cornerRadius).toBeGreaterThan(0);
    const c = shapePreset("circle", 1080, 1920);
    expect(c.width).toBe(c.height);
    for (const p of ["line", "arrow"] as const) expect(shapePreset(p, 1920, 1080)).toMatchObject({ stroke: true, fill: false });
  });
  it("SVG graphics are created from sanitized embedded markup", () => {
    const e = project();
    const id = addSvg(e);
    const c = e.timeline.clips[id].content as { svg: { markup: string; intrinsicWidth: number } };
    expect(c.svg.markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(c.svg.intrinsicWidth).toBe(100);
    expect(layerOf(e.timeline, id).content.type).toBe("svg");
  });
});

describe("edit", () => {
  it("patches are normalized; edits are immutable", () => {
    const e = project();
    const id = addShape(e, "polygon");
    const before = e.timeline.clips[id].content;
    e.updateAuthoredContent(id, { shape: { sides: 99, fillColor: "#123456", cornerRadius: -5 } });
    expect(shapeOf(e.timeline, id)).toMatchObject({ sides: 64, fillColor: "#123456", cornerRadius: 0 });
    expect((before as { shape: ShapeSpec }).shape.sides).toBe(6);
    expect(() => e.updateAuthoredContent(id, { svg: { tint: true } })).not.toThrow();
    expect(e.updateAuthoredContent(id, { svg: { tint: true } }).ok).toBe(false); // svg patch on a shape: typed error
  });
});

describe("resize", () => {
  it("handle resize changes the shape's OWN size — stroke and radius stay as authored, opposite corner pinned", () => {
    const e = project();
    const id = addShape(e, { type: "rect", width: 400, height: 200, stroke: true, strokeWidth: 10, cornerRadius: 20 });
    const l = layerOf(e.timeline, id);
    const nw = handleCompPoints(l.visual, l.box).nw;
    const r = graphicResize({ graphic: { kind: "shape", shape: shapeOf(e.timeline, id) }, visual: l.visual, box: l.box, handle: "se", pointer: { x: nw.x + 800, y: nw.y + 400 }, freeAspect: false, fromAnchor: false });
    e.editClips({ [id]: r.edit });
    const s = shapeOf(e.timeline, id);
    expect([s.width, s.height]).toEqual([800, 400]);
    expect(s.strokeWidth).toBe(10);
    expect(s.cornerRadius).toBe(20);
    const after = layerOf(e.timeline, id);
    expect(after.visual.transform.scaleX).toBe(1);
    const nw2 = handleCompPoints(after.visual, after.box).nw;
    expect(nw2.x).toBeCloseTo(nw.x, 6);
    expect(nw2.y).toBeCloseTo(nw.y, 6);
    e.undo();
    expect(shapeOf(e.timeline, id).width).toBe(400); // one undo step
  });
  it("Shift frees the aspect on corners; lines ignore vertical resizing", () => {
    const e = project();
    const id = addShape(e, { type: "ellipse", width: 300, height: 300 });
    const l = layerOf(e.timeline, id);
    const nw = handleCompPoints(l.visual, l.box).nw;
    const free = graphicResize({ graphic: { kind: "shape", shape: shapeOf(e.timeline, id) }, visual: l.visual, box: l.box, handle: "se", pointer: { x: nw.x + 600, y: nw.y + 150 }, freeAspect: true, fromAnchor: false });
    expect([Math.round(free.box.width), Math.round(free.box.height)]).toEqual([600, 150]);
    const line = addShape(e, "line");
    const ll = layerOf(e.timeline, line);
    const ln = graphicResize({ graphic: { kind: "shape", shape: shapeOf(e.timeline, line) }, visual: ll.visual, box: ll.box, handle: "se", pointer: { x: 1900, y: 1000 }, freeAspect: true, fromAnchor: false });
    expect(ln.box.height).toBe(ll.box.height);
    expect(ln.box.width).toBeGreaterThan(ll.box.width);
  });
  it("SVG resizes its box (re-rasterized at the new size, never a stretched bitmap)", () => {
    const e = project();
    const id = addSvg(e);
    const l = layerOf(e.timeline, id);
    const r = graphicResize({ graphic: { kind: "svg", svg: (l.content as Extract<ResolvedLayer["content"], { type: "svg" }>).svg }, visual: l.visual, box: l.box, handle: "e", pointer: { x: handleCompPoints(l.visual, l.box).e.x + 300, y: 540 }, freeAspect: false, fromAnchor: false });
    e.editClips({ [id]: r.edit });
    const w = l.width + 300; // dragged the east handle 300px right
    expect(layerOf(e.timeline, id).width).toBeCloseTo(w, 6);
    expect(svgRasterSizeFor(layerOf(e.timeline, id), 1, "final").width).toBe(Math.ceil(w));
  });
});

describe("rotate / move / opacity", () => {
  it("use the shared transform system", () => {
    const e = project();
    const id = addShape(e, { type: "rect", width: 400, height: 100 });
    e.setClipVisual(id, { transform: { rotation: 90, x: 500, y: 300 }, opacity: 0.4 });
    const l = layerOf(e.timeline, id);
    const c = applyToPoint(l.matrix, { x: 200, y: 50 });
    expect([c.x, c.y].map((n) => Math.round(n))).toEqual([500, 300]);
    expect(l.bounds.height).toBeCloseTo(400, 6);
    const fill = draw(e.timeline).calls.find((x) => x.op === "fill")!;
    expect(fill.state.globalAlpha).toBeCloseTo(0.4, 9);
  });
});

describe("duplicate / delete / reorder", () => {
  it("duplicate is an independent copy with a new id; delete and reorder are undoable", () => {
    const e = project();
    const a = addShape(e, "rect");
    const dup = e.duplicateClipsAsLayers([a], { x: 24, y: 24 });
    if (!dup.ok) throw dup.error;
    const b = dup.clips[0].id;
    expect(b).not.toBe(a);
    e.updateAuthoredContent(b, { shape: { fillColor: "#00ff00" } });
    expect(shapeOf(e.timeline, a).fillColor).not.toBe("#00ff00");
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([a, b]);
    e.reorderTrack(e.timeline.clips[a].trackId, 0);
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([b, a]);
    e.deleteClips([b]);
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([a]);
    e.undo();
    expect(e.timeline.clips[b]).toBeDefined();
  });
});

describe("fill / stroke / shadow drawing", () => {
  it("rect: fill with color, stroke inset inside the box, rounded corners", () => {
    const e = project();
    const id = addShape(e, { type: "rect", width: 400, height: 200, fillColor: "#ff0000", stroke: true, strokeColor: "#0000ff", strokeWidth: 10, cornerRadius: 30 });
    const { calls } = draw(e.timeline, [id]);
    expect(calls.find((c) => c.op === "roundRect")!.args).toEqual([5, 5, 390, 190, 30]);
    expect(calls.find((c) => c.op === "fill")!.state.fillStyle).toBe("#ff0000");
    expect(calls.find((c) => c.op === "stroke")!.state).toMatchObject({ strokeStyle: "#0000ff", lineWidth: 10 });
  });
  it("fill/stroke toggles keep their colors when off", () => {
    const e = project();
    const id = addShape(e, { type: "ellipse", fill: false, fillColor: "#abcdef", stroke: true, strokeWidth: 4 });
    const { calls } = draw(e.timeline, [id]);
    expect(calls.some((c) => c.op === "fill")).toBe(false);
    expect(calls.some((c) => c.op === "stroke")).toBe(true);
    expect(shapeOf(e.timeline, id).fillColor).toBe("#abcdef");
  });
  it("polygon: N vertices, first at the top", () => {
    const e = project();
    const id = addShape(e, { type: "polygon", width: 200, height: 200, sides: 5 });
    const { calls } = draw(e.timeline, [id]);
    const moves = calls.filter((c) => c.op === "moveTo" || c.op === "lineTo");
    expect(moves).toHaveLength(5);
    expect(moves[0].args.map((n) => Math.round(n as number))).toEqual([100, 0]);
  });
  it("arrow: shaft stops at the head; head filled with the stroke color", () => {
    const e = project();
    const id = addShape(e, { type: "arrow", width: 500, strokeWidth: 8, headSize: 40, strokeColor: "#facc15", arrowHead: "end" });
    const { calls } = draw(e.timeline, [id]);
    const shaft = calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").slice(0, 2).map((c) => c.args[0]);
    expect(shaft).toEqual([0, 460]);
    const headFill = calls.find((c) => c.op === "fill")!;
    expect(headFill.state.fillStyle).toBe("#facc15");
    expect(lineBoxHeight(shapeOf(e.timeline, id))).toBe(40);
  });
  it("shadow: cast by ONE pass (fill), mapped through the matrix and render scale", () => {
    const e = project();
    const id = addShape(e, { type: "rect", stroke: true, strokeWidth: 6, shadow: true, shadowBlur: 20, shadowOffsetX: 10, shadowOffsetY: 0 });
    e.setClipVisual(id, { transform: { rotation: 90 } });
    const { calls } = draw(e.timeline, [id], 0, 0.5);
    const fill = calls.find((c) => c.op === "fill")!;
    expect(fill.state.shadowOffsetX).toBeCloseTo(0, 9);
    expect(fill.state.shadowOffsetY).toBeCloseTo(5, 9); // +x rotated 90° = down, x0.5 render scale
    expect(fill.state.shadowBlur).toBeCloseTo(10, 9);
    expect(calls.find((c) => c.op === "stroke")!.state.shadowBlur).toBe(0);
  });
  it("SVG: drawn from its raster with shadow; skipped (not crashed) while the raster is pending in preview", () => {
    const e = project();
    const id = addSvg(e);
    e.updateAuthoredContent(id, { svg: { shadow: true } });
    const raster = img(300, 300);
    const { calls } = draw(e.timeline, [id], 0, 1, new Map([[id, { image: raster }]]));
    const di = calls.find((c) => c.op === "drawImage")!;
    expect(di.args[0]).toBe(raster);
    expect(di.state.shadowBlur).toBeGreaterThan(0);
    expect(() => draw(e.timeline, [id])).not.toThrow();
  });
});

describe("timeline duration", () => {
  it("graphics render only during [start, end); trim extends", () => {
    const e = project();
    const a = addShape(e, "rect", 0, 90);
    const b = addShape(e, "circle", 90, 90);
    const at = (f: number) => resolveFrame(e.timeline, f, ctx()).layers.map((l) => l.clipId);
    expect(at(89)).toEqual([a]);
    expect(at(90)).toEqual([b]);
    e.trimClip(a, "end", 120);
    expect(at(100).sort()).toEqual([a, b].sort());
  });
});

describe("save / reload", () => {
  it("every shape type and an SVG round-trip exactly and render identically", () => {
    const e = project({ width: 1080, height: 1920 });
    const ids = PRESETS.map((p, i) => addShape(e, p, i * 5));
    e.updateAuthoredContent(ids[0], { shape: { shadow: true, stroke: true, strokeColor: "#ff00ff" } });
    ids.push(addSvg(e));
    e.updateAuthoredContent(ids[ids.length - 1], { svg: { tint: true, tintColor: "#00ff00" } });
    e.setClipVisual(ids[2], { transform: { rotation: 33 }, opacity: 0.7 });
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    for (const id of ids) {
      expect(loaded.clips[id]).toEqual(JSON.parse(JSON.stringify(e.timeline.clips[id])));
      const a = layerOf(e.timeline, id, 40);
      const b = layerOf(loaded, id, 40);
      expect(b.matrix).toEqual(a.matrix);
      expect(b.content).toEqual(a.content);
    }
  });
  it("migrates v3 shapes (fill/stroke as color strings) and rejects invalid embedded SVG", () => {
    const e = project();
    const id = addShape(e, "rect");
    const p = JSON.parse(serializeTimeline(e.timeline));
    p.version = 3;
    p.timeline.clips[id].content.shape = { type: "rect", width: 100, height: 50, fill: "#112233", stroke: "#ffffff", strokeWidth: 4, cornerRadius: 0 };
    const s = (deserializeTimeline(JSON.stringify(p)).clips[id].content as { shape: ShapeSpec }).shape;
    expect(s).toMatchObject({ fill: true, fillColor: "#112233", stroke: true, strokeColor: "#ffffff" });
    const noFill = JSON.parse(JSON.stringify(p));
    noFill.timeline.clips[id].content.shape = { type: "ellipse", width: 10, height: 10, stroke: "#000", strokeWidth: 2, cornerRadius: 0 };
    expect((deserializeTimeline(JSON.stringify(noFill)).clips[id].content as { shape: ShapeSpec }).shape.fill).toBe(false);
    const bad = project();
    const sid = addSvg(bad);
    const q = JSON.parse(serializeTimeline(bad.timeline));
    q.timeline.clips[sid].content.svg.markup = "not svg";
    expect(() => deserializeTimeline(JSON.stringify(q))).toThrow(/invalid embedded SVG/);
  });
});

describe("undo / redo", () => {
  it("every graphic operation is one step and replays exactly", () => {
    const e = project();
    const id = addShape(e, "rect");
    const ops: (() => void)[] = [
      () => e.updateAuthoredContent(id, { shape: { fillColor: "#ff0000" } }),
      () => e.updateAuthoredContent(id, { shape: { stroke: true, strokeWidth: 9 } }),
      () => e.updateAuthoredContent(id, { shape: { shadow: true } }),
      () => e.updateAuthoredContent(id, { shape: { cornerRadius: 24 } }),
      () => e.editClips({ [id]: { content: { shape: { width: 900 } }, visual: { transform: { x: 700 } } } }),
      () => e.setClipVisual(id, { transform: { rotation: 15 }, opacity: 0.5 }),
      () => void e.duplicateClipsAsLayers([id]),
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

describe("multiple graphics + compositing over other layers", () => {
  it("over video, over a matted transparent subject, and over text — paint order follows the stack", () => {
    let tl = createTimeline(30, { width: 1920, height: 1080 });
    const tracks: Record<string, string> = {};
    // front-to-back: arrow (over text), text, star SVG (over transparent subject), cutout (matted), circle (over video), video
    for (const [name, kind] of [["arrow", "graphic"], ["text", "text"], ["svg", "graphic"], ["cutout", "video"], ["circle", "graphic"], ["video", "video"]] as const) {
      const t = addTrack(tl, kind, name);
      tl = t.timeline;
      tracks[name] = t.track.id;
    }
    const put = (name: string, content: Parameters<typeof insertClip>[2]) => {
      const r = insertClip(tl, tracks[name], content, 0);
      tl = r.timeline;
      return r.clip.id;
    };
    const video = put("video", { kind: "video", source: { sourceId: "video" }, sourceInFrame: 0, sourceOutFrame: 30 });
    const circle = put("circle", { kind: "graphic", shape: shapePreset("circle", 1920, 1080), durationFrames: 30 });
    const cutout = put("cutout", { kind: "video", source: { sourceId: "cutout" }, sourceInFrame: 0, sourceOutFrame: 30 });
    tl = setClipVisual(tl, cutout, { matte: { sourceId: "matte", invert: false } });
    const svg = put("svg", { kind: "graphic", svg: svgSpecFromMarkup(GRAPHICS_LIBRARY[1].markup, 300), durationFrames: 30 });
    const text = put("text", { kind: "text", text: "TITLE", textStyle: normalizeTextStyle({}), durationFrames: 30 });
    const arrow = put("arrow", { kind: "graphic", shape: shapePreset("arrow", 1920, 1080), durationFrames: 30 });
    const { calls, frame } = draw(tl, undefined, 0, 1, new Map([[video, { image: img(1920, 1080) }], [cutout, { image: img(800, 1200), matte: img(400, 600) }], [svg, { image: img(300, 300) }]]));
    expect(frame.layers.map((l) => l.clipId)).toEqual([video, circle, cutout, svg, text, arrow]);
    const seq = calls.filter((c) => ["drawImage", "fill", "fillText", "stroke"].includes(c.op)).map((c) => c.op);
    // video, circle fill, matted cutout composite, svg, text, arrow shaft stroke + head fill
    expect(seq).toEqual(["drawImage", "fill", "drawImage", "drawImage", "fillText", "stroke", "fill"]);
  });
});

describe("SVG import safety and sizing", () => {
  it("strips scripts, event handlers, external refs and entity declarations; keeps internal refs", () => {
    const dirty = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(3)"><rect width="10" height="10" onclick="alert(4)"/></a><use href="#r"/><image href="https://evil.example/x.png"/><rect style="fill:url(https://evil.example/f)"/></svg>`;
    const clean = sanitizeSvg(dirty);
    for (const bad of ["<script", "onload", "onclick", "javascript:", "foreignObject", "ENTITY", "evil.example"]) expect(clean).not.toContain(bad);
    expect(clean).toContain('href="#r"');
    expect(clean).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it("rejects non-SVG and oversized input", () => {
    expect(() => sanitizeSvg("<html></html>")).toThrow(SvgImportError);
    expect(() => sanitizeSvg("<svg>" + "x".repeat(1024 * 1024 + 1) + "</svg>")).toThrow(/too large/);
  });
  it("intrinsic size from width/height, then viewBox, then a default", () => {
    expect(svgIntrinsicSize('<svg width="200" height="50">')).toEqual({ width: 200, height: 50 });
    expect(svgIntrinsicSize('<svg viewBox="0 0 30 60">')).toEqual({ width: 30, height: 60 });
    expect(svgIntrinsicSize('<svg width="300" viewBox="0 0 30 60">')).toEqual({ width: 300, height: 600 });
    expect(svgIntrinsicSize('<svg width="100%">')).toEqual({ width: 100, height: 100 });
  });
  it("rasterizes at the target pixel size, keeping the viewBox", () => {
    const at = svgAtSize('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', 640, 320, { width: 10, height: 10 });
    expect(at).toMatch(/<svg width="640" height="320" preserveAspectRatio="none" viewBox="0 0 10 10"/);
  });
  it("raster sizes: final exact, preview quantized UP (never blurry), capped", () => {
    expect(svgRasterSize(300, 300, 2, 2, "final")).toEqual({ width: 600, height: 600 });
    const p = svgRasterSize(300, 300, 2, 2, "preview");
    expect(p.width).toBeGreaterThanOrEqual(600);
    expect(p.width).toBeLessThan(600 * 1.25 + 1);
    expect(svgRasterSize(100000, 10, 1, 1, "final").width).toBe(4096);
  });
});

describe("error handling", () => {
  it("garbage shape values render with defaults instead of crashing", () => {
    let tl = createTimeline(30);
    const t = addTrack(tl, "graphic", "g");
    tl = insertClip(t.timeline, t.track.id, { kind: "graphic", shape: { type: "hexagon", width: "big", sides: NaN } as never, durationFrames: 5 }, 0).timeline;
    expect(() => resolveFrame(tl, 0, ctx())).not.toThrow();
    const layer = resolveFrame(tl, 0, ctx()).layers[0];
    expect(layer.content.type === "shape" && layer.content.shape).toMatchObject({ type: "rect", sides: 6 });
  });
  it("a new-style partial spec keeps what it says (no accidental legacy migration)", () => {
    expect(normalizeShapeSpec({ type: "rect", stroke: true, strokeWidth: 6 })).toMatchObject({ stroke: true, fill: true });
    expect(normalizeShapeSpec({ type: "rect", strokeWidth: 6, cornerRadius: 4 })).toMatchObject({ fill: true });
    expect(normalizeShapeSpec({ fill: "#123456" })).toMatchObject({ fill: true, fillColor: "#123456" }); // an unambiguous v1 color string still migrates
  });
  it("a line can't be made invisible by turning its stroke off", () => {
    expect(normalizeShapeSpec({ type: "line", stroke: false, fill: true })).toMatchObject({ stroke: true, fill: false });
  });
});
