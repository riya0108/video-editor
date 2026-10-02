import { describe, expect, it } from "vitest";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTrack, insertClip, setClipVisual, setTrackVisible, splitClip } from "../timeline/operations";
import type { ClipContent } from "../timeline/clip";
import { defaultClipVisual, type ClipVisualPatch } from "../timeline/visual";
import { applyToPoint, transformRect } from "./matrix";
import { fitBox, resolveFrame } from "./resolve";
import { fakeContext } from "./test-helpers";

const SOURCES = {
  hd: { width: 1920, height: 1080 },
  sq: { width: 400, height: 400 },
  matte: { width: 200, height: 200 },
};

function video(sourceId: string, inF = 0, outF = 100): ClipContent {
  return { kind: "video", source: { sourceId }, sourceInFrame: inF, sourceOutFrame: outF };
}

function build(): { tl: TimelineModel; ids: Record<string, string> } {
  let tl = createTimeline(30, { width: 1920, height: 1080, background: "#000" });
  const ids: Record<string, string> = {};
  // addTrack appends; trackIds[0] is FRONTMOST. Add front-to-back.
  for (const [name, kind] of [["text", "text"], ["shape", "graphic"], ["overlay", "overlay"], ["main", "video"], ["music", "audio"]] as const) {
    const r = addTrack(tl, kind, name);
    tl = r.timeline;
    ids[name] = r.track.id;
  }
  const put = (track: string, content: ClipContent, start = 0, visual?: ClipVisualPatch) => {
    const r = insertClip(tl, ids[track], content, start, visual);
    tl = r.timeline;
    return r.clip.id;
  };
  ids.mainClip = put("main", video("hd", 10, 110));
  ids.overlayClip = put("overlay", { kind: "overlay", source: { sourceId: "sq" }, sourceInFrame: 0, sourceOutFrame: 50 }, 20);
  ids.shapeClip = put("shape", { kind: "graphic", shape: { type: "rect", width: 200, height: 100, fill: "#f00", strokeWidth: 0, cornerRadius: 0 }, durationFrames: 100 });
  ids.textClip = put("text", { kind: "text", text: "Hello", durationFrames: 100 });
  ids.musicClip = put("music", { kind: "audio", source: { sourceId: "aud" }, sourceInFrame: 0, sourceOutFrame: 100 });
  return { tl, ids };
}

describe("fitBox", () => {
  it("contain letterboxes, cover overflows, fill stretches, none keeps native", () => {
    expect(fitBox(400, 400, 1920, 1080, "contain")).toEqual({ width: 1080, height: 1080 });
    expect(fitBox(400, 400, 1920, 1080, "cover")).toEqual({ width: 1920, height: 1920 });
    expect(fitBox(400, 400, 1920, 1080, "fill")).toEqual({ width: 1920, height: 1080 });
    expect(fitBox(400, 400, 1920, 1080, "none")).toEqual({ width: 400, height: 400 });
  });
});

