import { describe, it, expect } from "vitest";
import { secondsToFrames, framesToSeconds, formatTimecode, parseTimecode, clampFrame } from "./time-model";

describe("secondsToFrames / framesToSeconds", () => {
  it("round-trips exactly at a whole-number fps", () => {
    expect(secondsToFrames(2, 30)).toBe(60);
    expect(framesToSeconds(60, 30)).toBe(2);
  });

  it("rounds to the nearest frame by default", () => {
    expect(secondsToFrames(1.016, 30)).toBe(30); // 30.48 -> 30
    expect(secondsToFrames(1.02, 30)).toBe(31); // 30.6 -> 31
  });

  it("supports floor and ceil explicitly", () => {
    expect(secondsToFrames(1.02, 30, "floor")).toBe(30);
    expect(secondsToFrames(1.001, 30, "ceil")).toBe(31);
  });

  it("handles non-integer fps (29.97) without throwing or producing NaN", () => {
    const frames = secondsToFrames(10, 29.97);
    expect(Number.isFinite(frames)).toBe(true);
    const seconds = framesToSeconds(frames, 29.97);
    expect(seconds).toBeCloseTo(10, 1);
  });
});

describe("formatTimecode / parseTimecode", () => {
  it("formats 0 frames as 00:00:00:00", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
  });

  it("formats a frame count spanning hours/minutes/seconds/frames correctly", () => {
    // 1h 2m 3s 4f at 30fps
    const frames = (3600 + 2 * 60 + 3) * 30 + 4;
    expect(formatTimecode(frames, 30)).toBe("01:02:03:04");
  });

  it("round-trips format -> parse -> format", () => {
    const original = 12345;
    const tc = formatTimecode(original, 24);
    expect(parseTimecode(tc, 24)).toBe(original);
  });

  it("throws on a malformed timecode string", () => {
    expect(() => parseTimecode("not-a-timecode", 30)).toThrow();
  });

  it("throws when the frame component is out of range for the given fps", () => {
    expect(() => parseTimecode("00:00:00:30", 30)).toThrow();
  });
});

describe("clampFrame", () => {
  it("clamps into [min, max]", () => {
    expect(clampFrame(-5, 0, 100)).toBe(0);
    expect(clampFrame(150, 0, 100)).toBe(100);
    expect(clampFrame(50, 0, 100)).toBe(50);
  });
});
