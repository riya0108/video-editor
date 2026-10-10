import { describe, expect, it } from "vitest";
import { applyEffects, boxPass } from "../effects/process";
import type { EvaluatedEffect } from "../effects/process";

/** Kernel timings (PERF=1 npx vitest run src/lib/perf/kernels.test.ts) — the region a 900×140 lower third with blur 6 processes at full res. */
const W = 940;
const H = 180;
function input(): Float32Array {
  const buf = new Float32Array(W * H * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = ((i * 7919) % 255) / 255;
  return buf;
}
const ctx = { width: W, height: H, renderScale: 1, frame: 0, originX: 0, originY: 0, layerRect: { x: 10, y: 10, width: 900, height: 140 } };
const fx = (type: string, params: Record<string, number>): EvaluatedEffect[] => [{ id: "e", type, params } as EvaluatedEffect];

describe.runIf(process.env.PERF)("effect kernel timings", () => {
  for (const [type, params] of [["blur", { radius: 6 }], ["blur", { radius: 40 }], ["brightness", { amount: 0.1 }], ["glow", { radius: 10, intensity: 0.5, threshold: 0.6 }], ["sharpen", { radius: 2, amount: 0.5 }]] as const) {
    it(`${type} ${JSON.stringify(params)}`, () => {
      const src = input();
      const s: number[] = [];
      for (let k = 0; k < 15; k++) {
        const b = src.slice();
        const t = performance.now();
        applyEffects(b, fx(type, params), ctx);
        s.push(performance.now() - t);
      }
      s.sort((a, b) => a - b);
      console.log(`${type} ${JSON.stringify(params)}: ${s[7].toFixed(2)} ms (p50 of 15)`);
      expect(s[7]).toBeGreaterThan(0);
    });
  }
});

/** The pre-Phase-18 box pass, verbatim — the reference the optimized one must match bit for bit. */
function referenceBoxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const norm = 1 / (2 * r + 1);
  const last = len - 1;
  for (let line = 0; line < lines; line++) {
    const idx = (k: number) => {
      const kk = k < 0 ? 0 : k > last ? last : k;
      return horizontal ? (line * w + kk) * 4 : (kk * w + line) * 4;
    };
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[idx(k) + c];
      for (let k = 0; k < len; k++) {
        dst[idx(k) + c] = acc * norm;
        acc += src[idx(k + r + 1) + c] - src[idx(k - r) + c];
      }
    }
  }
}

describe("optimized box pass", () => {
  it("is bit-identical to the reference for every shape, radius and axis (incl. radius > size)", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const [w, h] of [[1, 1], [1, 9], [9, 1], [17, 5], [64, 33], [200, 120]]) {
      const src = new Float32Array(w * h * 4).map(() => rnd());
      for (const r of [1, 2, 3, 7, 40]) {
        for (const horizontal of [true, false]) {
          const a = new Float32Array(src.length);
          const b = new Float32Array(src.length);
          referenceBoxPass(src, a, w, h, r, horizontal);
          boxPass(src, b, w, h, r, horizontal);
          expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer)), `${w}x${h} r=${r} ${horizontal ? "h" : "v"}`).toBe(true);
        }
      }
    }
  });
});


describe.runIf(process.env.PERF)("mask raster timings", () => {
  it("feathered ellipse over a PiP-sized region", async () => {
    const { polygonCoverage, signedDistanceField, nearestFeatureTransform, shapeCoverage, influenceMargin } = await import("../masks/raster");
    const region = { x: 1100, y: 70, width: 780, height: 460 };
    const poly = Array.from({ length: 64 }, (_, k) => ({ x: 1490 + 380 * Math.cos((2 * Math.PI * k) / 64), y: 300 + 225 * Math.sin((2 * Math.PI * k) / 64) }));
    const m = { polygon: poly, feather: 24, expansion: 0 };
    const pad = influenceMargin(m);
    const big = { x: region.x - pad, y: region.y - pad, width: region.width + 2 * pad, height: region.height + 2 * pad };
    const t = (label: string, fn: () => void) => {
      const s: number[] = [];
      for (let k = 0; k < 7; k++) { const t0 = performance.now(); fn(); s.push(performance.now() - t0); }
      s.sort((a, b) => a - b);
      console.log(`${label}: ${s[3].toFixed(2)} ms`);
    };
    const cov = polygonCoverage(poly, big);
    const feature = new Uint8Array(cov.length).map((_, i) => (cov[i] > 0 && cov[i] < 1 ? 1 : 0));
    console.log("pad", pad, "big", big.width, big.height);
    t("polygonCoverage", () => polygonCoverage(poly, big));
    t("nearestFeatureTransform", () => nearestFeatureTransform(feature, big.width, big.height));
    t("signedDistanceField", () => signedDistanceField(cov, big.width, big.height));
    t("shapeCoverage total", () => shapeCoverage(m, region));
  });
});

describe("band-limited feathered mask coverage", () => {
  it("is byte-identical to the exact (unbanded) distance field for every pixel", async () => {
    const { polygonCoverage, signedDistanceField, shapeCoverage, influenceMargin, edgeProfile } = await import("../masks/raster");
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let checked = 0;
    for (let trial = 0; trial < 40; trial++) {
      const n = 3 + Math.floor(rnd() * 12);
      const cx = 60 + rnd() * 80;
      const cy = 50 + rnd() * 60;
      // Star-ish random polygons (concave, thin spikes, near-degenerate) plus a pixel-aligned rectangle.
      const poly =
        trial === 0
          ? [{ x: 40, y: 30 }, { x: 160, y: 30 }, { x: 160, y: 120 }, { x: 40, y: 120 }]
          : Array.from({ length: n }, (_, k) => {
              const r = 10 + rnd() * 70;
              const a = (2 * Math.PI * k) / n + rnd() * 0.3;
              return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
            });
      const feather = [0, 0.4, 1, 3, 12.5, 40][trial % 6];
      const expansion = [0, 0, 5, -6, 2.3, -15][Math.floor(trial / 6) % 6];
      if (feather === 0 && expansion === 0) continue;
      const m = { polygon: poly, feather, expansion };
      const region = { x: 10 + Math.floor(rnd() * 20), y: 5 + Math.floor(rnd() * 20), width: 150 + Math.floor(rnd() * 40), height: 110 + Math.floor(rnd() * 30) };
      const got = shapeCoverage(m, region);
      const pad = influenceMargin(m) + Math.ceil(Math.max(0, -m.expansion));
      const big = { x: region.x - pad, y: region.y - pad, width: region.width + 2 * pad, height: region.height + 2 * pad };
      const sdf = signedDistanceField(polygonCoverage(poly, big), big.width, big.height);
      const want = new Float32Array(region.width * region.height);
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) want[y * region.width + x] = edgeProfile(sdf[(y + pad) * big.width + (x + pad)] - expansion, feather);
      expect(Buffer.from(got.buffer).equals(Buffer.from(want.buffer)), `trial ${trial} feather ${feather} expansion ${expansion}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });
});
