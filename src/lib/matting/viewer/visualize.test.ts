import { describe, it, expect } from "vitest";
import { alphaToGrayscaleRgba, compositeOverSolidColor, compositeOverCheckerboard, computeAlphaEdgeHeatmap, computeViewBuffer } from "./visualize";

describe("alphaToGrayscaleRgba", () => {
  it("maps alpha 0 to black and alpha 1 to white, fully opaque", () => {
    const alpha = new Float32Array([0, 1]);
    const out = alphaToGrayscaleRgba(alpha, 2, 1);
    expect([out[0], out[1], out[2], out[3]]).toEqual([0, 0, 0, 255]);
    expect([out[4], out[5], out[6], out[7]]).toEqual([255, 255, 255, 255]);
  });

  it("clamps out-of-range alpha instead of wrapping/NaN-ing", () => {
    const alpha = new Float32Array([-0.5, 1.5]);
    const out = alphaToGrayscaleRgba(alpha, 2, 1);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(255);
  });
});

describe("compositeOverSolidColor", () => {
  it("shows the foreground color exactly at alpha=1", () => {
    const rgba = new Uint8ClampedArray([200, 100, 50, 255]);
    const alpha = new Float32Array([1]);
    const out = compositeOverSolidColor(rgba, alpha, 1, 1, [0, 0, 0]);
    expect([out[0], out[1], out[2], out[3]]).toEqual([200, 100, 50, 255]);
  });

  it("shows the backdrop color exactly at alpha=0", () => {
    const rgba = new Uint8ClampedArray([200, 100, 50, 255]);
    const alpha = new Float32Array([0]);
    const out = compositeOverSolidColor(rgba, alpha, 1, 1, [10, 20, 30]);
    expect([out[0], out[1], out[2], out[3]]).toEqual([10, 20, 30, 255]);
  });

  it("blends linearly at alpha=0.5", () => {
    const rgba = new Uint8ClampedArray([200, 200, 200, 255]);
    const alpha = new Float32Array([0.5]);
    const out = compositeOverSolidColor(rgba, alpha, 1, 1, [0, 0, 0]);
    expect(out[0]).toBeCloseTo(100, 0);
  });

  it("is always fully opaque regardless of input alpha", () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255]);
    const alpha = new Float32Array([0.3]);
    const out = compositeOverSolidColor(rgba, alpha, 1, 1, [0, 0, 0]);
    expect(out[3]).toBe(255);
  });
});

describe("compositeOverCheckerboard", () => {
  it("shows one of the two known checker colors at alpha=0, depending on tile position", () => {
    const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(0);
    const alpha = new Float32Array(64 * 64).fill(0);
    const out = compositeOverCheckerboard(rgba, alpha, 64, 64);
    // top-left tile (0,0) and an adjacent tile one tile-width over must differ (checker alternates).
    const topLeft = [out[0], out[1], out[2]];
    const idx = 16 * 4; // one tile to the right, same row
    const nextTile = [out[idx], out[idx + 1], out[idx + 2]];
    expect(topLeft).not.toEqual(nextTile);
  });

  it("is always fully opaque", () => {
    const rgba = new Uint8ClampedArray(4 * 4).fill(0);
    const alpha = new Float32Array(4).fill(0.5);
    const out = compositeOverCheckerboard(rgba, alpha, 2, 2);
    expect(out[3]).toBe(255);
    expect(out[7]).toBe(255);
  });
});

describe("computeAlphaEdgeHeatmap", () => {
  it("is all zero for a perfectly flat alpha field (no edges anywhere)", () => {
    const width = 8;
    const height = 8;
    const alpha = new Float32Array(width * height).fill(0.5);
    const out = computeAlphaEdgeHeatmap(alpha, width, height);
    for (let i = 0; i < width * height; i++) expect(out[i * 4]).toBe(0);
  });

  it("lights up brightly at a hard 0/1 alpha boundary", () => {
    const width = 8;
    const height = 8;
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) alpha[y * width + x] = x < 4 ? 1 : 0;
    }
    const out = computeAlphaEdgeHeatmap(alpha, width, height);
    // A boundary pixel should be much brighter than a pixel deep in the flat interior.
    const boundaryIdx = (4 * width + 3) * 4;
    const interiorIdx = (4 * width + 1) * 4;
    expect(out[boundaryIdx]).toBeGreaterThan(out[interiorIdx]);
    expect(out[boundaryIdx]).toBeGreaterThan(200);
  });

  it("returns an all-zero, correctly-sized buffer for images smaller than a full 3x3 neighborhood", () => {
    const out = computeAlphaEdgeHeatmap(new Float32Array(4), 2, 2);
    expect(out.length).toBe(2 * 2 * 4);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it("normalizes to this image's own observed max, not a fixed absolute scale", () => {
    const width = 8;
    const height = 8;
    const weakEdge = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) weakEdge[y * width + x] = x < 4 ? 0.2 : 0;
    }
    const out = computeAlphaEdgeHeatmap(weakEdge, width, height);
    const boundaryIdx = (4 * width + 3) * 4;
    // Even a "weak" (small-magnitude) edge should still normalize up near the top of the 0-255 range,
    // since it's the strongest gradient present in this particular image.
    expect(out[boundaryIdx]).toBeGreaterThan(200);
  });
});

describe("computeViewBuffer", () => {
  it("dispatches to the correct underlying function for each mode", () => {
    const width = 2;
    const height = 2;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(100);
    const alpha = new Float32Array(width * height).fill(1);

    const alphaBuf = computeViewBuffer("alpha", rgba, alpha, width, height);
    expect(alphaBuf[0]).toBe(255); // alpha=1 -> white

    const blackBuf = computeViewBuffer("black", rgba, alpha, width, height);
    expect(blackBuf[0]).toBe(100); // alpha=1 -> shows foreground color as-is

    const whiteBuf = computeViewBuffer("white", rgba, alpha, width, height);
    expect(whiteBuf[0]).toBe(100);

    const checkerBuf = computeViewBuffer("checkerboard", rgba, alpha, width, height);
    expect(checkerBuf[0]).toBe(100);

    const edgeBuf = computeViewBuffer("edge", rgba, alpha, width, height);
    expect(edgeBuf.length).toBe(width * height * 4);
  });
});
