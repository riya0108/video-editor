import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { createTimeline, getTrack, getClip, getTrackClips, timelineDurationFrames, rangesOverlap, findOverlap } from "./model";
import { createTrack } from "./track";
import { createVideoClip, createTextClip } from "./clip";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

describe("createTimeline", () => {
  it("starts empty with the given frame rate", () => {
    const t = createTimeline(30);
    expect(t.frameRate).toBe(30);
    expect(t.trackIds).toEqual([]);
    expect(t.tracks).toEqual({});
    expect(t.clips).toEqual({});
  });

  it("rejects a non-positive frame rate", () => {
    expect(() => createTimeline(0)).toThrow();
    expect(() => createTimeline(-5)).toThrow();
  });
});

function withTrackAndClips() {
  let timeline = createTimeline(30);
  const track = createTrack("video", "V1");
  const clipA = createVideoClip(track.id, 0, SRC, 0, 30); // 0..30
  const clipB = createVideoClip(track.id, 30, SRC, 0, 30); // 30..60, adjacent not overlapping
  timeline = {
    ...timeline,
    trackIds: [track.id],
    tracks: { [track.id]: { ...track, clipIds: [clipA.id, clipB.id] } },
    clips: { [clipA.id]: clipA, [clipB.id]: clipB },
  };
  return { timeline, track, clipA, clipB };
}

describe("getTrack / getClip / getTrackClips", () => {
  it("resolves tracks and clips by id, and clips in track order", () => {
    const { timeline, track, clipA, clipB } = withTrackAndClips();
    expect(getTrack(timeline, track.id)?.id).toBe(track.id);
    expect(getClip(timeline, clipA.id)?.id).toBe(clipA.id);
    expect(getTrackClips(timeline, track.id).map((c) => c.id)).toEqual([clipA.id, clipB.id]);
  });

  it("returns undefined/empty for unknown ids rather than throwing", () => {
    const timeline = createTimeline(30);
    expect(getTrack(timeline, "nope")).toBeUndefined();
    expect(getClip(timeline, "nope")).toBeUndefined();
    expect(getTrackClips(timeline, "nope")).toEqual([]);
  });
});

describe("timelineDurationFrames", () => {
  it("is 0 for an empty timeline", () => {
    expect(timelineDurationFrames(createTimeline(30))).toBe(0);
  });

  it("is the furthest clip end across every track", () => {
    const { timeline } = withTrackAndClips();
    expect(timelineDurationFrames(timeline)).toBe(60);
  });
});

describe("rangesOverlap", () => {
  it("detects a genuine overlap", () => {
    expect(rangesOverlap(0, 10, 5, 15)).toBe(true);
  });

  it("treats exactly-touching edges as NOT overlapping", () => {
    expect(rangesOverlap(0, 10, 10, 20)).toBe(false);
    expect(rangesOverlap(10, 20, 0, 10)).toBe(false);
  });

  it("detects full containment as an overlap", () => {
    expect(rangesOverlap(0, 100, 10, 20)).toBe(true);
  });
});

describe("findOverlap", () => {
  it("finds a conflicting clip on the target track", () => {
    const { timeline, track, clipA } = withTrackAndClips();
    const conflict = findOverlap(timeline, track.id, 10, 20);
    expect(conflict?.id).toBe(clipA.id);
  });

  it("returns undefined for a gap between clips", () => {
    const { timeline, track } = withTrackAndClips();
    expect(findOverlap(timeline, track.id, 200, 210)).toBeUndefined();
  });

  it("excludes the clip itself (so re-checking a clip's own current spot never 'conflicts with itself')", () => {
    const { timeline, track, clipA } = withTrackAndClips();
    expect(findOverlap(timeline, track.id, 0, 30, clipA.id)).toBeUndefined();
  });

  it("ignores clips on other tracks entirely", () => {
    const timeline = createTimeline(30);
    const trackA = createTrack("video", "V1");
    const trackB = createTrack("video", "V2");
    const clip = createTextClip(trackA.id, 0, "hi", 30);
    const populated = {
      ...timeline,
      trackIds: [trackA.id, trackB.id],
      tracks: { [trackA.id]: { ...trackA, clipIds: [clip.id] }, [trackB.id]: trackB },
      clips: { [clip.id]: clip },
    };
    expect(findOverlap(populated, trackB.id, 0, 30)).toBeUndefined();
  });
});
