import { describe, it, expect } from "vitest";
import {
  computeForegroundMask,
  computeHoleMask,
  computeBoundaryMask,
  computeTrimap,
  computeMotionMask,
  computeAlphaFlickerScore,
  computeEdgeJitterScore,
  computeSilhouetteInstabilityScore,
  computeHairInstabilityScore,
  computeSuddenOpacityChanges,
  computeMaskPoppingScore,
  computeTemporalHolesScore,
  computeTemporalLeakageVolatility,
} from "./temporal-quality-signals";

const W = 20;
const H = 20;

function flatRgba(gray: number, width = W, height = H): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("computeForegroundMask / computeHoleMask", () => {
  it("finds an enclosed background pocket inside a solid foreground block", () => {
    const alpha = new Float32Array(W * H).fill(0);
    for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) alpha[y * W + x] = 1;
    for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) alpha[y * W + x] = 0;

    const holeMask = computeHoleMask(alpha, W, H);
    expect(holeMask[9 * W + 9]).toBe(1);
    expect(holeMask[0]).toBe(0); // real exterior background, not a hole
  });
});

describe("computeBoundaryMask", () => {
  it("marks a hard alpha step as a boundary and leaves the flat interior/exterior alone", () => {
    const alpha = new Float32Array(W * H).fill(0);
    for (let y = 0; y < H; y++) for (let x = 10; x < W; x++) alpha[y * W + x] = 1;
    const trimap = computeTrimap(alpha, W, H);
    const boundary = computeBoundaryMask(trimap, W, H);
    expect(boundary[10 * W + 10]).toBe(1);
    expect(boundary[10 * W + 2]).toBe(0);
    expect(boundary[10 * W + 18]).toBe(0);
  });
});

describe("computeMotionMask", () => {
  it("reports near-zero motion for identical frames and full motion for a drastic change", () => {
    const a = flatRgba(100);
    const b = flatRgba(100);
    const c = flatRgba(250);
    expect(computeMotionMask(b, a)[0]).toBe(0);
    expect(computeMotionMask(c, a)[0]).toBe(1);
  });
});

describe("computeAlphaFlickerScore", () => {
  it("flags a pixel that oscillates (up then down) across three frames with no image motion", () => {
    const a0 = new Float32Array(4).fill(0.2);
    const a1 = new Float32Array(4).fill(0.8);
    const a2 = new Float32Array(4).fill(0.2);
    const motion = new Float32Array(4).fill(0);
    const result = computeAlphaFlickerScore(a0, a1, a2, motion);
    expect(result.score).toBe(1);
    expect(result.flickerPixelCount).toBe(4);
  });

  it("does not flag a monotonic (real, sustained) change", () => {
    const a0 = new Float32Array(4).fill(0.2);
    const a1 = new Float32Array(4).fill(0.5);
    const a2 = new Float32Array(4).fill(0.9);
    const motion = new Float32Array(4).fill(0);
    const result = computeAlphaFlickerScore(a0, a1, a2, motion);
    expect(result.score).toBe(0);
  });

  it("excludes pixels gated by real motion from the sample entirely", () => {
    const a0 = new Float32Array(4).fill(0.2);
    const a1 = new Float32Array(4).fill(0.8);
    const a2 = new Float32Array(4).fill(0.2);
    const motion = new Float32Array(4).fill(1); // fully moving -> gated out
    const result = computeAlphaFlickerScore(a0, a1, a2, motion);
    expect(result.sampleCount).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe("computeEdgeJitterScore", () => {
  it("is zero for an unchanged boundary and positive for a shifted one", () => {
    const boundaryA = new Uint8Array([0, 1, 1, 0]);
    expect(computeEdgeJitterScore(boundaryA, boundaryA).score).toBe(0);

    const boundaryB = new Uint8Array([1, 1, 0, 0]);
    expect(computeEdgeJitterScore(boundaryA, boundaryB).score).toBeGreaterThan(0);
  });
});

describe("computeSilhouetteInstabilityScore", () => {
  it("scores near zero when an area change is proportional to real measured motion", () => {
    const result = computeSilhouetteInstabilityScore(1000, 1000, 0); // no motion, no area change
    expect(result.score).toBe(0);
  });

  it("scores high when area changes a lot despite near-zero measured motion", () => {
    const result = computeSilhouetteInstabilityScore(1000, 400, 0);
    expect(result.score).toBeGreaterThan(0.5);
  });
});

describe("computeHairInstabilityScore", () => {
  it("scores 0 (IoU 1) for identical hair masks and reports noHairDetected when both are empty", () => {
    const empty = new Uint8Array(10);
    expect(computeHairInstabilityScore(empty, empty).noHairDetected).toBe(true);

    const mask = new Uint8Array([1, 1, 0, 0]);
    const result = computeHairInstabilityScore(mask, mask);
    expect(result.score).toBe(0);
    expect(result.iou).toBe(1);
  });

  it("scores 1 (IoU 0) for completely disjoint hair masks", () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 0, 1, 1]);
    const result = computeHairInstabilityScore(a, b);
    expect(result.score).toBe(1);
    expect(result.iou).toBe(0);
  });
});

describe("computeSuddenOpacityChanges", () => {
  it("flags a region where alpha jumped a lot despite near-zero motion, and returns its bounding box", () => {
    const prev = new Float32Array(W * H).fill(0);
    const curr = new Float32Array(W * H).fill(0);
    for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) curr[y * W + x] = 1;
    const motion = new Float32Array(W * H).fill(0);

    const result = computeSuddenOpacityChanges(prev, curr, motion, W, H);
    expect(result.count).toBe(9);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toEqual({ x: 5, y: 5, width: 3, height: 3 });
  });
});

