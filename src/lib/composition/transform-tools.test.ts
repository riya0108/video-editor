import { describe, expect, it } from "vitest";
import { applyVisualPatch, defaultClipVisual, type ClipVisual } from "../timeline/visual";
import { applyToPoint } from "./matrix";
import { layerMatrix, fitBox } from "./resolve";
import {
  boxToComp,
  compToBox,
  cropFromHandle,
  handleBoxPoint,
  handleCompPoints,
  handleCursor,
  layerSize,
  MIN_SCALE,
  moveAnchorTo,
  normalizeAngle,
  resizeFromHandle,
  rotateFromPointer,
  setAnchorNormalized,
  setLayerSize,
  visibleBoxRect,
  visibleBounds,
} from "./transform-tools";

const BOX = { width: 400, height: 200 };
const near = (a: { x: number; y: number }, b: { x: number; y: number }, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

function styled(patch: Parameters<typeof applyVisualPatch>[1]): ClipVisual {
  return applyVisualPatch(defaultClipVisual(1920, 1080), patch);
}

const CASES: ClipVisual[] = [
  styled({}),
  styled({ transform: { x: 300, y: 700, rotation: 33, scaleX: 1.7, scaleY: 0.6, anchorX: 0.2, anchorY: 0.9 } }),
  styled({ transform: { rotation: -120, flipX: true, scaleX: 0.5, scaleY: 2 }, crop: { left: 0.1, bottom: 0.3 } }),
  styled({ transform: { rotation: 90, flipY: true, anchorX: 0, anchorY: 0 } }),
];

describe("box space", () => {
  it("boxToComp agrees exactly with the renderer's layerMatrix (content == box here)", () => {
    for (const v of CASES) {
      const m = layerMatrix(BOX.width, BOX.height, BOX.width, BOX.height, v);
      for (const u of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 123, y: 77 }, { x: 400, y: 200 }]) near(boxToComp(v, BOX, u), applyToPoint(m, u));
    }
  });

  it("also agrees when content size differs from box size (fit scaling)", () => {
    const content = { width: 1280, height: 720 };
    const box = fitBox(content.width, content.height, 1920, 1080, "contain");
    const v = CASES[1];
    const m = layerMatrix(content.width, content.height, box.width, box.height, v);
    // content (640,360) is box (960,540)
    near(boxToComp(v, box, { x: 960, y: 540 }), applyToPoint(m, { x: 640, y: 360 }));
  });

  it("compToBox inverts boxToComp", () => {
    for (const v of CASES) near(compToBox(v, BOX, boxToComp(v, BOX, { x: 37, y: 150 })), { x: 37, y: 150 });
  });
});

describe("width/height", () => {
  it("is box x scale, and setting it changes scale only (anchor stays put)", () => {
    const v = CASES[1];
    expect(layerSize(v, BOX)).toEqual({ width: 400 * 1.7, height: 200 * 0.6 });
    const sized = setLayerSize(v, BOX, { width: 200 }, false);
    expect(sized.transform.scaleX).toBeCloseTo(0.5, 12);
    expect(sized.transform.scaleY).toBe(0.6);
    expect([sized.transform.x, sized.transform.y]).toEqual([v.transform.x, v.transform.y]);
  });

  it("keepAspect preserves the current scale ratio", () => {
    const v = CASES[1];
    const sized = setLayerSize(v, BOX, { height: 60 }, true);
    expect(sized.transform.scaleY).toBeCloseTo(0.3, 12);
    expect(sized.transform.scaleX / sized.transform.scaleY).toBeCloseTo(1.7 / 0.6, 9);
  });
});

describe("resizeFromHandle", () => {
  it("keeps the opposite handle fixed on screen under rotation, flip and crop", () => {
    for (const v of CASES) {
      for (const h of ["se", "nw", "e", "n"] as const) {
        const opposite = { se: "nw", nw: "se", e: "w", n: "s" }[h] as typeof h;
        const before = handleCompPoints(v, BOX)[opposite];
        const target = { x: before.x + 137, y: before.y - 59 };
        const after = resizeFromHandle(v, BOX, h, target, { keepAspect: false, fromAnchor: false });
        near(handleCompPoints(after, BOX)[opposite], before);
      }
    }
  });

  it("free corner resize lands the dragged corner exactly on the pointer", () => {
    const v = CASES[1];
    const pointer = { x: 900, y: 300 };
    const after = resizeFromHandle(v, BOX, "ne", pointer, { keepAspect: false, fromAnchor: false });
    near(handleCompPoints(after, BOX).ne, pointer);
  });

  it("edge handles change only their own axis", () => {
    const v = CASES[1];
    const after = resizeFromHandle(v, BOX, "e", { x: 2000, y: -400 }, { keepAspect: false, fromAnchor: false });
    expect(after.transform.scaleY).toBe(v.transform.scaleY);
    expect(after.transform.scaleX).not.toBe(v.transform.scaleX);
  });

  it("keepAspect scales both axes by one factor", () => {
    const v = CASES[1];
    const after = resizeFromHandle(v, BOX, "se", { x: 1500, y: 900 }, { keepAspect: true, fromAnchor: false });
    expect(after.transform.scaleX / after.transform.scaleY).toBeCloseTo(v.transform.scaleX / v.transform.scaleY, 9);
  });

  it("fromAnchor keeps the anchor (position) fixed", () => {
    const v = CASES[1];
    const after = resizeFromHandle(v, BOX, "se", { x: 1500, y: 900 }, { keepAspect: false, fromAnchor: true });
    expect(after.transform.x).toBeCloseTo(v.transform.x, 9);
    expect(after.transform.y).toBeCloseTo(v.transform.y, 9);
  });

  it("dragging past the fixed point clamps instead of inverting", () => {
    const v = styled({});
    const nw = handleCompPoints(v, BOX).nw;
    const after = resizeFromHandle(v, BOX, "se", { x: nw.x - 500, y: nw.y - 500 }, { keepAspect: false, fromAnchor: false });
    expect(after.transform.scaleX).toBe(MIN_SCALE);
    expect(after.transform.flipX).toBe(false);
  });
});

