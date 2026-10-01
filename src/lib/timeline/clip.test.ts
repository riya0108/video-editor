import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import {
  createVideoClip,
  createImageClip,
  createTextClip,
  clipDurationFrames,
  clipTimelineEnd,
  clipKind,
  isTrimmableContent,
  withContent,
  withTimelineStart,
} from "./clip";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

describe("clip construction", () => {
  it("assigns a deterministic, unique id", () => {
    const a = createVideoClip("track-1", 0, SRC, 0, 30);
    const b = createVideoClip("track-1", 30, SRC, 0, 30);
    expect(a.id).not.toBe(b.id);
  });

  it("never embeds the source — only an opaque sourceId reference", () => {
    const clip = createVideoClip("track-1", 0, SRC, 0, 30);
    expect(isTrimmableContent(clip.content) && clip.content.source).toEqual(SRC);
  });
});

describe("clipDurationFrames", () => {
  it("derives duration for trim-capable kinds from sourceOutFrame - sourceInFrame", () => {
    const clip = createVideoClip("t1", 0, SRC, 10, 40);
    expect(clipDurationFrames(clip)).toBe(30);
  });

  it("uses the stored durationFrames for timeline-authored kinds", () => {
    const clip = createImageClip("t1", 0, SRC, 90);
    expect(clipDurationFrames(clip)).toBe(90);
  });

  it("stays correct after withContent changes sourceOutFrame (no stale cached duration)", () => {
    const clip = createVideoClip("t1", 0, SRC, 0, 30);
    const trimmed = withContent(clip, { ...clip.content, sourceOutFrame: 20 } as typeof clip.content);
    expect(clipDurationFrames(trimmed)).toBe(20);
    // original is untouched
    expect(clipDurationFrames(clip)).toBe(30);
  });
});

describe("clipTimelineEnd", () => {
  it("is timelineStart + duration", () => {
    const clip = createTextClip("t1", 50, "hello", 20);
    expect(clipTimelineEnd(clip)).toBe(70);
  });

  it("updates correctly via withTimelineStart without mutating the original", () => {
    const clip = createTextClip("t1", 0, "hello", 20);
    const moved = withTimelineStart(clip, 100);
    expect(clipTimelineEnd(moved)).toBe(120);
    expect(clipTimelineEnd(clip)).toBe(20);
  });
});

describe("clipKind", () => {
  it("reports the content's kind", () => {
    expect(clipKind(createVideoClip("t1", 0, SRC, 0, 10))).toBe("video");
    expect(clipKind(createImageClip("t1", 0, SRC, 10))).toBe("image");
    expect(clipKind(createTextClip("t1", 0, "hi", 10))).toBe("text");
  });
});
