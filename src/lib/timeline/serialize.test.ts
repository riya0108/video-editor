import { describe, expect, it } from "vitest";
import { TimelineEngine } from "./engine";
import { deserializeTimeline, ProjectFormatError, serializeTimeline } from "./serialize";
import { createId, resetIdCountersForTests } from "./id";
import { normalizeTextStyle } from "./text-style";

function project() {
  const e = new TimelineEngine(30, { width: 1080, height: 1920, background: "transparent" });
  const v = e.addTrack("video", "V");
  const t = e.addTrack("text", "T");
  if (!v.ok || !t.ok) throw new Error();
  const clip = e.insertClip(v.track.id, { kind: "video", source: { sourceId: "portrait", label: "phone.mp4" }, sourceInFrame: 0, sourceOutFrame: 90 }, 0, {
    transform: { x: 300, y: 500, rotation: 17, scaleX: 0.5, scaleY: 0.75, anchorX: 0.1, anchorY: 0.9, flipX: true },
    crop: { top: 0.1, right: 0.2, bottom: 0.05, left: 0 },
    opacity: 0.6,
    blendMode: "screen",
    matte: { sourceId: "cutout-matte", invert: true },
  });
  e.insertClip(t.track.id, { kind: "text", text: "Hi", textStyle: normalizeTextStyle({ fontSize: 40 }), durationFrames: 30 }, 10);
  e.addGuide("x", 540);
  if (!clip.ok) throw new Error();
  return { e, clipId: clip.clip.id };
}

describe("12. save / reload", () => {
  it("round-trips every transform/crop/flip/opacity/anchor/matte field exactly", () => {
    const { e, clipId } = project();
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    expect(loaded).toEqual(JSON.parse(JSON.stringify(e.timeline)));
    expect(loaded.clips[clipId].visual).toEqual(e.timeline.clips[clipId].visual);
  });

  it("reserves loaded ids so new clips can't collide in a fresh session", () => {
    resetIdCountersForTests(); // the saving session starts from clip-1 / track-1 ...
    const { e } = project();
    expect(Object.keys(e.timeline.clips)).toContain("clip-1");
    const json = serializeTimeline(e.timeline);
    resetIdCountersForTests(); // simulate a brand-new browser session
    const loaded = deserializeTimeline(json);
    const fresh = createId("clip");
    expect(loaded.clips[fresh]).toBeUndefined();
    const engine = new TimelineEngine(30);
    engine.loadTimeline(loaded);
    const track = loaded.trackIds[0];
    const r = engine.insertClip(track, { kind: "video", source: { sourceId: "x" }, sourceInFrame: 0, sourceOutFrame: 10 }, 500);
    expect(r.ok).toBe(true);
    expect(Object.keys(engine.timeline.clips)).toHaveLength(Object.keys(loaded.clips).length + 1);
  });

  it("loadTimeline starts a clean history and selection", () => {
    const { e } = project();
    const loaded = deserializeTimeline(serializeTimeline(e.timeline));
    e.select(Object.keys(e.timeline.clips)[0]);
    e.loadTimeline(loaded);
    expect(e.canUndo).toBe(false);
    expect(e.selection.selectedClipIds.size).toBe(0);
  });

  it("upgrades v1 files (pre composition/guides) with defaults", () => {
    const { e } = project();
    const tl = JSON.parse(JSON.stringify(e.timeline));
    delete tl.composition;
    delete tl.guides;
    for (const c of Object.values(tl.clips) as { visual?: unknown }[]) delete c.visual;
    const loaded = deserializeTimeline(JSON.stringify({ format: "clipbench-timeline", version: 1, timeline: tl }));
    expect(loaded.composition).toEqual({ width: 1920, height: 1080, background: "#000000" });
    expect(loaded.guides).toEqual([]);
  });

  it("rejects corrupt or hand-edited files instead of loading them half-valid", () => {
    const { e, clipId } = project();
    const base = () => JSON.parse(serializeTimeline(e.timeline));
    const bad: [string, (p: any) => void][] = [
      ["not json", () => {}],
      ["wrong format", (p) => (p.format = "other")],
      ["future version", (p) => (p.version = 99)],
      ["NaN scale", (p) => (p.timeline.clips[clipId].visual.transform.scaleX = null)],
      ["zero scale", (p) => (p.timeline.clips[clipId].visual.transform.scaleX = 0)],
      ["dangling clip ref", (p) => p.timeline.tracks[p.timeline.trackIds[0]].clipIds.push("clip-999")],
      ["orphan clip", (p) => (p.timeline.clips["clip-777"] = { ...p.timeline.clips[clipId], id: "clip-777" })],
      ["odd size", (p) => (p.timeline.composition.width = 1081)],
      ["bad guide", (p) => (p.timeline.guides[0].position = "x")],
      ["kind mismatch", (p) => (p.timeline.tracks[p.timeline.trackIds[0]].kind = "text")],
    ];
    for (const [name, mutate] of bad) {
      const p = base();
      mutate(p);
      const json = name === "not json" ? "{oops" : JSON.stringify(p);
      expect(() => deserializeTimeline(json), name).toThrow(ProjectFormatError);
    }
  });

  it("a text clip saved without a style (or with a v2 style) loads with a complete v3 style", () => {
    const { e } = project();
    const p = JSON.parse(serializeTimeline(e.timeline));
    const textId = Object.keys(p.timeline.clips).find((id) => p.timeline.clips[id].content.kind === "text")!;
    p.version = 2;
    p.timeline.clips[textId].content.textStyle = { fontFamily: "geist", fontSize: 50, fontWeight: 700, italic: true, color: "#fff", align: "right", lineHeight: 1.2, padding: 10, strokeWidth: 3, strokeColor: "#000", backgroundColor: "#123456" };
    const loaded = deserializeTimeline(JSON.stringify(p)).clips[textId].content;
    expect(loaded.kind === "text" && loaded.textStyle).toMatchObject({ fontStyle: "italic", textAlign: "right", stroke: true, background: true, backgroundColor: "#123456", backgroundOpacity: 1 });
    delete p.timeline.clips[textId].content.textStyle;
    const bare = deserializeTimeline(JSON.stringify(p)).clips[textId].content;
    expect(bare.kind === "text" && bare.textStyle).toEqual(normalizeTextStyle({}));
  });

  it("crop that would hide everything is normalized on load, not trusted", () => {
    const { e, clipId } = project();
    const p = JSON.parse(serializeTimeline(e.timeline));
    p.timeline.clips[clipId].visual.crop = { top: 0.9, bottom: 0.9, left: 0, right: 0 };
    const loaded = deserializeTimeline(JSON.stringify(p));
    const c = loaded.clips[clipId].visual!.crop;
    expect(c.top + c.bottom).toBeLessThan(1);
  });
});