describe("rotation", () => {
  it("rotates about the anchor by the swept angle, with optional step snapping", () => {
    const v = styled({ transform: { x: 100, y: 100, rotation: 10 } });
    const r = rotateFromPointer(v, { x: 200, y: 100 }, { x: 100, y: 200 });
    expect(r.transform.rotation).toBeCloseTo(100, 9);
    expect([r.transform.x, r.transform.y]).toEqual([100, 100]);
    const snapped = rotateFromPointer(v, { x: 200, y: 100 }, { x: 180, y: 150 }, 15);
    expect(snapped.transform.rotation % 15).toBe(0);
  });

  it("normalizes to (-180, 180]", () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(720)).toBe(0);
  });
});

describe("anchor", () => {
  it("moving the anchor never moves the layer", () => {
    for (const v of CASES) {
      const m0 = layerMatrix(BOX.width, BOX.height, BOX.width, BOX.height, v);
      const moved = moveAnchorTo(v, BOX, { x: 812, y: 133 });
      const m1 = layerMatrix(BOX.width, BOX.height, BOX.width, BOX.height, moved);
      for (const k of ["a", "b", "c", "d", "e", "f"] as const) expect(m1[k]).toBeCloseTo(m0[k], 6);
      expect([moved.transform.x, moved.transform.y]).toEqual([812, 133]);
    }
  });

  it("9-point presets land the anchor on the box point, layer unmoved", () => {
    const v = CASES[1];
    const a = setAnchorNormalized(v, BOX, 1, 1);
    expect(a.transform.anchorX).toBeCloseTo(1, 9);
    expect(a.transform.anchorY).toBeCloseTo(1, 9);
    near(boxToComp(a, BOX, { x: 0, y: 0 }), boxToComp(v, BOX, { x: 0, y: 0 }));
  });
});

describe("crop handles", () => {
  it("drag the dragged edge to the pointer without moving or scaling the layer", () => {
    const v = CASES[1];
    const pointer = boxToComp(v, BOX, { x: 100, y: 50 });
    const c = cropFromHandle(v, BOX, "nw", pointer);
    expect(c.crop.left).toBeCloseTo(0.25, 9);
    expect(c.crop.top).toBeCloseTo(0.25, 9);
    expect(c.transform).toEqual(v.transform);
    near(handleCompPoints(c, BOX).nw, pointer);
  });

  it("an edge cannot cross the opposite edge", () => {
    const v = styled({ crop: { right: 0.5 } });
    const c = cropFromHandle(v, BOX, "w", boxToComp(v, BOX, { x: 390, y: 100 }));
    expect(c.crop.left + c.crop.right).toBeLessThanOrEqual(0.99 + 1e-9);
    expect(c.crop.right).toBe(0.5);
  });
});

describe("misc", () => {
  it("handles sit on the visible (cropped) rect", () => {
    const v = CASES[2];
    const r = visibleBoxRect(v, BOX);
    near(handleCompPoints(v, BOX).nw, boxToComp(v, BOX, handleBoxPoint(r, "nw")));
  });

  it("resize cursors follow rotation", () => {
    expect(handleCursor(styled({}), BOX, "e")).toBe("ew-resize");
    expect(handleCursor(styled({ transform: { rotation: 90 } }), BOX, "e")).toBe("ns-resize");
    expect(handleCursor(styled({}), BOX, "se")).toBe("nwse-resize");
  });

  it("visibleBounds of an unrotated layer is its rect", () => {
    expect(visibleBounds(styled({ transform: { x: 500, y: 500 } }), BOX)).toEqual({ x: 300, y: 400, width: 400, height: 200 });
  });
});
