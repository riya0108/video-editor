import { describe, it, expect } from "vitest";
import { analyzeRgba, parseProbeLogs, isAlphaPixFmt } from "./export-validation";

function fillPixel(rgba: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number) {
  rgba[i * 4] = r;
  rgba[i * 4 + 1] = g;
  rgba[i * 4 + 2] = b;
  rgba[i * 4 + 3] = a;
}

describe("analyzeRgba", () => {
  it("reports no transparency for a fully opaque, colorful image", () => {
    const rgba = new Uint8ClampedArray(4 * 4);
    for (let i = 0; i < 4; i++) fillPixel(rgba, i, 200, 100, 50, 255);
    const result = analyzeRgba(rgba, 4);
    expect(result.transparentFraction).toBe(0);
    expect(result.blackFlattenFraction).toBe(0);
  });

  it("detects real transparency when a portion of pixels are punched through", () => {
    const rgba = new Uint8ClampedArray(4 * 4);
    fillPixel(rgba, 0, 200, 100, 50, 255);
    fillPixel(rgba, 1, 0, 0, 0, 0);
    fillPixel(rgba, 2, 200, 100, 50, 255);
    fillPixel(rgba, 3, 0, 0, 0, 0);
    const result = analyzeRgba(rgba, 4);
    expect(result.transparentFraction).toBe(0.5);
  });

  it("flags the flatten-to-black signature: opaque everywhere and nearly all pure black", () => {
    const rgba = new Uint8ClampedArray(10 * 4);
    for (let i = 0; i < 10; i++) fillPixel(rgba, i, 0, 0, 0, 255);
    const result = analyzeRgba(rgba, 10);
    expect(result.transparentFraction).toBe(0);
    expect(result.blackFlattenFraction).toBe(1);
  });

  it("does not flag a legitimately opaque image with real (non-black) subject color", () => {
    const rgba = new Uint8ClampedArray(10 * 4);
    for (let i = 0; i < 10; i++) fillPixel(rgba, i, 220, 180, 140, 255);
    const result = analyzeRgba(rgba, 10);
    expect(result.blackFlattenFraction).toBe(0);
  });
});

describe("parseProbeLogs", () => {
  it("extracts resolution, fps, duration, and an alpha pixel format from a ProRes 4444 stream line", () => {
    const logs = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'validate_input.bin':",
      "  Duration: 00:00:05.03, start: 0.000000, bitrate: 45000 kb/s",
      "    Stream #0:0(und): Video: prores (4444) (ap4h / 0x68347061), yuva444p10le(tv, progressive), 1280x720, 200000 kb/s, 30 fps, 30 tbr, 15360 tbn",
      "    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s",
    ];
    const probed = parseProbeLogs(logs);
    expect(probed.width).toBe(1280);
    expect(probed.height).toBe(720);
    expect(probed.fps).toBe(30);
    expect(probed.pixFmt).toBe("yuva444p10le");
    expect(probed.durationSec).toBeCloseTo(5.03, 2);
  });

  it("extracts a non-alpha pixel format from a plain h264 stream line", () => {
    const logs = [
      "  Duration: 00:00:02.00, start: 0.000000, bitrate: 5000 kb/s",
      "    Stream #0:0: Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 5000 kb/s, 25 fps, 25 tbr, 12800 tbn",
    ];
    const probed = parseProbeLogs(logs);
    expect(probed.width).toBe(1920);
    expect(probed.height).toBe(1080);
    expect(probed.pixFmt).toBe("yuv420p");
  });

  it("returns nulls when no video stream line is present", () => {
    const probed = parseProbeLogs(["Input #0, wav, from 'x':", "  Duration: 00:00:01.00"]);
    expect(probed.width).toBeNull();
    expect(probed.pixFmt).toBeNull();
  });
});

describe("isAlphaPixFmt", () => {
  it("recognizes yuva/gbrap family members at any bit depth, including ones not individually enumerated", () => {
    // yuva444p12le is what prores_ks actually emitted for a "4444"-profile
    // encode in live testing, even though yuva444p10le was requested —
    // encoders pick their own internal bit depth, so this must match by
    // family/prefix, not a fixed list of variants seen so far.
    expect(isAlphaPixFmt("yuva444p12le")).toBe(true);
    expect(isAlphaPixFmt("yuva420p")).toBe(true);
    expect(isAlphaPixFmt("gbrap16le")).toBe(true);
    expect(isAlphaPixFmt("rgba")).toBe(true);
  });

  it("rejects non-alpha pixel formats", () => {
    expect(isAlphaPixFmt("yuv420p")).toBe(false);
    expect(isAlphaPixFmt("rgb24")).toBe(false);
    expect(isAlphaPixFmt("gbrp")).toBe(false);
  });
});
