import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { resolveFrame } from "../composition/resolve";
import { fakeContext } from "../composition/test-helpers";
import { valueAt } from "./properties";
import { activeMotionSlots, applyMotionPreset, MOTION_PRESETS, motionWindows } from "./motion-presets";

/** Motion presets write ordinary keyframes: asserted through resolveFrame, what preview AND export draw. */

const OP = "visual.opacity";
const Y = "visual.transform.y";

function setup(durationFrames = 120) {
  const e = new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
  const r = e.addGraphicLayer({ graphic: { shape: normalizeShapeSpec({ type: "rect", width: 200, height: 100 }) }, atFrame: 30, durationFrames });
  if (!r.ok) throw r.error;
  return { e, id: r.clip.id };
}
const layerAt = (e: TimelineEngine, id: string, frame: number) => resolveFrame(e.timeline, frame, fakeContext({})).layers.find((l) => l.clipId === id);
/** Fully transparent layers aren't drawn at all — they resolve to nothing. */
const opacityAt = (e: TimelineEngine, id: string, frame: number) => layerAt(e, id, frame)?.opacity ?? 0;
const yAt = (e: TimelineEngine, id: string, frame: number) => valueAt(e.timeline.clips[id], Y, frame - e.timeline.clips[id].timelineStart, e.timeline.composition);
const apply = (e: TimelineEngine, id: string, slot: "in" | "out" | "loop", preset: string | null) => {
  const r = e.transact((tl) => applyMotionPreset(tl, id, slot, preset));
  if (!r.ok) throw r.error;
};

describe("motion presets", () => {
  it("every preset applies cleanly in its own slot", () => {
    for (const p of MOTION_PRESETS) {
      const { e, id } = setup();
      apply(e, id, p.slot, p.id);
      expect(Object.keys(e.timeline.clips[id].animation?.tracks ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("fade in + fade out: transparent at both ends, resting in the middle", () => {
    const { e, id } = setup();
    apply(e, id, "in", "fade-in");
    apply(e, id, "out", "fade-out");
    expect(opacityAt(e, id, 30)).toBeCloseTo(0);
    expect(opacityAt(e, id, 90)).toBeCloseTo(1);
    expect(opacityAt(e, id, 149)).toBeCloseTo(0);
  });

  it("re-applying a slot replaces it, and None clears it back to the resting value", () => {
    const { e, id } = setup();
    const rest = yAt(e, id, 90);
    apply(e, id, "in", "rise-in");
    expect(yAt(e, id, 30)).toBeGreaterThan(rest);
    apply(e, id, "in", "drop-in");
    expect(yAt(e, id, 30)).toBeLessThan(rest);
    apply(e, id, "in", null);
    expect(yAt(e, id, 30)).toBeCloseTo(rest);
    expect(opacityAt(e, id, 30)).toBeCloseTo(1);
    expect(e.timeline.clips[id].animation?.tracks[Y]).toBeUndefined();
  });

  it("slots combine without disturbing each other", () => {
    const { e, id } = setup();
    apply(e, id, "in", "fade-in");
    apply(e, id, "loop", "float");
    apply(e, id, "out", "fade-out");
    apply(e, id, "in", "pop-in"); // replaces In only
    expect(activeMotionSlots(e.timeline, id)).toEqual({ in: true, out: true, loop: true });
    expect(opacityAt(e, id, 149)).toBeCloseTo(0);
    const w = motionWindows(120, 30);
    const ys = e.timeline.clips[id].animation!.tracks[Y].keyframes.map((k) => k.frame);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(w.loop[0]);
  });

  it("each preset is one undo step", () => {
    const { e, id } = setup();
    apply(e, id, "in", "spin-in");
    e.undo();
    expect(e.timeline.clips[id].animation?.tracks[OP]).toBeUndefined();
  });

  it("refuses locked tracks, audio clips and unknown presets", () => {
    const { e, id } = setup();
    expect(() => applyMotionPreset(e.timeline, id, "in", "pulse")).toThrow();
    expect(() => applyMotionPreset(e.timeline, id, "in", "nope")).toThrow();
    const t = e.timeline.clips[id].trackId;
    e.setTrackLocked(t, true);
    expect(() => applyMotionPreset(e.timeline, id, "in", "fade-in")).toThrow();
  });
});
