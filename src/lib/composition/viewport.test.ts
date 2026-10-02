import { describe, expect, it } from "vitest";
import { createTimeline } from "../timeline/model";
import { addTrack, insertClip, setClipVisual } from "../timeline/operations";
import { resolveFrame } from "./resolve";
import { fakeContext } from "./test-helpers";
import { autoPreviewScale, FINAL_PROFILE, previewProfile, renderSize } from "./render-profile";
import { centerAtZoom, compositionToScreen, constrainViewport, fitToScreen, hitTest, screenToComposition, stepZoom } from "./viewport";

describe("viewport", () => {
  it("fit-to-screen centers and fits the limiting axis", () => {
    const vp = fitToScreen({ width: 1920, height: 1080 }, { width: 1000, height: 1000 }, 20);
    expect(vp.zoom).toBeCloseTo(960 / 1920, 12);
    expect(vp.panX).toBeCloseTo(20, 9);
    expect(vp.panY).toBeCloseTo((1000 - 540) / 2, 9);
  });

  it("composition <-> screen round-trips", () => {
    const vp = { zoom: 0.37, panX: 12, panY: -40 };
    const p = { x: 812, y: 333 };
    const back = screenToComposition(compositionToScreen(p, vp), vp);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it("stepZoom moves through presets and keeps the anchor fixed", () => {
    const vp = centerAtZoom({ width: 1920, height: 1080 }, { width: 800, height: 600 }, 0.5);
    const anchor = { x: 300, y: 200 };
    const before = screenToComposition(anchor, vp);
    const next = stepZoom(vp, 1, anchor);
    expect(next.zoom).toBe(0.67);
    const after = screenToComposition(anchor, next);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(stepZoom(vp, -1, anchor).zoom).toBe(0.33);
  });

  it("constrainViewport never loses the composition off-screen", () => {
    const v = constrainViewport({ zoom: 1, panX: -50000, panY: 50000 }, { width: 1920, height: 1080 }, { width: 800, height: 600 }, 48);
    expect(v.panX).toBe(48 - 1920);
    expect(v.panY).toBe(600 - 48);
  });

  it("hitTest is exact for rotated + cropped layers and prefers the topmost", () => {
    let tl = createTimeline(30);
    const front = addTrack(tl, "graphic", "front");
    tl = front.timeline;
    const back = addTrack(tl, "graphic", "back");
    tl = back.timeline;
    const shape = { type: "rect" as const, width: 400, height: 100, fill: "#fff", strokeWidth: 0, cornerRadius: 0 };
    const a = insertClip(tl, front.track.id, { kind: "graphic", shape, durationFrames: 10 }, 0);
    tl = a.timeline;
    const b = insertClip(tl, back.track.id, { kind: "graphic", shape: { ...shape, width: 1920, height: 1080 }, durationFrames: 10 }, 0);
    tl = b.timeline;
    // Rotate the front bar 90°: it becomes a 100x400 vertical bar centered at (960,540).
    tl = setClipVisual(tl, a.clip.id, { transform: { rotation: 90 } });
    const f = resolveFrame(tl, 0, fakeContext({}));
    expect(hitTest(f, { x: 960, y: 700 })?.clipId).toBe(a.clip.id); // inside the rotated bar
    expect(hitTest(f, { x: 1100, y: 540 })?.clipId).toBe(b.clip.id); // where the UNrotated bar would be — falls through
    tl = setClipVisual(tl, a.clip.id, { crop: { left: 0.5 } }); // keep only content x >= 200 -> lower half of the vertical bar
    const f2 = resolveFrame(tl, 0, fakeContext({}));
    expect(hitTest(f2, { x: 960, y: 450 })?.clipId).toBe(b.clip.id);
    expect(hitTest(f2, { x: 960, y: 650 })?.clipId).toBe(a.clip.id);
    expect(hitTest(f2, { x: -5, y: -5 })).toBeNull();
  });
});

describe("render profiles", () => {
  it("final profile is frozen at full resolution and strict", () => {
    expect(FINAL_PROFILE).toMatchObject({ kind: "final", scale: 1, smoothing: "high", exactFrames: true, strict: true });
    expect(Object.isFrozen(FINAL_PROFILE)).toBe(true);
    expect(() => {
      (FINAL_PROFILE as { scale: number }).scale = 0.5;
    }).toThrow();
  });

  it("auto preview scale tracks on-screen pixel density in power-of-two steps", () => {
    expect(autoPreviewScale(0.2, 2)).toBe(0.5); // 0.4 px needed
    expect(autoPreviewScale(0.1, 1)).toBe(0.125);
    expect(autoPreviewScale(0.25, 1)).toBe(0.25);
    expect(autoPreviewScale(0.26, 1)).toBe(0.5);
    expect(autoPreviewScale(2, 2)).toBe(1); // never above full res
  });

  it("preview profiles never claim exact frames or strictness", () => {
    for (const q of ["auto", "full", "half", "quarter"] as const) {
      const p = previewProfile(q, 1, 1, true);
      expect(p.kind).toBe("preview");
      expect(p.exactFrames).toBe(false);
      expect(p.strict).toBe(false);
    }
    expect(previewProfile("half", 1, 1, false).scale).toBe(0.5);
    expect(previewProfile("full", 1, 1, true).smoothing).toBe("low");
    expect(previewProfile("full", 1, 1, false).smoothing).toBe("high");
  });

  it("renderSize rounds and floors at 2px", () => {
    expect(renderSize(1920, 1080, 0.25)).toEqual({ width: 480, height: 270 });
    expect(renderSize(3, 3, 0.1)).toEqual({ width: 2, height: 2 });
  });
});

import { selectionLayout, hitSelectionHandle } from "./overlay";

describe("handle picking", () => {
  it("picks the NEAREST handle, so side handles stay grabbable on thin layers", () => {
    let tl = createTimeline(30);
    const t = addTrack(tl, "graphic", "g");
    tl = t.timeline;
    const c = insertClip(tl, t.track.id, { kind: "graphic", shape: { type: "rect", width: 600, height: 12, fill: "#fff", strokeWidth: 0, cornerRadius: 0 }, durationFrames: 5 }, 0);
    tl = c.timeline;
    const layer = resolveFrame(tl, 0, fakeContext({})).layers[0];
    const lay = selectionLayout(layer, { zoom: 1, panX: 0, panY: 0 }, "transform");
    // 12px tall: ne/se are 6px from e — inside the 9px hit radius, so a corners-first order made e unreachable
    expect(hitSelectionHandle(lay, lay.handles.e)).toEqual({ type: "handle", handle: "e" });
    expect(hitSelectionHandle(lay, lay.handles.ne)).toEqual({ type: "handle", handle: "ne" });
    expect(hitSelectionHandle(lay, { x: lay.handles.e.x, y: lay.handles.e.y - 5 })).toEqual({ type: "handle", handle: "ne" }); // nearer the corner
  });
});
