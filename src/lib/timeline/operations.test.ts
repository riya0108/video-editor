import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { createTimeline, getClip, getTrack, getTrackClips } from "./model";
import { clipDurationFrames, clipTimelineEnd, isTrimmableContent } from "./clip";
import {
  addTrack,
  removeTrack,
  reorderTrack,
  setTrackLocked,
  setTrackVisible,
  setTrackMuted,
  setTrackSolo,
  insertClip,
  deleteClip,
  deleteClips,
  moveClip,
  duplicateClip,
  trimClip,
  splitClip,
} from "./operations";
import { TimelineEditError } from "./errors";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

function baseTimeline() {
  const t0 = createTimeline(30);
  const { timeline: t1, track } = addTrack(t0, "video", "V1");
  return { timeline: t1, track };
}

// ---------------------------------------------------------------------------
// TRACK OPERATIONS
// ---------------------------------------------------------------------------

describe("addTrack / removeTrack", () => {
  it("adds a track and appends it to trackIds", () => {
    const { timeline, track } = baseTimeline();
    expect(timeline.trackIds).toEqual([track.id]);
    expect(getTrack(timeline, track.id)?.kind).toBe("video");
  });

  it("removeTrack cascades to delete every clip on that track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: withClip, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const removed = removeTrack(withClip, track.id);
    expect(removed.trackIds).toEqual([]);
    expect(getClip(removed, clip.id)).toBeUndefined();
  });

  it("removeTrack throws track-not-found for an unknown id", () => {
    const { timeline } = baseTimeline();
    expect(() => removeTrack(timeline, "nope")).toThrow(TimelineEditError);
  });

  it("removeTrack is blocked on a locked track", () => {
    const { timeline, track } = baseTimeline();
    const locked = setTrackLocked(timeline, track.id, true);
    try {
      removeTrack(locked, track.id);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TimelineEditError);
      expect((e as TimelineEditError).reason).toBe("track-locked");
    }
  });
});

describe("reorderTrack", () => {
  it("moves a track to the requested index", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: a } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: b } = addTrack(t1, "video", "V2");
    const { timeline: t3, track: c } = addTrack(t2, "video", "V3");
    expect(t3.trackIds).toEqual([a.id, b.id, c.id]);
    const reordered = reorderTrack(t3, c.id, 0);
    expect(reordered.trackIds).toEqual([c.id, a.id, b.id]);
  });

  it("rejects an out-of-range index", () => {
    const { timeline, track } = baseTimeline();
    expect(() => reorderTrack(timeline, track.id, 5)).toThrow(TimelineEditError);
  });

  it("is NOT blocked by track lock (arrangement, not a content edit)", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: a } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: b } = addTrack(t1, "video", "V2");
    const locked = setTrackLocked(t2, a.id, true);
    expect(reorderTrack(locked, a.id, 1).trackIds).toEqual([b.id, a.id]);
  });
});

describe("track toggles", () => {
  it("setTrackLocked/Visible/Muted/Solo each flip exactly the targeted flag", () => {
    const { timeline, track } = baseTimeline();
    const locked = setTrackLocked(timeline, track.id, true);
    expect(getTrack(locked, track.id)).toMatchObject({ locked: true, visible: true, muted: false, solo: false });

    const visible = setTrackVisible(timeline, track.id, false);
    expect(getTrack(visible, track.id)).toMatchObject({ locked: false, visible: false });

    const muted = setTrackMuted(timeline, track.id, true);
    expect(getTrack(muted, track.id)).toMatchObject({ muted: true });

    const soloed = setTrackSolo(timeline, track.id, true);
    expect(getTrack(soloed, track.id)).toMatchObject({ solo: true });
  });

  it("does not mutate the original timeline (immutability)", () => {
    const { timeline, track } = baseTimeline();
    setTrackLocked(timeline, track.id, true);
    expect(getTrack(timeline, track.id)?.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INSERT / DELETE
// ---------------------------------------------------------------------------

describe("insertClip", () => {
  it("places a clip and returns it", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: next, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 10);
    expect(clip.timelineStart).toBe(10);
    expect(getTrackClips(next, track.id).map((c) => c.id)).toEqual([clip.id]);
  });

  it("rejects a kind mismatch (text content on a video track)", () => {
    const { timeline, track } = baseTimeline();
    expect(() => insertClip(timeline, track.id, { kind: "text", text: "hi", durationFrames: 30 }, 0)).toThrow(TimelineEditError);
  });

  it("rejects an overlapping placement", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: withA } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    expect(() => insertClip(withA, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 15)).toThrow(TimelineEditError);
  });

  it("allows exactly-adjacent placement (touching edges, not overlapping)", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: withA } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    expect(() => insertClip(withA, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 30)).not.toThrow();
  });

  it("rejects insertion on a locked track", () => {
    const { timeline, track } = baseTimeline();
    const locked = setTrackLocked(timeline, track.id, true);
    expect(() => insertClip(locked, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0)).toThrow(TimelineEditError);
  });
});

