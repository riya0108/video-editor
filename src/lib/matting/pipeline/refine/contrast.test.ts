import { describe, it, expect } from "vitest";
import { applyAlphaContrast } from "./contrast";
import { TrimapLabel } from "./trimap";

describe("applyAlphaContrast", () => {
  it("amount 0 is a no-op copy", () => {
    const alpha = new Float32Array([0.2, 0.5, 0.8]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = applyAlphaContrast(alpha, trimap, 0);
    expect(Array.from(out)).toEqual(Array.from(alpha));
    expect(out).not.toBe(alpha);
  });

  it("positive amount sharpens: pushes values away from 0.5 toward the extremes", () => {
    const alpha = new Float32Array([0.3, 0.5, 0.7]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = applyAlphaContrast(alpha, trimap, 1); // factor = 2
    expect(out[0]).toBeCloseTo(0.1, 5); // 0.5 + (0.3-0.5)*2 = 0.1
    expect(out[1]).toBeCloseTo(0.5, 5); // midpoint never moves
    expect(out[2]).toBeCloseTo(0.9, 5); // 0.5 + (0.7-0.5)*2 = 0.9
  });

  it("negative amount softens: pulls values toward 0.5", () => {
    const alpha = new Float32Array([0.1, 0.9]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = applyAlphaContrast(alpha, trimap, -0.5); // factor = 0.5
    expect(out[0]).toBeCloseTo(0.3, 5); // 0.5 + (0.1-0.5)*0.5 = 0.3
    expect(out[1]).toBeCloseTo(0.7, 5); // 0.5 + (0.9-0.5)*0.5 = 0.7
  });

  it("clamps to [0,1] rather than overshooting", () => {
    const alpha = new Float32Array([0.05, 0.95]);
    const trimap = new Uint8Array([TrimapLabel.Unknown, TrimapLabel.Unknown]);
    const out = applyAlphaContrast(alpha, trimap, 5); // large sharpen factor
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
  });

  it("never touches pixels outside the unknown band", () => {
    const alpha = new Float32Array([0.3, 0.3, 0.3]);
    const trimap = new Uint8Array([TrimapLabel.Background, TrimapLabel.Unknown, TrimapLabel.Foreground]);
    const out = applyAlphaContrast(alpha, trimap, 2);
    expect(out[0]).toBe(alpha[0]); // background, untouched (exact same float32 value)
    expect(out[2]).toBe(alpha[2]); // foreground, untouched (exact same float32 value)
    expect(out[1]).not.toBe(alpha[1]); // unknown, actually contrast-adjusted
  });
});