describe("computeMaskPoppingScore", () => {
  it("flags a new disconnected blob with no spatial overlap as popped-in", () => {
    const prev = new Uint8Array(W * H).fill(0);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) prev[y * W + x] = 1;
    const curr = prev.slice();
    for (let y = 15; y < 18; y++) for (let x = 15; x < 18; x++) curr[y * W + x] = 1; // a whole new chunk, far away

    const result = computeMaskPoppingScore(prev, curr, W, H, 9 + 9);
    expect(result.poppedInArea).toBe(9);
    expect(result.poppedOutArea).toBe(0);
    expect(result.score).toBeGreaterThan(0);
  });

  it("does not flag ordinary movement of the same blob (substantial overlap survives)", () => {
    const prev = new Uint8Array(W * H).fill(0);
    for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) prev[y * W + x] = 1;
    const curr = new Uint8Array(W * H).fill(0);
    for (let y = 5; y < 10; y++) for (let x = 6; x < 11; x++) curr[y * W + x] = 1; // shifted by 1px, mostly overlapping

    const result = computeMaskPoppingScore(prev, curr, W, H, 25);
    expect(result.poppedInArea).toBe(0);
    expect(result.poppedOutArea).toBe(0);
  });
});

describe("computeTemporalHolesScore", () => {
  it("flags a hole present only in the middle frame as transient", () => {
    const prev = new Uint8Array(W * H).fill(0);
    const next = new Uint8Array(W * H).fill(0);
    const curr = new Uint8Array(W * H).fill(0);
    for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) curr[y * W + x] = 1;

    const result = computeTemporalHolesScore(prev, curr, next, W, 200);
    expect(result.transientHoleArea).toBe(9);
    expect(result.regions).toHaveLength(1);
  });

  it("does not flag a hole present across all three frames as transient", () => {
    const mask = new Uint8Array(W * H).fill(0);
    for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) mask[y * W + x] = 1;
    const result = computeTemporalHolesScore(mask, mask, mask, W, 200);
    expect(result.transientHoleArea).toBe(0);
  });
});

describe("computeTemporalLeakageVolatility", () => {
  it("scores low for a stable leakage history and high for a volatile one", () => {
    const stable = computeTemporalLeakageVolatility([0.1, 0.1, 0.1, 0.11, 0.09]);
    const volatile = computeTemporalLeakageVolatility([0, 0.5, 0, 0.5, 0]);
    expect(stable.score).toBeLessThan(volatile.score);
  });
});