describe("deleteClip / deleteClips", () => {
  it("removes the clip from both the clip map and its track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: withClip, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const deleted = deleteClip(withClip, clip.id);
    expect(getClip(deleted, clip.id)).toBeUndefined();
    expect(getTrackClips(deleted, track.id)).toEqual([]);
  });

  it("deleteClips removes a whole multi-selection in one call", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip: a } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const { timeline: t2, clip: b } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 10);
    const result = deleteClips(t2, [a.id, b.id]);
    expect(getTrackClips(result, track.id)).toEqual([]);
  });

  it("deleteClips is atomic: if ANY target clip is on a locked track, NONE are deleted", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: unlockedTrack } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: lockedTrack } = addTrack(t1, "video", "V2");
    const { timeline: t3, clip: freeClip } = insertClip(t2, unlockedTrack.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const { timeline: t4, clip: lockedClip } = insertClip(t3, lockedTrack.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const locked = setTrackLocked(t4, lockedTrack.id, true);

    expect(() => deleteClips(locked, [freeClip.id, lockedClip.id])).toThrow(TimelineEditError);
    // nothing was removed, including the clip on the UNLOCKED track
    expect(getClip(locked, freeClip.id)).toBeDefined();
    expect(getClip(locked, lockedClip.id)).toBeDefined();
  });

  it("deleteClip throws clip-not-found for an unknown id", () => {
    const { timeline } = baseTimeline();
    expect(() => deleteClip(timeline, "nope")).toThrow(TimelineEditError);
  });
});

// ---------------------------------------------------------------------------
// MOVE
// ---------------------------------------------------------------------------

describe("moveClip", () => {
  it("repositions a clip within the same track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const moved = moveClip(t1, clip.id, 50);
    expect(getClip(moved, clip.id)?.timelineStart).toBe(50);
  });

  it("moves a clip to a different track of the same kind", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: a } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: b } = addTrack(t1, "video", "V2");
    const { timeline: t3, clip } = insertClip(t2, a.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const moved = moveClip(t3, clip.id, 0, b.id);
    expect(getClip(moved, clip.id)?.trackId).toBe(b.id);
    expect(getTrackClips(moved, a.id)).toEqual([]);
    expect(getTrackClips(moved, b.id).map((c) => c.id)).toEqual([clip.id]);
  });

  it("rejects moving onto a track of a different kind", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: videoTrack } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: textTrack } = addTrack(t1, "text", "T1");
    const { timeline: t3, clip } = insertClip(t2, videoTrack.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    expect(() => moveClip(t3, clip.id, 0, textTrack.id)).toThrow(TimelineEditError);
  });

  it("rejects a move that would overlap another clip on the target track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip: a } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const { timeline: t2, clip: b } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 20);
    expect(() => moveClip(t2, b.id, 5)).toThrow(TimelineEditError);
    void a;
  });

  it("is blocked if the SOURCE track is locked, even if the destination is not", () => {
    const t0 = createTimeline(30);
    const { timeline: t1, track: locked } = addTrack(t0, "video", "V1");
    const { timeline: t2, track: free } = addTrack(t1, "video", "V2");
    const { timeline: t3, clip } = insertClip(t2, locked.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const lockedTimeline = setTrackLocked(t3, locked.id, true);
    expect(() => moveClip(lockedTimeline, clip.id, 0, free.id)).toThrow(TimelineEditError);
  });
});

// ---------------------------------------------------------------------------
// DUPLICATE
// ---------------------------------------------------------------------------

