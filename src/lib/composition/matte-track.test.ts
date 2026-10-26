import { describe, expect, it } from "vitest";
import { MatteTrack, MatteTrackBuilder, MatteTrackError, alphaToRgba, decodeAlphaPlane, downsampleAlpha, encodeAlphaPlane, matteStorageSize, parseChunkHeader } from "./matte-track";

/** A soft-edged disc at (cx, cy) — the shape of a real matte: 0 / 255 plateaus with a smooth ramp between. */
function disc(w: number, h: number, cx: number, cy: number, r: number, soft = 6): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.min(1, Math.max(0, (r - Math.hypot(x - cx, y - cy)) / soft + 0.5));
  return a;
}

function toU8(a: Float32Array): Uint8Array {
  return Uint8Array.from(a, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

describe("matteStorageSize", () => {
  it("caps the long side and never upscales", () => {
    expect(matteStorageSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(matteStorageSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(matteStorageSize(3840, 2160)).toEqual({ width: 640, height: 360 });
    expect(matteStorageSize(320, 240)).toEqual({ width: 320, height: 240 });
  });
});

describe("downsampleAlpha", () => {
  it("is exact 8-bit quantization at the same size", () => {
    expect([...downsampleAlpha(new Float32Array([0, 0.5, 1, 2, -1]), 5, 1, 5, 1)]).toEqual([0, 128, 255, 255, 0]);
  });

  it("area-averages, including non-integer ratios", () => {
    // 2x2 blocks average exactly.
    expect([...downsampleAlpha(new Float32Array([1, 0, 0, 0, 1, 1, 1, 1]), 4, 2, 2, 1)]).toEqual([191, 128]);
    // 3 -> 2: each output covers 1.5 inputs.
    const out = downsampleAlpha(new Float32Array([1, 0, 1]), 3, 1, 2, 1);
    expect([...out]).toEqual([Math.round(((1 + 0.5 * 0) / 1.5) * 255), Math.round(((0.5 * 0 + 1) / 1.5) * 255)]);
  });

  it("keeps a uniform matte uniform", () => {
    expect(new Set(downsampleAlpha(new Float32Array(1280 * 720).fill(1), 720, 1280, 360, 640))).toEqual(new Set([255]));
  });
});

describe("near-lossless plane coding", () => {
  it("decodes to exactly the encoder's reconstruction, within ±quant of the input", () => {
    const w = 97;
    const h = 61;
    const a = toU8(disc(w, h, 40, 30, 20));
    // Add some noise so residuals aren't trivial.
    for (let i = 0; i < a.length; i += 7) a[i] = (a[i] + 37 * i) & 255;
    for (const quant of [0, 1, 2]) {
      const { residuals, recon } = encodeAlphaPlane(a, w, h, quant);
      const dec = decodeAlphaPlane(residuals, w, h, quant);
      expect(dec).toEqual(recon);
      let maxErr = 0;
      for (let i = 0; i < a.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - dec[i]));
      expect(maxErr).toBeLessThanOrEqual(quant);
    }
  });

  it("is lossless at quant 0 and keeps 0 / 255 plateaus exact at quant 1", () => {
    const a = toU8(disc(64, 64, 32, 32, 20));
    const { recon } = encodeAlphaPlane(a, 64, 64, 1);
    for (let i = 0; i < a.length; i++) if (a[i] === 0 || a[i] === 255) expect(recon[i]).toBe(a[i]);
    expect(decodeAlphaPlane(encodeAlphaPlane(a, 64, 64, 0).residuals, 64, 64, 0)).toEqual(a);
  });
});

describe("MatteTrackBuilder + MatteTrack", () => {
  async function build(frames: number, first = 10, chunkFrames = 4) {
    const w = 48;
    const h = 32;
    const b = new MatteTrackBuilder(w, h, first, { chunkFrames });
    const recons: Uint8Array[] = [];
    for (let k = 0; k < frames; k++) recons.push(await b.push(toU8(disc(w, h, 8 + k * 3, 16, 10))));
    return { b, chunks: await b.finish(), recons, w, h };
  }

  it("round-trips every frame exactly (random access, any order)", async () => {
    const { chunks, recons, b } = await build(11);
    expect(b.frameCount).toBe(11);
    expect(chunks.map((c) => [c.firstFrame, c.count])).toEqual([
      [10, 4],
      [14, 4],
      [18, 3],
    ]);
    const track = new MatteTrack(chunks.map((c) => c.bytes).reverse());
    expect(track.frameCount).toBe(11);
    expect(track.firstFrame).toBe(10);
    for (const k of [7, 3, 0, 10, 5]) expect(await track.decodeFrame(10 + k)).toEqual(recons[k]);
  });

  it("each frame is its own matte — a moving subject is never held", async () => {
    const { chunks } = await build(6);
    const track = new MatteTrack(chunks.map((c) => c.bytes));
    const a = await track.decodeFrame(10);
    const b = await track.decodeFrame(11);
    expect(a).not.toEqual(b);
  });

  it("clamps frames outside the track to its ends", async () => {
    const { chunks, recons } = await build(5);
    const track = new MatteTrack(chunks.map((c) => c.bytes));
    expect(await track.decodeFrame(0)).toEqual(recons[0]);
    expect(await track.decodeFrame(999)).toEqual(recons[4]);
  });

  it("repeatLast duplicates the previous frame (and needs one)", async () => {
    const b = new MatteTrackBuilder(8, 8, 0);
    expect(await b.repeatLast()).toBe(false);
    const r = await b.push(new Uint8Array(64).fill(200));
    expect(await b.repeatLast()).toBe(true);
    const track = new MatteTrack((await b.finish()).map((c) => c.bytes));
    expect(track.frameCount).toBe(2);
    expect(await track.decodeFrame(1)).toEqual(r);
  });

  it("is compact: a smooth matte stores far below raw RGBA", async () => {
    const w = 360;
    const h = 640;
    const b = new MatteTrackBuilder(w, h, 0);
    for (let k = 0; k < 3; k++) await b.push(toU8(disc(w, h, 180 + k, 300, 150, 12)));
    const chunks = await b.finish();
    const perFrame = chunks.reduce((s, c) => s + c.bytes.length, 0) / 3;
    expect(perFrame).toBeLessThan((w * h * 4) / 50);
  });

  it("refuses damaged, mismatched or gappy chunks", async () => {
    const { chunks } = await build(9);
    const bytes = chunks.map((c) => c.bytes);
    expect(() => new MatteTrack([])).toThrow(MatteTrackError);
    expect(() => new MatteTrack([bytes[0], bytes[2]])).toThrow(/missing frames 14–17/);
    expect(() => parseChunkHeader(bytes[0].subarray(0, bytes[0].length - 1))).toThrow(/length/);
    const bad = bytes[0].slice();
    bad[0] = 0x58;
    expect(() => parseChunkHeader(bad)).toThrow(/Not a matte/);
    const b2 = new MatteTrackBuilder(16, 16, 14, { chunkFrames: 4 });
    await b2.push(new Uint8Array(256));
    const otherSize = (await b2.finish())[0].bytes;
    expect(() => new MatteTrack([bytes[0], otherSize])).toThrow(/size/);
  });

  it("reports a corrupted payload instead of returning garbage", async () => {
    const { chunks } = await build(4);
    const bytes = chunks[0].bytes.slice();
    const h = parseChunkHeader(bytes);
    bytes.fill(0xff, h.payloads[1].offset, h.payloads[1].offset + h.payloads[1].length);
    const track = new MatteTrack([bytes]);
    await expect(track.decodeFrame(11)).rejects.toThrow();
  });
});

describe("alphaToRgba", () => {
  it("is white with alpha = matte", () => {
    expect([...alphaToRgba(new Uint8Array([0, 128, 255]))]).toEqual([255, 255, 255, 0, 255, 255, 255, 128, 255, 255, 255, 255]);
  });
});
