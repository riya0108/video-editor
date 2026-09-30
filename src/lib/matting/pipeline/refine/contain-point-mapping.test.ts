import { describe, it, expect } from "vitest";
import { mapPointIntoContainedCanvas } from "./contain-point-mapping";

describe("mapPointIntoContainedCanvas", () => {
  it("maps a click 1:1 when the box exactly matches the canvas's aspect ratio (no letterboxing)", () => {
    const rect = { left: 0, top: 0, width: 800, height: 450 }; // 16:9
    const canvas = { width: 1600, height: 900 }; // also 16:9, 2x scale
    const p = mapPointIntoContainedCanvas(400, 225, rect, canvas);
    expect(p.x).toBeCloseTo(800, 5);
    expect(p.y).toBeCloseTo(450, 5);
  });

  it("PRODUCTION READINESS (H2): correctly inverts top/bottom letterboxing for a wide box holding a portrait buffer", () => {
    // A 700-wide, 512-tall box (the panel's real max-h) holding a 480x854
    // portrait buffer: object-contain fits by height, so visible content is
    // only 512 * (480/854) ≈ 287.8px wide, centered with ~206.1px of
    // letterbox padding on each side.
    const rect = { left: 100, top: 50, width: 700, height: 512 };
    const canvas = { width: 480, height: 854 };

    const contentWidth = rect.height * (canvas.width / canvas.height);
    const offsetX = (rect.width - contentWidth) / 2;

    // A click at the exact center of the VISIBLE content should map to the
    // exact center of the buffer.
    const centerClientX = rect.left + offsetX + contentWidth / 2;
    const centerClientY = rect.top + rect.height / 2;
    const center = mapPointIntoContainedCanvas(centerClientX, centerClientY, rect, canvas);
    expect(center.x).toBeCloseTo(canvas.width / 2, 1);
    expect(center.y).toBeCloseTo(canvas.height / 2, 1);

    // A click at the very top-left corner of the visible content (NOT the
    // box's top-left corner, which sits inside the letterbox padding) should
    // map to the buffer's origin.
    const topLeftClientX = rect.left + offsetX;
    const topLeftClientY = rect.top;
    const topLeft = mapPointIntoContainedCanvas(topLeftClientX, topLeftClientY, rect, canvas);
    expect(topLeft.x).toBeCloseTo(0, 1);
    expect(topLeft.y).toBeCloseTo(0, 1);

    // The OLD (buggy) behavior — scaling directly off the full box — would
    // have placed this same corner click far from the buffer's actual edge
    // (0), proving the fix actually changes behavior for this shape.
    const oldBuggyX = (topLeftClientX - rect.left) * (canvas.width / rect.width);
    expect(Math.abs(oldBuggyX - topLeft.x)).toBeGreaterThan(100);
  });

  it("correctly inverts left/right letterboxing for a tall box holding a wide buffer", () => {
    const rect = { left: 0, top: 0, width: 300, height: 600 };
    const canvas = { width: 1920, height: 480 }; // very wide buffer

    const contentHeight = rect.width * (canvas.height / canvas.width);
    const offsetY = (rect.height - contentHeight) / 2;

    const centerClientX = rect.width / 2;
    const centerClientY = offsetY + contentHeight / 2;
    const center = mapPointIntoContainedCanvas(centerClientX, centerClientY, rect, canvas);
    expect(center.x).toBeCloseTo(canvas.width / 2, 0);
    expect(center.y).toBeCloseTo(canvas.height / 2, 0);
  });

  it("clamps out-of-bounds clicks (in the letterbox padding) to the buffer's edge instead of returning negative/overflowing coordinates", () => {
    const rect = { left: 0, top: 0, width: 700, height: 512 };
    const canvas = { width: 480, height: 854 };
    const clickInLeftPadding = mapPointIntoContainedCanvas(0, 256, rect, canvas);
    expect(clickInLeftPadding.x).toBe(0);
    expect(clickInLeftPadding.x).toBeGreaterThanOrEqual(0);
    expect(clickInLeftPadding.y).toBeGreaterThanOrEqual(0);
    expect(clickInLeftPadding.y).toBeLessThanOrEqual(canvas.height);
  });
});