describe("duplicateClip", () => {
  it("defaults to placing the duplicate immediately after the original", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip: original } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const { timeline: t2, clip: copy } = duplicateClip(t1, original.id);
    expect(copy.timelineStart).toBe(clipTimelineEnd(original));
    expect(copy.id).not.toBe(original.id);
    expect(getTrackClips(t2, track.id).map((c) => c.id)).toEqual([original.id, copy.id]);
  });

  it("the duplicate shares the same content values as the original (same source reference, not a copy of bytes — there are none)", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip: original } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 5, sourceOutFrame: 15 }, 0);
    const { clip: copy } = duplicateClip(t1, original.id);
    expect(copy.content).toEqual(original.content);
  });

  it("rejects a duplicate placement that would overlap", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip: a } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const { timeline: t2 } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 10);
    expect(() => duplicateClip(t2, a.id, 5)).toThrow(TimelineEditError);
  });
});

// ---------------------------------------------------------------------------
// TRIM
// ---------------------------------------------------------------------------

describe("trimClip", () => {
  it("trimming the end shortens duration and advances sourceOutFrame accordingly", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const trimmed = trimClip(t1, clip.id, "end", 20);
    const result = getClip(trimmed, clip.id)!;
    expect(clipDurationFrames(result)).toBe(20);
    expect(isTrimmableContent(result.content) && result.content.sourceOutFrame).toBe(20);
    expect(result.timelineStart).toBe(0); // start unaffected
  });

  it("trimming the start moves timelineStart AND shifts sourceInFrame by the same delta", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 100);
    const trimmed = trimClip(t1, clip.id, "start", 110);
    const result = getClip(trimmed, clip.id)!;
    expect(result.timelineStart).toBe(110);
    expect(isTrimmableContent(result.content) && result.content.sourceInFrame).toBe(10); // shifted by the same +10
    expect(isTrimmableContent(result.content) && result.content.sourceOutFrame).toBe(30); // end untouched
    expect(clipDurationFrames(result)).toBe(20);
  });

  it("trimming an authored (timeline-only) clip only changes durationFrames — no source to shift", () => {
    const { timeline, track: videoTrack } = baseTimeline();
    const t0 = createTimeline(30);
    void t0;
    const { timeline: withTextTrack, track: textTrack } = addTrack(timeline, "text", "T1");
    void videoTrack;
    const { timeline: t1, clip } = insertClip(withTextTrack, textTrack.id, { kind: "text", text: "hello", durationFrames: 30 }, 50);
    const trimmed = trimClip(t1, clip.id, "end", 70);
    const result = getClip(trimmed, clip.id)!;
    expect(result.timelineStart).toBe(50); // unaffected
    expect(clipDurationFrames(result)).toBe(20);
  });

  it("clamps to a 1-frame minimum duration rather than producing a zero/negative-length clip", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const trimmed = trimClip(t1, clip.id, "end", -100);
    expect(clipDurationFrames(getClip(trimmed, clip.id)!)).toBe(1);
  });

  it("never trims sourceOutFrame past a known sourceDurationFrames", () => {
    const { timeline, track } = baseTimeline();
    const boundedSource = { sourceId: "bounded", sourceDurationFrames: 25 };
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: boundedSource, sourceInFrame: 0, sourceOutFrame: 20 }, 0);
    const trimmed = trimClip(t1, clip.id, "end", 1000); // try to drag way past the source's known end
    const result = getClip(trimmed, clip.id)!;
    expect(isTrimmableContent(result.content) && result.content.sourceOutFrame).toBe(25);
  });

  it("never trims sourceInFrame below 0", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 5, sourceOutFrame: 30 }, 100);
    // dragging the start handle far to the left can't pull sourceInFrame below 0
    const trimmed = trimClip(t1, clip.id, "start", -1000);
    const result = getClip(trimmed, clip.id)!;
    expect(isTrimmableContent(result.content) && result.content.sourceInFrame).toBe(0);
    expect(result.timelineStart).toBe(95); // shifted left by exactly 5 (the available headroom), not further
  });

  it("rejects a trim that would overlap a neighboring clip", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1 } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    // sourceInFrame: 5 (not 0) so the source-range clamp isn't what blocks this —
    // it's purely the overlap check against the neighbor at [0,10) being exercised.
    const { timeline: t2, clip: b } = insertClip(t1, track.id, { kind: "video", source: SRC, sourceInFrame: 5, sourceOutFrame: 15 }, 10);
    expect(() => trimClip(t2, b.id, "start", 2)).toThrow(TimelineEditError);
  });

  it("rejects trimming on a locked track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const locked = setTrackLocked(t1, track.id, true);
    expect(() => trimClip(locked, clip.id, "end", 10)).toThrow(TimelineEditError);
  });
});

