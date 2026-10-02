import { describe, expect, it } from "vitest";
import { applyToPoint, compose, invert, multiply, rotateDegrees, scale, transformedBounds, translate, IDENTITY } from "./matrix";

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe("matrix", () => {
  it("multiply applies the right operand first", () => {
    const m = multiply(translate(10, 0), scale(2));
    // scale first: (1,1) -> (2,2), then translate -> (12,2)
    close(applyToPoint(m, { x: 1, y: 1 }), { x: 12, y: 2 });
    const n = multiply(scale(2), translate(10, 0));
    close(applyToPoint(n, { x: 1, y: 1 }), { x: 22, y: 2 });
  });

  it("rotates clockwise in y-down space and snaps quarter turns exactly", () => {
    const r = rotateDegrees(90);
    expect(r).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    // +x axis rotates onto +y (down) — clockwise on screen.
    expect(applyToPoint(r, { x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
    expect(rotateDegrees(180)).toEqual({ a: -1, b: 0, c: -0, d: -1, e: 0, f: 0 });
  });

  it("invert round-trips arbitrary affine transforms", () => {
    const m = compose(translate(37, -12), rotateDegrees(33), scale(1.7, 0.4), translate(-5, 9));
    const inv = invert(m)!;
    for (const p of [{ x: 0, y: 0 }, { x: 123.5, y: -7 }, { x: -1e3, y: 42 }]) {
      close(applyToPoint(inv, applyToPoint(m, p)), p);
    }
    const id = multiply(m, inv);
    expect(id.a).toBeCloseTo(1, 12);
    expect(id.d).toBeCloseTo(1, 12);
    expect(id.e).toBeCloseTo(0, 9);
  });

  it("invert returns null for singular matrices instead of dividing by zero", () => {
    expect(invert(scale(0, 1))).toBeNull();
    expect(invert(IDENTITY)).toEqual({ a: 1, b: -0, c: -0, d: 1, e: 0, f: 0 });
  });

  it("transformedBounds covers a rotated rect", () => {
    const b = transformedBounds(rotateDegrees(45), { x: 0, y: 0, width: 10, height: 10 });
    const diag = 10 * Math.SQRT2;
    expect(b.width).toBeCloseTo(diag, 9);
    expect(b.height).toBeCloseTo(diag, 9);
    expect(b.x).toBeCloseTo(-diag / 2, 9);
  });
});
