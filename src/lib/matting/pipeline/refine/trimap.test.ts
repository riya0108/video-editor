import { describe, it, expect } from "vitest";
import { buildTrimap, buildFineDetailMask, TrimapLabel, DEFAULT_TRIMAP_OPTIONS } from "./trimap";

describe("buildTrimap", () => {
  it("classifies low alpha as background, high alpha as foreground, and mid alpha as unknown", () => {
    // Deliberately avoids the exact threshold values (0.1/0.9) themselves —
    // 0.1 and 0.9 don't round-trip exactly through Float32Array (e.g. the
    // float32 nearest to 0.1 is very slightly *above* the double 0.1), so a
    // boundary-inclusive comparison against the raw double threshold is
    // flaky by construction, not a real bug. These values sit clearly on
    // one side or the other with enough margin to survive that rounding.
    const alpha = new Float32Array([0, 0.05, 0.5, 0.95, 1]);
    const trimap = buildTrimap(alpha, 5, 1, DEFAULT_TRIMAP_OPTIONS);
    expect(Array.from(trimap)).toEqual([
      TrimapLabel.Background, // 0
      TrimapLabel.Background, // 0.05
      TrimapLabel.Unknown, // 0.5
      TrimapLabel.Foreground, // 0.95
      TrimapLabel.Foreground, // 1
    ]);
  });

  it("respects custom thresholds", () => {
    const alpha = new Float32Array([0.2, 0.4, 0.6, 0.8]);
    const trimap = buildTrimap(alpha, 4, 1, { backgroundThreshold: 0.3, foregroundThreshold: 0.7 });
    expect(Array.from(trimap)).toEqual([TrimapLabel.Background, TrimapLabel.Unknown, TrimapLabel.Unknown, TrimapLabel.Foreground]);
  });
});

describe("buildFineDetailMask", () => {
  const WIDTH = 10;
  const HEIGHT = 10;

  function makeFlatRgba(gray: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba[i * 4] = gray;
      rgba[i * 4 + 1] = gray;
      rgba[i * 4 + 2] = gray;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  /**
   * A deterministic (not Math.random — reproducible across runs), genuinely
   * high-frequency pattern. NOT a period-2 checkerboard/stripe: a plain
   * Sobel kernel has a mathematical blind spot at exactly the Nyquist
   * frequency (alternating every single pixel) — a 3-wide symmetric
   * derivative kernel's response to a period-2 signal is identically zero,
   * since the kernel's two "outer" taps land on identical values one full
   * period apart in both directions. This is a real, well-known property of
   * discrete derivative filters, not a bug — discovered here by a test that
   * initially (incorrectly) used a checkerboard and got exactly zero energy
   * everywhere. A period-5 pattern has no such alignment with a radius-1 kernel.
   */
  function makeNoisyRgba(): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const gray = ((x * 97 + y * 61) % 5) * 60;
        const o = (y * WIDTH + x) * 4;
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  it("does not flag a flat (textureless) region as fine-detail", () => {
    const rgba = makeFlatRgba(128);
    const mask = buildFineDetailMask(rgba, WIDTH, HEIGHT);
    expect(Array.from(mask).every((v) => v === 0)).toBe(true);
  });

  it("flags a real high-frequency region", () => {
    const mask = buildFineDetailMask(makeNoisyRgba(), WIDTH, HEIGHT);
    let flagged = 0;
    for (const v of mask) if (v) flagged++;
    expect(flagged).toBeGreaterThan(0);
  });

  it("takes no trimap parameter — fine-detail classification depends only on image content", () => {
    // A confidently-opaque (trimap FOREGROUND) hair strand must still be
    // flagged fine-detail, since island cleanup needs to protect it
    // regardless of how confident the model's alpha was there — this is a
    // real design fix, found while writing the Phase 2 visual-regression
    // tests, for a gap where fine-detail was originally (incorrectly)
    // restricted to the unknown band only.
    const mask = buildFineDetailMask(makeNoisyRgba(), WIDTH, HEIGHT);
    expect(Array.from(mask).some((v) => v === 1)).toBe(true);
  });
});
