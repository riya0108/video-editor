import { describe, expect, it } from "vitest";
import { normalizeShapeSpec } from "./shape-style";
import { applyVisualPatch, defaultClipVisual, InvalidVisualError, normalizeCrop } from "./visual";
import { createTimeline } from "./model";
import { addTrack, duplicateClip, insertClip, setClipVisual, setCompositionSettings, setTrackLocked, splitClip, updateAuthoredContent } from "./operations";
import { TimelineEditError } from "./errors";
import { TimelineEngine } from "./engine";

describe("visual patch", () => {
  const base = defaultClipVisual(1920, 1080);

  it("deep-merges transform/crop and clamps opacity", () => {
    const v = applyVisualPatch(base, { transform: { rotation: 30 }, crop: { left: 0.1 }, opacity: 1.7 });
    expect(v.transform).toMatchObject({ x: 960, y: 540, rotation: 30, scaleX: 1 });
    expect(v.crop).toEqual({ top: 0, right: 0, bottom: 0, left: 0.1 });
    expect(v.opacity).toBe(1);
  });

  it("rejects non-finite numbers and non-positive scale", () => {
    expect(() => applyVisualPatch(base, { transform: { x: NaN } })).toThrow(InvalidVisualError);
    expect(() => applyVisualPatch(base, { transform: { scaleX: 0 } })).toThrow(InvalidVisualError);
    expect(() => applyVisualPatch(base, { transform: { scaleY: -1 } })).toThrow(/flip/);
  });

  it("crop can never hide the whole frame", () => {
    const c = normalizeCrop({ left: 0.8, right: 0.8, top: 0, bottom: 1 });
    expect(c.left + c.right).toBeCloseTo(0.99, 12);
    expect(c.top + c.bottom).toBeCloseTo(0.99, 12);
  });

  it("matte: null removes, undefined keeps", () => {
    const withMatte = applyVisualPatch(base, { matte: { sourceId: "m", invert: false } });
    expect(applyVisualPatch(withMatte, { opacity: 0.5 }).matte).toEqual({ sourceId: "m", invert: false });
    expect(applyVisualPatch(withMatte, { matte: null }).matte).toBeUndefined();
  });
});

describe("visual operations", () => {
  function setup() {
    let tl = createTimeline(30, { width: 1280, height: 720 });
    const v = addTrack(tl, "video", "V1");
    tl = v.timeline;
    const a = addTrack(tl, "audio", "A1");
    tl = a.timeline;
    const t = addTrack(tl, "text", "T1");
    tl = t.timeline;
    const vc = insertClip(tl, v.track.id, { kind: "video", source: { sourceId: "s" }, sourceInFrame: 0, sourceOutFrame: 60 }, 0);
    tl = vc.timeline;
    const ac = insertClip(tl, a.track.id, { kind: "audio", source: { sourceId: "s" }, sourceInFrame: 0, sourceOutFrame: 60 }, 0);
    tl = ac.timeline;
    const tc = insertClip(tl, t.track.id, { kind: "text", text: "hi", durationFrames: 30 }, 0);
    tl = tc.timeline;
    return { tl, video: vc.clip.id, audio: ac.clip.id, text: tc.clip.id, videoTrack: v.track.id };
  }

  it("setClipVisual starts from the composition-centered default", () => {
    const { tl, video } = setup();
    const next = setClipVisual(tl, video, { opacity: 0.5 });
    expect(next.clips[video].visual).toMatchObject({ opacity: 0.5, transform: { x: 640, y: 360 } });
    expect(tl.clips[video].visual).toBeUndefined(); // immutability
  });

  it("rejects audio clips, locked tracks and invalid values with typed errors", () => {
    const { tl, audio, video, videoTrack } = setup();
    expect(() => setClipVisual(tl, audio, { opacity: 0.5 })).toThrow(TimelineEditError);
    expect(() => setClipVisual(setTrackLocked(tl, videoTrack, true), video, { opacity: 0.5 })).toThrow(/locked/);
    try {
      setClipVisual(tl, video, { transform: { scaleX: 0 } });
      expect.unreachable();
    } catch (e) {
      expect((e as TimelineEditError).reason).toBe("invalid-visual");
    }
  });

  it("split and duplicate carry the visual over", () => {
    const { tl, video } = setup();
    const styled = setClipVisual(tl, video, { transform: { rotation: 12 }, opacity: 0.3 });
    const { right } = splitClip(styled, video, 30);
    expect(right.visual).toEqual(styled.clips[video].visual);
    const { clip } = duplicateClip(styled, video);
    expect(clip.visual).toEqual(styled.clips[video].visual);
  });

  it("updateAuthoredContent patches text and style, rejects wrong kinds", () => {
    const { tl, text, video } = setup();
    const next = updateAuthoredContent(tl, text, { text: "hello", textStyle: { fontSize: 40 } });
    const c = next.clips[text].content;
    expect(c.kind === "text" && c.text).toBe("hello");
    expect(c.kind === "text" && c.textStyle?.fontSize).toBe(40);
    expect(c.kind === "text" && c.textStyle?.fontWeight).toBe(700); // filled from defaults
    expect(() => updateAuthoredContent(tl, video, { text: "x" })).toThrow(TimelineEditError);
  });

  it("composition size must be even", () => {
    const { tl } = setup();
    expect(setCompositionSettings(tl, { width: 1080, height: 1920 }).composition).toMatchObject({ width: 1080, height: 1920 });
    expect(() => setCompositionSettings(tl, { width: 1081 })).toThrow(TimelineEditError);
    expect(() => createTimeline(30, { width: 0 })).toThrow();
  });

  it("engine: visual edits are undoable, one step each", () => {
    const engine = new TimelineEngine(30, { width: 640, height: 360 });
    const track = engine.addTrack("graphic", "G");
    if (!track.ok) throw track.error;
    const ins = engine.insertClip(track.track.id, { kind: "graphic", shape: normalizeShapeSpec({ type: "ellipse", width: 10, height: 10, strokeWidth: 0, cornerRadius: 0 }), durationFrames: 5 }, 0);
    if (!ins.ok) throw ins.error;
    expect(engine.setClipVisual(ins.clip.id, { transform: { x: 1 } }).ok).toBe(true);
    expect(engine.setClipVisual(ins.clip.id, { transform: { x: 2 } }).ok).toBe(true);
    expect(engine.timeline.clips[ins.clip.id].visual?.transform.x).toBe(2);
    engine.undo();
    expect(engine.timeline.clips[ins.clip.id].visual?.transform.x).toBe(1);
    engine.undo();
    expect(engine.timeline.clips[ins.clip.id].visual).toBeUndefined();
    const bad = engine.setClipVisual(ins.clip.id, { opacity: NaN });
    expect(bad.ok).toBe(false);
  });
});
