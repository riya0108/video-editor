import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { createTimeline } from "./model";
import { addTrack, insertClip } from "./operations";
import { collectSnapPoints, snapToNearest } from "./snapping";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

describe("collectSnapPoints", () => {
  it("includes every clip's start and end across every track, plus 0", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: a } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: b } = addTrack(t1, "audio", "A1");
    const { timeline: t3 } = insertClip(t2, a.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 10);
    const { timeline: t4 } = insertClip(t3, b.id, { kind: "audio", source: SRC, sourceInFrame: 0, sourceOutFrame: 20 }, 100);

    expect(collectSnapPoints(t4)).toEqual([0, 10, 40, 100, 120]);
  });

  it("excludes clips in excludeClipIds (typically the one being dragged)", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track } = addTrack(t0, "video", "V1");
    const { timeline: t2, clip } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 10);
    expect(collectSnapPoints(t2, { excludeClipIds: [clip.id] })).toEqual([0]);
  });

  it("includes extra caller-supplied points (e.g. the playhead) and dedupes against existing ones", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track } = addTrack(t0, "video", "V1");
    const { timeline: t2 } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 10);
    expect(collectSnapPoints(t2, { extra: [55, 0] })).toEqual([0, 10, 40, 55]);
  });
});

describe("snapToNearest", () => {
  const points = [0, 30, 100];

  it("snaps to the nearest point within threshold", () => {
    expect(snapToNearest(32, points, 5)).toBe(30);
  });

  it("leaves the target unchanged when nothing is within threshold", () => {
    expect(snapToNearest(60, points, 5)).toBe(60);
  });

  it("on an exact tie (equidistant from two points), prefers the earlier one", () => {
    expect(snapToNearest(15, [0, 30], 20)).toBe(0);
  });

  it("prefers the strictly closer point when distances differ", () => {
    expect(snapToNearest(28, [0, 30], 20)).toBe(30);
  });

  it("is a strict boundary at exactly thresholdFrames", () => {
    expect(snapToNearest(35, points, 5)).toBe(30); // distance exactly 5, within threshold
    expect(snapToNearest(36, points, 5)).toBe(36); // distance 6, outside
  });
});
