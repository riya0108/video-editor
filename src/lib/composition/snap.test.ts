import { describe, expect, it } from "vitest";
import { buildSnapTargets, snapAngle, snapPoint, snapRect, snapValue } from "./snap";
import { alignDelta } from "./align";
import { safeZones } from "./safe-zones";
import { TimelineEngine } from "../timeline/engine";

const COMP = { width: 1920, height: 1080 };

describe("snapRect", () => {
  it("snaps the nearest feature per axis within threshold", () => {
    const t = buildSnapTargets({ composition: COMP });
    // left edge 4px from canvas edge, center far from anything vertically
    const r = snapRect({ x: 4, y: 300, width: 100, height: 100 }, t, 6);
    expect(r.dx).toBe(-4);
    expect(r.dy).toBe(0);
    expect(r.lines).toEqual([{ axis: "x", position: 0, source: "canvas" }]);
  });

  it("center snapping to the composition center", () => {
    const t = buildSnapTargets({ composition: COMP });
    const r = snapRect({ x: 905, y: 487, width: 100, height: 100 }, t, 6);
    expect([r.dx, r.dy]).toEqual([5, 3]);
  });

  it("ignores targets beyond the threshold", () => {
    const t = buildSnapTargets({ composition: COMP });
    expect(snapRect({ x: 20, y: 20, width: 10, height: 10 }, t, 6)).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it("snaps to guides, safe zones and other layers' edges/centers", () => {
    const t = buildSnapTargets({
      composition: COMP,
      guides: [{ id: "g", axis: "x", position: 333 }],
      safeRects: safeZones("broadcast", 1920, 1080).map((z) => z.rect),
      layerBounds: [{ x: 1000, y: 700, width: 200, height: 100 }],
    });
    expect(snapRect({ x: 330, y: 300, width: 40, height: 10 }, t, 6).dx).toBe(3); // left edge -> guide; center (350) and right (370) are far
    expect(snapRect({ x: 1196, y: 300, width: 40, height: 10 }, t, 6).dx).toBe(4); // left edge 1196 -> layer right edge 1200
    const safeTop = 1080 * 0.035;
    expect(snapRect({ x: 300, y: safeTop + 2, width: 10, height: 10 }, t, 6).dy).toBeCloseTo(-2, 9);
    const layer = snapRect({ x: 300, y: 748, width: 10, height: 4 }, t, 6); // center 750 -> layer center 750
    expect(layer.lines.some((l) => l.source === "layer" && l.span?.[0] === 1000)).toBe(true);
  });

  it("guides win ties over other sources", () => {
    const t = buildSnapTargets({ composition: COMP, guides: [{ id: "g", axis: "x", position: 10 }], layerBounds: [{ x: 10, y: 0, width: 200, height: 5 }] });
    const r = snapRect({ x: 12, y: 500, width: 7, height: 7 }, t, 6);
    expect(r.dx).toBe(-2);
    expect(r.lines.map((l) => l.source)).toContain("guide");
  });

  it("snapPoint snaps each axis independently", () => {
    const t = buildSnapTargets({ composition: COMP });
    expect(snapPoint({ x: 958, y: 400 }, t, 6).point).toEqual({ x: 960, y: 400 });
  });

  it("snapValue snaps one axis (dragged guides)", () => {
    const t = buildSnapTargets({ composition: COMP });
    expect(snapValue("y", 537, t, 6)).toEqual({ value: 540, lines: [{ axis: "y", position: 540, source: "canvas" }] });
    expect(snapValue("x", 500, t, 6).value).toBe(500);
  });

  it("non-finite input or threshold never produces a snap (no NaN leaking into positions)", () => {
    const t = buildSnapTargets({ composition: COMP });
    expect(snapValue("x", NaN, t, 6).value).toBeNaN();
    expect(snapValue("x", NaN, t, 6).lines).toEqual([]);
    expect(snapRect({ x: 3, y: 3, width: 1, height: 1 }, t, 0)).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it("snapAngle pulls to right angles", () => {
    expect(snapAngle(88.5)).toBe(90);
    expect(snapAngle(80)).toBe(80);
    expect(snapAngle(-178)).toBe(-180);
  });
});

describe("alignment", () => {
  const comp = { x: 0, y: 0, width: 1920, height: 1080 };
  const b = { x: 100, y: 200, width: 300, height: 100 };
  it("aligns edges and centers to the target rect", () => {
    expect(alignDelta(b, comp, "left")).toEqual({ dx: -100, dy: 0 });
    expect(alignDelta(b, comp, "right")).toEqual({ dx: 1520, dy: 0 });
    expect(alignDelta(b, comp, "hcenter")).toEqual({ dx: 710, dy: 0 });
    expect(alignDelta(b, comp, "top")).toEqual({ dx: 0, dy: -200 });
    expect(alignDelta(b, comp, "vcenter")).toEqual({ dx: 0, dy: 290 });
    expect(alignDelta(b, comp, "bottom")).toEqual({ dx: 0, dy: 780 });
  });
});

describe("safe zones", () => {
  it("broadcast = 93% action / 90% title, centered", () => {
    const [action, title] = safeZones("broadcast", 1920, 1080);
    expect(action.rect.width).toBeCloseTo(1920 * 0.93, 9);
    expect(title.rect.x).toBeCloseTo(96, 9);
    expect(safeZones("off", 1920, 1080)).toEqual([]);
  });
});

describe("guides (undoable project state)", () => {
  it("add/move/remove are each one undo step", () => {
    const engine = new TimelineEngine(30);
    const add = engine.addGuide("x", 100);
    if (!add.ok) throw add.error;
    expect(engine.moveGuide(add.guide.id, 250).ok).toBe(true);
    expect(engine.timeline.guides).toEqual([{ id: add.guide.id, axis: "x", position: 250 }]);
    expect(engine.removeGuide(add.guide.id).ok).toBe(true);
    expect(engine.timeline.guides).toEqual([]);
    engine.undo();
    expect(engine.timeline.guides[0].position).toBe(250);
    engine.undo();
    expect(engine.timeline.guides[0].position).toBe(100);
    engine.undo();
    expect(engine.timeline.guides).toEqual([]);
    expect(engine.moveGuide("nope", 1).ok).toBe(false);
    expect(engine.addGuide("y", NaN).ok).toBe(false);
  });

  it("resetHistory makes the current state the baseline", () => {
    const engine = new TimelineEngine(30);
    engine.addGuide("x", 1);
    expect(engine.canUndo).toBe(true);
    engine.resetHistory();
    expect(engine.canUndo).toBe(false);
    expect(engine.timeline.guides).toHaveLength(1);
  });
});
