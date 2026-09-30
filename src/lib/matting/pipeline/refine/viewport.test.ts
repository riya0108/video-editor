import { describe, it, expect } from "vitest";
import { imageToScreen, screenToImage, clampZoom, zoomAt, pan, DEFAULT_VIEWPORT_STATE } from "./viewport";

describe("imageToScreen / screenToImage", () => {
  it("round-trips a point through zoom and pan", () => {
    const viewport = { zoom: 2, panX: 10, panY: -5 };
    const image = { x: 30, y: 40 };
    const screen = imageToScreen(image, viewport);
    expect(screen).toEqual({ x: 70, y: 75 });
    const back = screenToImage(screen, viewport);
    expect(back.x).toBeCloseTo(image.x, 10);
    expect(back.y).toBeCloseTo(image.y, 10);
  });

  it("the default viewport (zoom 1, no pan) is the identity transform", () => {
    const p = { x: 12, y: 34 };
    expect(imageToScreen(p, DEFAULT_VIEWPORT_STATE)).toEqual(p);
    expect(screenToImage(p, DEFAULT_VIEWPORT_STATE)).toEqual(p);
  });
});

describe("clampZoom", () => {
  it("clamps to the given bounds", () => {
    expect(clampZoom(0.01, 0.1, 32)).toBe(0.1);
    expect(clampZoom(100, 0.1, 32)).toBe(32);
    expect(clampZoom(2, 0.1, 32)).toBe(2);
  });
});

describe("zoomAt", () => {
  it("keeps the image point under the screen anchor fixed on screen after zooming", () => {
    const viewport = { zoom: 1, panX: 0, panY: 0 };
    const anchor = { x: 100, y: 100 };
    const imageUnderAnchorBefore = screenToImage(anchor, viewport);

    const zoomed = zoomAt(viewport, anchor, 4);

    const screenOfSamePointAfter = imageToScreen(imageUnderAnchorBefore, zoomed);
    expect(screenOfSamePointAfter.x).toBeCloseTo(anchor.x, 6);
    expect(screenOfSamePointAfter.y).toBeCloseTo(anchor.y, 6);
    expect(zoomed.zoom).toBe(4);
  });

  it("respects the zoom clamp bounds", () => {
    const zoomed = zoomAt(DEFAULT_VIEWPORT_STATE, { x: 0, y: 0 }, 1000, 0.1, 8);
    expect(zoomed.zoom).toBe(8);
  });
});

describe("pan", () => {
  it("shifts panX/panY by the given screen-space delta", () => {
    const viewport = { zoom: 2, panX: 5, panY: 5 };
    const panned = pan(viewport, 10, -3);
    expect(panned).toEqual({ zoom: 2, panX: 15, panY: 2 });
  });
});
