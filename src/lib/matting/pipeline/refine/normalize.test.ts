import { describe, it, expect } from "vitest";
import { normalizeAlpha } from "./normalize";

describe("normalizeAlpha", () => {
  it("clamps values above 1 and below 0", () => {
    const out = normalizeAlpha(new Float32Array([-0.5, 0, 0.5, 1, 1.5]));
    expect(Array.from(out)).toEqual([0, 0, 0.5, 1, 1]);
  });

  it("replaces NaN and Infinity with 0 rather than propagating them", () => {
    const out = normalizeAlpha(new Float32Array([NaN, Infinity, -Infinity, 0.3]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(0.3, 5); // 0.3 doesn't round-trip exactly through Float32Array
  });

  it("returns a new array, never the same reference", () => {
    const input = new Float32Array([0.2, 0.4]);
    const out = normalizeAlpha(input);
    expect(out).not.toBe(input);
  });

  it("does not mutate its input", () => {
    const input = new Float32Array([-1, 2]);
    normalizeAlpha(input);
    expect(Array.from(input)).toEqual([-1, 2]);
  });
});
