import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTextLayer, addTrack, duplicateClipsAsLayers, insertClip, setClipVisual, setCompositionSettings, updateAuthoredContent, deleteClips } from "../timeline/operations";
import { normalizeTextStyle, patchTextStyle, DEFAULT_TEXT_STYLE, type TextStyle } from "../timeline/text-style";
import { deserializeTimeline, serializeTimeline } from "../timeline/serialize";
import { cachedTextLayout, resolveClipLayer, resolveFrame, type ResolvedLayer } from "../composition/resolve";
import { layoutText, lineBaseline, lineX, cssFont } from "../composition/text-layout";
import { drawResolvedFrame, type Ctx2D } from "../composition/draw";
import { applyToPoint } from "../composition/matrix";
import { fakeContext, monoMeasurer } from "../composition/test-helpers";
import { handleCompPoints } from "../composition/transform-tools";
import { resolveFont, cssFontString, FONT_FACES } from "./font-registry";
import { textResize } from "./text-transform";

/**
 * PHASE 6 — TEXT & TYPOGRAPHY acceptance suite. Numbered to match the
 * required test list. Geometry is asserted through resolveFrame/layoutText
 * (what the renderers use) and drawing through a recording 2D context
 * (what actually gets painted, in which order, with which state).
 */

const ctx = () => fakeContext({ bg: { width: 1920, height: 1080 }, cutout: { width: 800, height: 1200 }, matte: { width: 400, height: 600 } });

function project(comp = { width: 1920, height: 1080 }) {
  const e = new TimelineEngine(30, { ...comp, background: "#000000" });
  return e;
}

function addText(e: TimelineEngine, text = "Hello world", style: Parameters<typeof patchTextStyle>[1] = {}, atFrame = 0, durationFrames = 90) {
  const r = e.addTextLayer({ text, atFrame, durationFrames, style });
  if (!r.ok) throw r.error;
  return r.clip.id;
}

const layerOf = (tl: TimelineModel, id: string, frame = 0): ResolvedLayer => resolveClipLayer(tl, id, frame, ctx())!;
const styleOf = (tl: TimelineModel, id: string): TextStyle => {
  const c = tl.clips[id].content;
  if (c.kind !== "text") throw new Error("not text");
  return normalizeTextStyle(c.textStyle);
};

