import { describe, it, expect } from "vitest";
import { computeStrokeCoverage } from "./brush-stamp";

describe("computeStrokeCoverage", () => {
  it("returns null for an empty path", () => {
    expect(computeStrokeCoverage([], 100, 100, { size: 10, hardness: 1 })).toBeNull();
  });

  it("returns null for a stroke entirely outside the image", () => {
    expect(computeStrokeCoverage([{ x: -100, y: -100 }], 50, 50, { size: 5, hardness: 1 })).toBeNull();
  });

  it("a hard brush (hardness 1) is full strength everywhere inside the radius and zero outside it", () => {
    const stroke = computeStrokeCoverage([{ x: 20, y: 20 }], 50, 50, { size: 10, hardness: 1 });
    expect(stroke).not.toBeNull();
    const at = (x: number, y: number) => stroke!.coverage[(y - stroke!.minY) * stroke!.width + (x - stroke!.minX)];
    expect(at(20, 20)).toBe(1);
    expect(at(25, 20)).toBe(1); // distance 5, inside radius 10
    expect(at(31, 20)).toBe(0); // distance 11, outside radius 10
  });

  it("a soft brush (hardness 0) falls off from full strength at the center to zero at the radius", () => {
    const stroke = computeStrokeCoverage([{ x: 20, y: 20 }], 50, 50, { size: 10, hardness: 0 });
    const at = (x: number, y: number) => stroke!.coverage[(y - stroke!.minY) * stroke!.width + (x - stroke!.minX)];
    expect(at(20, 20)).toBeCloseTo(1, 5);
    expect(at(25, 20)).toBeCloseTo(0.5, 1); // halfway to the radius
    expect(at(30, 20)).toBeCloseTo(0, 1); // at the radius
  });

  it("intermediate hardness keeps a flat-top plateau before ramping down", () => {
    const stroke = computeStrokeCoverage([{ x: 20, y: 20 }], 50, 50, { size: 10, hardness: 0.5 });
    const at = (x: number, y: number) => stroke!.coverage[(y - stroke!.minY) * stroke!.width + (x - stroke!.minX)];
    expect(at(24, 20)).toBe(1); // distance 4, inside the size*hardness=5 plateau
    expect(at(30, 20)).toBeCloseTo(0, 1); // at the outer radius
  });

  it("a multi-point path takes the MAX coverage across all points (no self-darkening within one stroke)", () => {
    const path = [
      { x: 20, y: 20 },
      { x: 24, y: 20 },
    ];
    const stroke = computeStrokeCoverage(path, 50, 50, { size: 10, hardness: 1 });
    const at = (x: number, y: number) => stroke!.coverage[(y - stroke!.minY) * stroke!.width + (x - stroke!.minX)];
    // Overlap region between the two stamps stays at 1, not >1 (Float32 can't exceed 1 anyway, but confirms max- not sum-blending).
    expect(at(22, 20)).toBe(1);
  });

  it("the coverage buffer is sized to the stroke's own bounding box, not the full image — 'local update', not full-canvas recompute", () => {
    const stroke = computeStrokeCoverage([{ x: 50, y: 50 }], 2000, 2000, { size: 5, hardness: 1 });
    expect(stroke).not.toBeNull();
    expect(stroke!.coverage.length).toBeLessThan(2000 * 2000);
    expect(stroke!.coverage.length).toBe(stroke!.width * stroke!.height);
    expect(stroke!.width).toBeLessThan(20);
    expect(stroke!.height).toBeLessThan(20);
  });

  it("clamps the bounding box to the image bounds near an edge", () => {
    const stroke = computeStrokeCoverage([{ x: 2, y: 2 }], 50, 50, { size: 10, hardness: 1 });
    expect(stroke!.minX).toBe(0);
    expect(stroke!.minY).toBe(0);
  });
});