describe("resolveFrame", () => {
  it("paints back-to-front in reverse trackIds order and skips audio", () => {
    const { tl, ids } = build();
    const f = resolveFrame(tl, 30, fakeContext(SOURCES));
    expect(f.layers.map((l) => l.clipId)).toEqual([ids.mainClip, ids.overlayClip, ids.shapeClip, ids.textClip]);
    expect(f.layers.some((l) => l.kind === "audio")).toBe(false);
  });

  it("maps timeline frame to source frame through the clip's in-point", () => {
    const { tl, ids } = build();
    const f = resolveFrame(tl, 30, fakeContext(SOURCES));
    const main = f.layers.find((l) => l.clipId === ids.mainClip)!;
    expect(main.content).toEqual({ type: "media", sourceId: "hd", sourceFrame: 40, still: false });
    const overlay = f.layers.find((l) => l.clipId === ids.overlayClip)!;
    expect(overlay.content).toMatchObject({ sourceFrame: 10 }); // starts at timeline 20, in-point 0
  });

  it("only includes clips active at the frame (end-exclusive)", () => {
    const { tl, ids } = build();
    expect(resolveFrame(tl, 19, fakeContext(SOURCES)).layers.map((l) => l.clipId)).not.toContain(ids.overlayClip);
    expect(resolveFrame(tl, 20, fakeContext(SOURCES)).layers.map((l) => l.clipId)).toContain(ids.overlayClip);
    expect(resolveFrame(tl, 70, fakeContext(SOURCES)).layers.map((l) => l.clipId)).not.toContain(ids.overlayClip);
  });

  it("skips hidden tracks", () => {
    const { tl, ids } = build();
    const hidden = setTrackVisible(tl, ids.main, false);
    expect(resolveFrame(hidden, 30, fakeContext(SOURCES)).layers.map((l) => l.clipId)).not.toContain(ids.mainClip);
  });

  it("default visual: 16:9 source fills a 16:9 composition exactly", () => {
    const { tl, ids } = build();
    const main = resolveFrame(tl, 30, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.mainClip)!;
    expect(transformRect(main.matrix, main.crop)).toEqual([
      { x: 0, y: 0 },
      { x: 1920, y: 0 },
      { x: 1920, y: 1080 },
      { x: 0, y: 1080 },
    ]);
  });

  it("transform: position/anchor/scale/rotation/flip compose in the documented order", () => {
    let { tl, ids } = build();
    tl = setClipVisual(tl, ids.shapeClip, { transform: { x: 500, y: 300, anchorX: 0, anchorY: 0, scaleX: 2, scaleY: 1, rotation: 90 } });
    const shape = resolveFrame(tl, 0, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.shapeClip)!;
    // Top-left anchor sits at (500,300); +x content axis (scaled x2) rotates onto +y.
    expect(applyToPoint(shape.matrix, { x: 0, y: 0 })).toEqual({ x: 500, y: 300 });
    expect(applyToPoint(shape.matrix, { x: 200, y: 0 })).toEqual({ x: 500, y: 700 });
    expect(applyToPoint(shape.matrix, { x: 0, y: 100 })).toEqual({ x: 400, y: 300 });

    tl = setClipVisual(tl, ids.shapeClip, { transform: { rotation: 0, scaleX: 1, flipX: true, anchorX: 0.5, anchorY: 0.5 } });
    const flipped = resolveFrame(tl, 0, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.shapeClip)!;
    // Flip mirrors about the anchor: content left edge lands on the right.
    expect(applyToPoint(flipped.matrix, { x: 0, y: 50 })).toEqual({ x: 600, y: 300 });
    expect(applyToPoint(flipped.matrix, { x: 200, y: 50 })).toEqual({ x: 400, y: 300 });
  });

  it("crop clips in place — the remaining region does not move", () => {
    let { tl, ids } = build();
    tl = setClipVisual(tl, ids.mainClip, { crop: { left: 0.25, top: 0.5 } });
    const main = resolveFrame(tl, 30, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.mainClip)!;
    expect(main.crop).toEqual({ x: 480, y: 540, width: 1440, height: 540 });
    expect(main.bounds).toEqual({ x: 480, y: 540, width: 1440, height: 540 });
  });

  it("culls fully off-canvas and zero-opacity layers", () => {
    let { tl, ids } = build();
    tl = setClipVisual(tl, ids.shapeClip, { transform: { x: -1000 } });
    tl = setClipVisual(tl, ids.textClip, { opacity: 0 });
    const ids2 = resolveFrame(tl, 30, fakeContext(SOURCES)).layers.map((l) => l.clipId);
    expect(ids2).not.toContain(ids.shapeClip);
    expect(ids2).not.toContain(ids.textClip);
  });

  it("omits layers whose source size is unknown and reports them", () => {
    const { tl, ids } = build();
    const f = resolveFrame(tl, 30, fakeContext({ sq: SOURCES.sq }));
    expect(f.layers.map((l) => l.clipId)).not.toContain(ids.mainClip);
    expect(f.missingSources).toEqual(["hd"]);
  });

  it("a matted layer is omitted (not drawn unmatted) until the matte source is known", () => {
    let { tl, ids } = build();
    tl = setClipVisual(tl, ids.overlayClip, { matte: { sourceId: "matte", invert: false } });
    const without = resolveFrame(tl, 30, fakeContext({ hd: SOURCES.hd, sq: SOURCES.sq }));
    expect(without.layers.map((l) => l.clipId)).not.toContain(ids.overlayClip);
    expect(without.missingSources).toContain("matte");
    const withMatte = resolveFrame(tl, 30, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.overlayClip)!;
    expect(withMatte.matte).toEqual({ sourceId: "matte", sourceFrame: 10, invert: false });
  });

  it("text layers are sized by layout, wrap at maxWidth, and anchor at their center by default", () => {
    const { tl, ids } = build();
    const text = resolveFrame(tl, 0, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.textClip)!;
    // monoMeasurer: 5 chars * 72 * 0.5 = 180 wide; 1 line * 72 * 1.2 tall
    expect(text.width).toBe(180);
    expect(text.height).toBeCloseTo(86.4, 9);
    expect(applyToPoint(text.matrix, { x: 90, y: 43.2 })).toEqual({ x: 960, y: 540 });
  });

  it("visual overrides (live drag) win over the stored visual without touching the model", () => {
    const { tl, ids } = build();
    const v = { ...defaultClipVisual(1920, 1080), transform: { ...defaultClipVisual(1920, 1080).transform, x: 100 } };
    const shape = resolveFrame(tl, 0, fakeContext(SOURCES, { visualOverrides: { [ids.shapeClip]: v } })).layers.find((l) => l.clipId === ids.shapeClip)!;
    expect(applyToPoint(shape.matrix, { x: 100, y: 50 })).toEqual({ x: 100, y: 540 });
    expect(tl.clips[ids.shapeClip].visual).toBeUndefined();
  });

  it("split keeps both halves in the same place on screen", () => {
    let { tl, ids } = build();
    tl = setClipVisual(tl, ids.mainClip, { transform: { x: 700, rotation: 15 }, opacity: 0.5 });
    const { timeline, right } = splitClip(tl, ids.mainClip, 50);
    const before = resolveFrame(timeline, 49, fakeContext(SOURCES)).layers.find((l) => l.clipId === ids.mainClip)!;
    const after = resolveFrame(timeline, 50, fakeContext(SOURCES)).layers.find((l) => l.clipId === right.id)!;
    expect(after.matrix).toEqual(before.matrix);
    expect(after.opacity).toBe(0.5);
  });
});