/** Recording 2D context with configurable native letterSpacing support. Logs draw calls with the state in effect. */
function recorder(opts: { nativeLetterSpacing?: boolean } = {}) {
  type Call = { op: string; args: unknown[]; state: Record<string, unknown> };
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "", shadowColor: "transparent", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, textAlign: "start", textBaseline: "alphabetic", imageSmoothingEnabled: true, imageSmoothingQuality: "low", lineJoin: "miter", miterLimit: 10 };
  if (opts.nativeLetterSpacing) state.letterSpacing = "0px";
  const target = { canvas: { width: 1920, height: 1080 } };
  const proxy = new Proxy(target, {
    has(_t, p) {
      return p in state || p === "canvas";
    },
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

function drawOnly(tl: TimelineModel, ids: string[], frame = 0, renderScale = 1, opts: { nativeLetterSpacing?: boolean } = {}) {
  const f = resolveFrame(tl, frame, ctx());
  const r = recorder(opts);
  drawResolvedFrame(r.ctx, { ...f, layers: f.layers.filter((l) => ids.includes(l.clipId)) }, new Map(), { renderScale, smoothing: "high", getScratch: () => r.ctx });
  return r.calls;
}

describe("1. create text layer", () => {
  it("adds an editable (not rasterized) text clip on its own front track, at the playhead, selected, one undo step", () => {
    const e = project();
    addTrack; // (engine wraps the op)
    const before = e.timeline.trackIds.length;
    const id = addText(e, "Type something...", {}, 45);
    const clip = e.timeline.clips[id];
    expect(clip.content).toMatchObject({ kind: "text", text: "Type something..." });
    expect(e.timeline.trackIds[0]).toBe(clip.trackId);
    expect(e.timeline.trackIds.length).toBe(before + 1);
    expect(clip.timelineStart).toBe(45);
    expect([...e.selection.selectedClipIds]).toEqual([id]);
    e.undo();
    expect(e.timeline.clips[id]).toBeUndefined();
    expect(e.timeline.trackIds.length).toBe(before);
  });
});

describe("2. edit text", () => {
  it("changes content and re-lays out; the content object is replaced, never mutated", () => {
    const e = project();
    const id = addText(e, "One");
    const original = e.timeline.clips[id].content;
    e.updateAuthoredContent(id, { text: "One\nTwo" });
    expect(layerOf(e.timeline, id).content.type === "text" && (layerOf(e.timeline, id).content as { layout: { lines: unknown[] } }).layout.lines).toHaveLength(2);
    expect((original as { text: string }).text).toBe("One");
  });
});

describe("3. delete text", () => {
  it("deletes the clip (undoable) and it no longer renders", () => {
    const e = project();
    const id = addText(e);
    e.deleteClips([id]);
    expect(resolveFrame(e.timeline, 0, ctx()).layers).toHaveLength(0);
    e.undo();
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([id]);
  });
});

describe("4. duplicate text", () => {
  it("creates a new unique id; editing the copy never touches the original", () => {
    const e = project();
    const id = addText(e, "Original", { color: "#ff0000" });
    const r = e.duplicateClipsAsLayers([id], { x: 24, y: 24 });
    if (!r.ok) throw r.error;
    const copy = r.clips[0].id;
    expect(copy).not.toBe(id);
    e.updateAuthoredContent(copy, { text: "Copy", textStyle: { color: "#00ff00" } });
    expect(e.timeline.clips[id].content).toMatchObject({ text: "Original" });
    expect(styleOf(e.timeline, id).color).toBe("#ff0000");
    expect(styleOf(e.timeline, copy).color).toBe("#00ff00");
  });
});

describe("5. change font (and the font registry)", () => {
  it("registry ids resolve to bundled CSS stacks with a generic fallback", () => {
    for (const f of FONT_FACES) {
      const r = resolveFont({ fontFamily: f.id, fontWeight: f.weights[0], fontStyle: "normal" });
      expect(r.cssFamily).toMatch(/(sans-serif|serif|monospace|cursive)$/);
      expect(r.status).toBe("ok");
    }
    const e = project();
    const id = addText(e);
    e.updateAuthoredContent(id, { textStyle: { fontFamily: "playfair" } });
    expect(cssFont(styleOf(e.timeline, id))).toContain("Playfair Display");
  });
});

describe("6. font size", () => {
  it("scales the laid-out box linearly", () => {
    const s1 = normalizeTextStyle({ fontSize: 50 });
    const s2 = normalizeTextStyle({ fontSize: 100 });
    const a = layoutText("Hello", s1, monoMeasurer);
    const b = layoutText("Hello", s2, monoMeasurer);
    expect(b.width).toBeCloseTo(a.width * 2, 9);
    expect(b.height).toBeCloseTo(a.height * 2, 9);
  });
  it("clamps absurd sizes instead of breaking layout", () => {
    expect(normalizeTextStyle({ fontSize: 1e9 }).fontSize).toBe(2000);
    expect(normalizeTextStyle({ fontSize: -4 }).fontSize).toBe(1);
    expect(normalizeTextStyle({ fontSize: NaN }).fontSize).toBe(DEFAULT_TEXT_STYLE.fontSize);
  });
});

describe("7. font weight", () => {
  it("normalizes to 100-steps and substitutes the nearest SHIPPED weight (no faux bold)", () => {
    expect(normalizeTextStyle({ fontWeight: 651 }).fontWeight).toBe(700);
    const r = resolveFont({ fontFamily: "poppins", fontWeight: 400, fontStyle: "normal" }); // poppins ships only 700
    expect(r.weight).toBe(700);
    expect(r.status).toBe("weight-substituted");
    expect(r.warnings[0]).toMatch(/700/);
    expect(resolveFont({ fontFamily: "geist", fontWeight: 300, fontStyle: "normal" }).weight).toBe(300); // variable font
  });
});

describe("8. color", () => {
  it("fills glyphs with the text color", () => {
    const e = project();
    const id = addText(e, "Hi", { color: "#12ab34" });
    const fills = drawOnly(e.timeline, [id]).filter((c) => c.op === "fillText");
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((c) => c.state.fillStyle === "#12ab34")).toBe(true);
  });
});

describe("9. alignment", () => {
  const base = { sizing: "box" as const, boxWidth: 400 };
  it("left/center/right position lines inside the content box", () => {
    const line = { text: "abc", width: 90, paragraphEnd: true };
    for (const [align, x] of [["left", 0], ["center", 155], ["right", 310]] as const) {
      const s = normalizeTextStyle({ ...base, textAlign: align, fontSize: 60 });
      const l = layoutText("abc", s, monoMeasurer);
      expect(lineX(l, s, line)).toBe(x);
    }
  });
  it("justify stretches word gaps on wrapped lines to the full width, never the last line", () => {
    const e = project();
    const id = addText(e, "aa bb cc dd ee ff gg hh ii jj kk ll", { sizing: "box", boxWidth: 300, textAlign: "justify", fontSize: 20 }); // 350px of text in a 300px box -> 2 lines
    const fills = drawOnly(e.timeline, [id]).filter((c) => c.op === "fillText");
    const lines = new Map<number, { text: string; x: number }[]>();
    for (const f of fills) {
      const y = f.args[2] as number;
      lines.set(y, [...(lines.get(y) ?? []), { text: f.args[0] as string, x: f.args[1] as number }]);
    }
    const ys = [...lines.keys()].sort((a, b) => a - b);
    const first = lines.get(ys[0])!;
    // recorder measures 10px/char: last word ends exactly at the right edge (300) on a justified line
    const last = first[first.length - 1];
    expect(last.x + last.text.length * 10).toBeCloseTo(300, 6);
    // last line of the paragraph is drawn as one left-aligned run
    expect(lines.get(ys[ys.length - 1])!.length).toBe(1);
  });
  it("vertical alignment offsets lines inside a taller fixed box", () => {
    const s = (v: "top" | "middle" | "bottom") => normalizeTextStyle({ sizing: "box", boxWidth: 400, boxHeight: 300, verticalAlign: v, fontSize: 50, lineHeight: 1 });
    expect(layoutText("x", s("top"), monoMeasurer).contentTop).toBe(0);
    expect(layoutText("x", s("middle"), monoMeasurer).contentTop).toBe(125);
    expect(layoutText("x", s("bottom"), monoMeasurer).contentTop).toBe(250);
  });
});

describe("10. line height", () => {
  it("sets the baseline-to-baseline distance; baselines sit in a half-leading model", () => {
    const s = normalizeTextStyle({ fontSize: 100, lineHeight: 1.5 });
    const l = layoutText("a\nb", s, monoMeasurer);
    expect(l.lineHeightPx).toBe(150);
    expect(lineBaseline(l, 1) - lineBaseline(l, 0)).toBe(150);
    // ascent 80 + descent 20 = 100 em box, half-leading 25 -> first baseline at 25 + 80
    expect(lineBaseline(l, 0)).toBe(105);
  });
});

describe("11. letter spacing", () => {
  it("is included in measurement (between glyphs, not trailing)", () => {
    const s0 = normalizeTextStyle({ fontSize: 20 });
    const s5 = normalizeTextStyle({ fontSize: 20, letterSpacing: 5 });
    expect(layoutText("abcd", s5, monoMeasurer).width - layoutText("abcd", s0, monoMeasurer).width).toBe(15);
  });
  it("uses native ctx.letterSpacing when available, per-grapheme advances otherwise", () => {
    const e = project();
    const id = addText(e, "ab", { letterSpacing: 7 });
    const native = drawOnly(e.timeline, [id], 0, 1, { nativeLetterSpacing: true }).filter((c) => c.op === "fillText");
    expect(native).toHaveLength(1);
    expect(native[0].state.letterSpacing).toBe("7px");
    const fallback = drawOnly(e.timeline, [id], 0, 1, { nativeLetterSpacing: false }).filter((c) => c.op === "fillText");
    expect(fallback.map((c) => c.args[0])).toEqual(["a", "b"]);
    expect((fallback[1].args[1] as number) - (fallback[0].args[1] as number)).toBe(10 + 7);
  });
});

describe("12. multiline", () => {
  it("manual line breaks (\\n, \\r\\n) start new paragraphs; blank lines are kept", () => {
    const l = layoutText("a\r\nb\n\nc", normalizeTextStyle({}), monoMeasurer);
    expect(l.lines.map((x) => x.text)).toEqual(["a", "b", "", "c"]);
    expect(l.lines.every((x) => x.paragraphEnd)).toBe(true);
  });
});

describe("13. wrapping", () => {
  it("box text wraps at the box width (minus padding)", () => {
    const s = normalizeTextStyle({ sizing: "box", boxWidth: 140, padding: 10, fontSize: 20 }); // 10px/char, 120px content
    const l = layoutText("aaaa bbbb cccc", s, monoMeasurer);
    expect(l.lines.map((x) => x.text)).toEqual(["aaaa bbbb", "cccc"]);
    expect(l.width).toBe(140);
  });
  it("breaks a word longer than the box at grapheme boundaries (URLs, CJK, emoji never overflow or split mid-cluster)", () => {
    const s = normalizeTextStyle({ sizing: "box", boxWidth: 50, fontSize: 20 }); // 5 chars per line
    expect(layoutText("abcdefghijkl", s, monoMeasurer).lines.map((x) => x.text)).toEqual(["abcde", "fghij", "kl"]);
    const emoji = layoutText("👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽", s, monoMeasurer).lines.map((x) => x.text);
    expect(emoji.join("")).toBe("👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽");
    for (const line of emoji) expect(line.length % "👍🏽".length).toBe(0); // no skin-tone modifier split from its emoji
  });
  it("point text only wraps at maxWidth", () => {
    expect(layoutText("aaaa bbbb", normalizeTextStyle({ fontSize: 20 }), monoMeasurer).lines).toHaveLength(1);
    expect(layoutText("aaaa bbbb", normalizeTextStyle({ fontSize: 20, maxWidth: 50 }), monoMeasurer).lines).toHaveLength(2);
  });
});

describe("14. text background", () => {
  it("draws a rounded box sized to the content, with its own opacity, behind the glyphs", () => {
    const e = project();
    const id = addText(e, "BREAKING NEWS", { background: true, backgroundColor: "#000000", backgroundOpacity: 0.8, padding: 20, borderRadius: 10, fontSize: 40 });
    const calls = drawOnly(e.timeline, [id]);
    const rr = calls.find((c) => c.op === "roundRect")!;
    const l = layerOf(e.timeline, id).content as { layout: { width: number; height: number } };
    expect(rr.args).toEqual([0, 0, l.layout.width, l.layout.height, 10]);
    const fill = calls.find((c) => c.op === "fill")!;
    expect(fill.state.globalAlpha).toBeCloseTo(0.8, 9);
    expect(calls.findIndex((c) => c.op === "fill")).toBeLessThan(calls.findIndex((c) => c.op === "fillText"));
    // auto-resizes with content
    const w1 = l.layout.width;
    e.updateAuthoredContent(id, { text: "BREAKING NEWS TODAY" });
    expect((layerOf(e.timeline, id).content as { layout: { width: number } }).layout.width).toBeGreaterThan(w1);
  });
});

describe("15. stroke", () => {
  it("strokes before filling, at 2x width so exactly strokeWidth shows outside the glyph", () => {
    const e = project();
    const id = addText(e, "Hi", { stroke: true, strokeColor: "#ff00ff", strokeWidth: 6 });
    const calls = drawOnly(e.timeline, [id]);
    const s = calls.find((c) => c.op === "strokeText")!;
    expect(s.state).toMatchObject({ strokeStyle: "#ff00ff", lineWidth: 12 });
    expect(calls.indexOf(s)).toBeLessThan(calls.findIndex((c) => c.op === "fillText"));
    const off = addText(e, "Hi", { stroke: false, strokeWidth: 6 });
    expect(drawOnly(e.timeline, [off]).some((c) => c.op === "strokeText")).toBe(false);
  });
});

describe("16. shadow", () => {
  it("offset rotates/scales with the layer and the render scale; cast by one pass only", () => {
    const e = project();
    const id = addText(e, "Hi", { shadow: true, shadowColor: "#000", shadowBlur: 10, shadowOffsetX: 8, shadowOffsetY: 0, stroke: true });
    let calls = drawOnly(e.timeline, [id], 0, 0.5);
    const strokes = calls.filter((c) => c.op === "strokeText");
    expect(strokes[0].state.shadowOffsetX).toBeCloseTo(4, 9); // 8 * 0.5 render scale
    expect(strokes[0].state.shadowBlur).toBeCloseTo(5, 9);
    expect(calls.filter((c) => c.op === "fillText").every((c) => c.state.shadowBlur === 0)).toBe(true); // fill doesn't double it
    e.setClipVisual(id, { transform: { rotation: 90 } });
    calls = drawOnly(e.timeline, [id], 0, 1);
    const s = calls.find((c) => c.op === "strokeText")!;
    expect(s.state.shadowOffsetX).toBeCloseTo(0, 9);
    expect(s.state.shadowOffsetY).toBeCloseTo(8, 9); // +x offset rotated 90° clockwise points down
  });
});

describe("17. move text", () => {
  it("moves via the generic transform (bounds shift exactly)", () => {
    const e = project();
    const id = addText(e);
    const b0 = layerOf(e.timeline, id).bounds;
    e.setClipVisual(id, { transform: { x: 960 + 100, y: 540 - 50 } });
    const b1 = layerOf(e.timeline, id).bounds;
    expect([b1.x - b0.x, b1.y - b0.y]).toEqual([100, -50]);
  });
});

describe("18. resize text box", () => {
  it("side handle re-wraps (box width) without scaling glyphs, pinning the opposite top edge", () => {
    const e = project();
    const id = addText(e, "aaaa bbbb cccc dddd", { fontSize: 20 });
    const l = layerOf(e.timeline, id);
    const s = styleOf(e.timeline, id);
    const pinnedBefore = handleCompPoints(l.visual, l.box).nw;
    const r = textResize({ text: "aaaa bbbb cccc dddd", style: s, visual: l.visual, box: l.box, handle: "e", pointer: { x: pinnedBefore.x + 100, y: 0 }, fromAnchor: false, measurer: monoMeasurer });
    e.editClips({ [id]: r.edit });
    const after = layerOf(e.timeline, id);
    const st = styleOf(e.timeline, id);
    expect(st.sizing).toBe("box");
    expect(st.boxWidth).toBeCloseTo(100, 6);
    expect(st.fontSize).toBe(20); // glyphs untouched
    expect(after.visual.transform.scaleX).toBe(1);
    expect((after.content as { layout: { lines: unknown[] } }).layout.lines.length).toBeGreaterThan(1);
    const pinnedAfter = handleCompPoints(after.visual, after.box).nw;
    expect(pinnedAfter.x).toBeCloseTo(pinnedBefore.x, 6);
    expect(pinnedAfter.y).toBeCloseTo(pinnedBefore.y, 6);
    e.undo();
    expect(styleOf(e.timeline, id).sizing).toBe("point"); // one undo step for content+position
  });
  it("corner handle scales typography (crisp re-layout), never the transform", () => {
    const e = project();
    const id = addText(e, "Hello", { fontSize: 40, padding: 10, strokeWidth: 4, stroke: true });
    const l = layerOf(e.timeline, id);
    const se = handleCompPoints(l.visual, l.box).se;
    const nw = handleCompPoints(l.visual, l.box).nw;
    const r = textResize({ text: "Hello", style: styleOf(e.timeline, id), visual: l.visual, box: l.box, handle: "se", pointer: { x: nw.x + (se.x - nw.x) * 2, y: nw.y + (se.y - nw.y) * 2 }, fromAnchor: false, measurer: monoMeasurer });
    expect(r.style.fontSize).toBeCloseTo(80, 6);
    expect(r.style.padding).toBeCloseTo(20, 6);
    expect(r.style.strokeWidth).toBeCloseTo(8, 6);
    expect(r.visual.transform.scaleX).toBe(1);
  });
});

describe("19. rotate text", () => {
  it("rotates about the anchor like any layer", () => {
    const e = project();
    const id = addText(e, "Hello");
    e.setClipVisual(id, { transform: { rotation: 90 } });
    const l = layerOf(e.timeline, id);
    const center = applyToPoint(l.matrix, { x: l.width / 2, y: l.height / 2 });
    expect(center.x).toBeCloseTo(960, 6);
    expect(center.y).toBeCloseTo(540, 6);
    expect(l.bounds.height).toBeCloseTo(l.width, 6);
  });
});

describe("20. opacity", () => {
  it("layer opacity applies to the whole text layer; 0 hides it", () => {
    const e = project();
    const id = addText(e, "Hi");
    e.setClipVisual(id, { opacity: 0.4 });
    expect(drawOnly(e.timeline, [id]).find((c) => c.op === "fillText")!.state.globalAlpha).toBeCloseTo(0.4, 9);
    e.setClipVisual(id, { opacity: 0 });
    expect(resolveFrame(e.timeline, 0, ctx()).layers).toHaveLength(0);
  });
});

describe("21. timeline duration", () => {
  it("renders only during [start, end); trim extends/shortens; move shifts", () => {
    const e = project();
    const a = addText(e, "A", {}, 0, 90); // 0-3s
    const b = addText(e, "B", {}, 90, 90); // 3-6s
    const at = (f: number) => resolveFrame(e.timeline, f, ctx()).layers.map((l) => l.clipId);
    expect(at(0)).toEqual([a]);
    expect(at(89)).toEqual([a]);
    expect(at(90)).toEqual([b]);
    expect(at(180)).toEqual([]);
    e.trimClip(a, "end", 120);
    expect(at(100).sort()).toEqual([a, b].sort());
    e.moveClip(b, 150);
    expect(at(120)).toEqual([]);
  });
});

describe("22. layer ordering", () => {
  it("text composites in track order, and reorders with the stack", () => {
    const e = project();
    const back = addText(e, "back");
    const front = addText(e, "front"); // addText puts new layers at the front
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([back, front]);
    e.reorderTrack(e.timeline.clips[back].trackId, 0);
    expect(resolveFrame(e.timeline, 0, ctx()).layers.map((l) => l.clipId)).toEqual([front, back]);
  });
});

describe("23/24. undo + redo", () => {
  it("every text operation is exactly one step, and replays exactly", () => {
    const e = project();
    const id = addText(e, "start");
    const ops: (() => void)[] = [
      () => e.updateAuthoredContent(id, { text: "changed" }),
      () => e.updateAuthoredContent(id, { textStyle: { fontFamily: "anton" } }),
      () => e.updateAuthoredContent(id, { textStyle: { fontSize: 90 } }),
      () => e.updateAuthoredContent(id, { textStyle: { color: "#ff0000" } }),
      () => e.updateAuthoredContent(id, { textStyle: { textAlign: "right" } }),
      () => e.updateAuthoredContent(id, { textStyle: { lineHeight: 1.6 } }),
      () => e.updateAuthoredContent(id, { textStyle: { letterSpacing: 3 } }),
      () => e.updateAuthoredContent(id, { textStyle: { background: true } }),
      () => e.updateAuthoredContent(id, { textStyle: { stroke: true } }),
      () => e.updateAuthoredContent(id, { textStyle: { shadow: true } }),
      () => e.setClipVisual(id, { transform: { x: 100 } }),
      () => e.updateAuthoredContent(id, { textStyle: { sizing: "box", boxWidth: 500 } }),
      () => e.setClipVisual(id, { transform: { rotation: 20 } }),
      () => void e.duplicateClipsAsLayers([id]),
    ];
    const snapshots = [e.timeline];
    for (const op of ops) {
      op();
      snapshots.push(e.timeline);
    }
    for (let i = ops.length - 1; i >= 0; i--) {
      e.undo();
      expect(e.timeline).toBe(snapshots[i]);
    }
    for (let i = 1; i <= ops.length; i++) {
      e.redo();
      expect(e.timeline).toBe(snapshots[i]);
    }
    e.undo(); // the duplicate
    e.undo(); // ...rotation
    expect(Object.keys(e.timeline.clips)).toEqual([id]);
  });
});

describe("25/26. save + reload", () => {
  it("round-trips every text field and lays out identically", () => {
    const e = project({ width: 1080, height: 1920 });
    const id = addText(e, "Line one\nLine two that wraps a bit", {
      fontFamily: "montserrat", fontSize: 64, fontWeight: 700, fontStyle: "italic", color: "#fafafa", textAlign: "justify", verticalAlign: "middle",
      lineHeight: 1.4, letterSpacing: 2, sizing: "box", boxWidth: 700, boxHeight: 400, overflow: "clip",
      background: true, backgroundColor: "#111111", backgroundOpacity: 0.7, padding: 24, borderRadius: 16,
      stroke: true, strokeColor: "#000000", strokeWidth: 3, shadow: true, shadowColor: "#00000088", shadowBlur: 20, shadowOffsetX: 4, shadowOffsetY: 6,
    }, 30, 120);
    e.setClipVisual(id, { transform: { x: 500, y: 1500, rotation: -5, anchorX: 0, anchorY: 1 }, opacity: 0.9 });
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    expect(loaded.clips[id]).toEqual(JSON.parse(JSON.stringify(e.timeline.clips[id])));
    expect(loaded.trackIds).toEqual(e.timeline.trackIds);
    const a = layerOf(e.timeline, id, 60);
    const b = layerOf(loaded, id, 60);
    expect(b.matrix).toEqual(a.matrix);
    expect(b.content).toEqual(a.content);
  });
});

describe("27. missing / invalid font fallback", () => {
  it("never throws, always resolves to a renderable stack, and reports the fallback", () => {
    const unknown = resolveFont({ fontFamily: "Totally Not A Font", fontWeight: 400, fontStyle: "normal" });
    expect(unknown.status).toBe("unknown-family");
    expect(unknown.cssFamily).toMatch(/sans-serif$/);
    const invalid = resolveFont({ fontFamily: "x; } body { color: red", fontWeight: 400, fontStyle: "normal" });
    expect(invalid.status).toBe("invalid");
    expect(invalid.cssFamily).toContain("Geist");
    expect(resolveFont({ fontFamily: "", fontWeight: 400, fontStyle: "normal" }).status).toBe("invalid");
    expect(cssFontString({ fontFamily: "Nope", fontWeight: 400, fontStyle: "italic", fontSize: 20 })).toBe("italic 400 20px Nope, ui-sans-serif, sans-serif");
    // and a text layer with a garbage style still resolves & draws
    let tl = createTimeline(30);
    const t = addTrack(tl, "text", "T");
    tl = insertClip(t.timeline, t.track.id, { kind: "text", text: "ok", textStyle: { fontFamily: 42, fontSize: "big", color: null } as never, durationFrames: 10 }, 0).timeline;
    expect(() => resolveFrame(tl, 0, ctx())).not.toThrow();
    expect(resolveFrame(tl, 0, ctx()).layers).toHaveLength(1);
  });
});

describe("28. transparent background", () => {
  it("text over a transparent composition: nothing painted except the text (and its own box if enabled)", () => {
    const e = project();
    e.setCompositionSettings({ background: "transparent" });
    const id = addText(e, "Hi");
    const f = resolveFrame(e.timeline, 0, ctx());
    const r = recorder();
    drawResolvedFrame(r.ctx, f, new Map(), { renderScale: 1, smoothing: "high", getScratch: () => r.ctx });
    expect(r.calls.some((c) => c.op === "fillRect")).toBe(false);
    expect(r.calls.some((c) => c.op === "fillText")).toBe(true);
    void id;
  });
});

describe("29. background-removed media underneath text", () => {
  it("text composites ABOVE a matted cutout (V1 bg video, V2 cutout, V3 text, V4 logo)", () => {
    let tl = createTimeline(30, { width: 1920, height: 1080 });
    const ids: Record<string, string> = {};
    // addTrack appends; trackIds[0] is front -> add front-to-back: logo, text, cutout, bg
    for (const [name, kind] of [["logo", "image"], ["text", "text"], ["cutout", "video"], ["bg", "video"]] as const) {
      const t = addTrack(tl, kind, name);
      tl = t.timeline;
      ids[name] = t.track.id;
    }
    const put = (track: string, content: Parameters<typeof insertClip>[2]) => {
      const r = insertClip(tl, track, content, 0);
      tl = r.timeline;
      return r.clip.id;
    };
    const bg = put(ids.bg, { kind: "video", source: { sourceId: "bg" }, sourceInFrame: 0, sourceOutFrame: 30 });
    const cut = put(ids.cutout, { kind: "video", source: { sourceId: "cutout" }, sourceInFrame: 0, sourceOutFrame: 30 });
    tl = setClipVisual(tl, cut, { matte: { sourceId: "matte", invert: false } });
    const text = put(ids.text, { kind: "text", text: "TITLE", textStyle: normalizeTextStyle({}), durationFrames: 30 });
    const logo = put(ids.logo, { kind: "image", source: { sourceId: "bg" }, durationFrames: 30 });
    const f = resolveFrame(tl, 0, ctx());
    expect(f.layers.map((l) => l.clipId)).toEqual([bg, cut, text, logo]);
    const main = recorder();
    const scratch = recorder();
    const img = { width: 1920, height: 1080 } as unknown as CanvasImageSource;
    drawResolvedFrame(main.ctx, f, new Map([[bg, { image: img }], [cut, { image: img, matte: img }], [logo, { image: img }]]), { renderScale: 1, smoothing: "high", getScratch: () => scratch.ctx });
    const seq = main.calls.filter((c) => c.op === "drawImage" || c.op === "fillText").map((c) => c.op);
    // bg image, matted cutout (composited from scratch), text, logo
    expect(seq).toEqual(["drawImage", "drawImage", "fillText", "drawImage"]);
    expect(scratch.calls.some((c) => c.state.globalCompositeOperation === "destination-in")).toBe(true);
  });
});

describe("30/31/32. composition sizes", () => {
  for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080]] as const) {
    it(`${w}x${h}: new text is centered, and keeps its relative position when the composition changes`, () => {
      const e = project({ width: w, height: h });
      const id = addText(e, "Title");
      const l = layerOf(e.timeline, id);
      const c = applyToPoint(l.matrix, { x: l.width / 2, y: l.height / 2 });
      expect(c.x).toBeCloseTo(w / 2, 6);
      expect(c.y).toBeCloseTo(h / 2, 6);
      // place it as a lower third, then switch to every other composition
      e.setClipVisual(id, { transform: { x: w * 0.5, y: h * 0.8 } });
      for (const [w2, h2] of [[1080, 1920], [1920, 1080], [1080, 1080]] as const) {
        const tl = setCompositionSettings(e.timeline, { width: w2, height: h2 });
        const v = tl.clips[id].visual!.transform;
        expect(v.x / w2).toBeCloseTo(0.5, 9);
        expect(v.y / h2).toBeCloseTo(0.8, 9);
        const b = resolveClipLayer(tl, id, 0, ctx())!.bounds;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(w2);
      }
    });
  }
});