// ---------------------------------------------------------------------------
// SPLIT
// ---------------------------------------------------------------------------

describe("splitClip", () => {
  it("splits one clip into two frame-exact, gapless pieces", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 100);
    const { timeline: t2, left, right } = splitClip(t1, clip.id, 120);

    expect(left.id).toBe(clip.id); // left keeps the original id
    expect(right.id).not.toBe(clip.id); // right is new

    expect(left.timelineStart).toBe(100);
    expect(clipTimelineEnd(left)).toBe(120);
    expect(right.timelineStart).toBe(120);
    expect(clipTimelineEnd(right)).toBe(130);

    // gapless: right starts exactly where left ends
    expect(right.timelineStart).toBe(clipTimelineEnd(left));

    // both still point at the same untouched source
    expect(isTrimmableContent(left.content) && left.content.source).toBe(SRC);
    expect(isTrimmableContent(right.content) && right.content.source).toBe(SRC);
    expect(isTrimmableContent(left.content) && left.content.sourceInFrame).toBe(0);
    expect(isTrimmableContent(left.content) && left.content.sourceOutFrame).toBe(20); // 20 source frames played before the cut
    expect(isTrimmableContent(right.content) && right.content.sourceInFrame).toBe(20); // picks up exactly where left left off
    expect(isTrimmableContent(right.content) && right.content.sourceOutFrame).toBe(30);

    expect(getTrackClips(t2, track.id).map((c) => c.id)).toEqual([left.id, right.id]);
  });

  it("splits a timeline-authored (text) clip the same way, without any source pointers", () => {
    const { timeline } = baseTimeline();
    const { timeline: withTextTrack, track: textTrack } = addTrack(timeline, "text", "T1");
    const { timeline: t1, clip } = insertClip(withTextTrack, textTrack.id, { kind: "text", text: "hello", durationFrames: 30 }, 0);
    const { left, right } = splitClip(t1, clip.id, 10);
    expect(clipDurationFrames(left)).toBe(10);
    expect(clipDurationFrames(right)).toBe(20);
  });

  it("rejects a split point on or outside the clip's own span", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    expect(() => splitClip(t1, clip.id, 0)).toThrow(TimelineEditError); // exactly at start
    expect(() => splitClip(t1, clip.id, 30)).toThrow(TimelineEditError); // exactly at end
    expect(() => splitClip(t1, clip.id, 50)).toThrow(TimelineEditError); // outside entirely
  });

  it("rejects splitting on a locked track", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const locked = setTrackLocked(t1, track.id, true);
    expect(() => splitClip(locked, clip.id, 15)).toThrow(TimelineEditError);
  });
});

// ---------------------------------------------------------------------------
// NON-DESTRUCTIVE INVARIANT
// ---------------------------------------------------------------------------

describe("non-destructive invariant", () => {
  it("trim/split/duplicate never produce a different sourceId — every operation stays a pointer into the same original source", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);

    const trimmed = getClip(trimClip(t1, clip.id, "end", 20), clip.id)!;
    const { left, right } = splitClip(t1, clip.id, 10);
    const { clip: dup } = duplicateClip(t1, clip.id);

    for (const c of [trimmed, left, right, dup]) {
      expect(isTrimmableContent(c.content) && c.content.source.sourceId).toBe(SRC.sourceId);
    }
  });

  it("no operation ever mutates its input timeline object", () => {
    const { timeline, track } = baseTimeline();
    const { timeline: t1, clip } = insertClip(timeline, track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    const snapshotJson = JSON.stringify(t1);
    trimClip(t1, clip.id, "end", 10);
    splitClip(t1, clip.id, 15);
    duplicateClip(t1, clip.id);
    moveClip(t1, clip.id, 200);
    expect(JSON.stringify(t1)).toBe(snapshotJson);
  });
});