describe("error handling", () => {
  it("empty text isn't drawn (but doesn't crash)", () => {
    const e = project();
    const id = addText(e, "x");
    e.updateAuthoredContent(id, { text: "" });
    expect(() => resolveFrame(e.timeline, 0, ctx())).not.toThrow();
    expect(resolveFrame(e.timeline, 0, ctx()).layers).toHaveLength(0);
  });
  it("huge boxes and extreme spacing clamp", () => {
    const s = normalizeTextStyle({ sizing: "box", boxWidth: 1e12, letterSpacing: -1e6, lineHeight: 99 });
    expect(s.boxWidth).toBe(20000);
    expect(s.letterSpacing).toBe(-200);
    expect(s.lineHeight).toBe(5);
  });
  it("a box with no width falls back to point text rather than an unusable box", () => {
    expect(normalizeTextStyle({ sizing: "box" }).sizing).toBe("point");
  });
  it("very long text lays out in bounded time and is cached across frames", () => {
    const long = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
    const content = { text: long, textStyle: normalizeTextStyle({ sizing: "box", boxWidth: 1000, fontSize: 20 }) };
    const t0 = performance.now();
    const a = cachedTextLayout(content, monoMeasurer);
    const first = performance.now() - t0;
    const t1 = performance.now();
    const b = cachedTextLayout(content, monoMeasurer);
    const second = performance.now() - t1;
    expect(a.layout.lines.length).toBeGreaterThan(100);
    expect(b).toBe(a); // same cached object
    expect(first).toBeLessThan(2000);
    expect(second).toBeLessThan(5);
  });
  it("legacy (v2) style names migrate", () => {
    const s = normalizeTextStyle({ italic: true, align: "left", backgroundColor: "#222", strokeColor: "#000", strokeWidth: 2 });
    expect(s).toMatchObject({ fontStyle: "italic", textAlign: "left", background: true, backgroundOpacity: 1, stroke: true });
    expect("italic" in s).toBe(false);
  });
  it("unknown (future) style keys survive normalization", () => {
    expect((normalizeTextStyle({ runs: [{ start: 0, end: 2 }] }) as unknown as { runs: unknown }).runs).toEqual([{ start: 0, end: 2 }]);
  });
  it("updateAuthoredContent / deleteClips via the pure ops too", () => {
    let tl = createTimeline(30);
    const r = addTextLayer(tl, { text: "a", atFrame: 0, durationFrames: 10 });
    tl = updateAuthoredContent(r.timeline, r.clip.id, { text: "b" });
    tl = duplicateClipsAsLayers(tl, [r.clip.id]).timeline;
    tl = deleteClips(tl, [r.clip.id]);
    expect(Object.values(tl.clips).map((c) => (c.content as { text: string }).text)).toEqual(["b"]);
  });
});
