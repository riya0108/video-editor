import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { createTimeline } from "./model";
import { createTrack } from "./track";
import { createVideoClip } from "./clip";
import { createSelection, isSelected, select, toggleSelect, selectMany, clearSelection, selectRange, pruneSelection } from "./selection";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

function sampleTimeline() {
  let timeline = createTimeline(30);
  const track = createTrack("video", "V1");
  const a = createVideoClip(track.id, 0, SRC, 0, 30); // 0..30
  const b = createVideoClip(track.id, 30, SRC, 0, 30); // 30..60
  const c = createVideoClip(track.id, 60, SRC, 0, 30); // 60..90
  timeline = {
    ...timeline,
    trackIds: [track.id],
    tracks: { [track.id]: { ...track, clipIds: [a.id, b.id, c.id] } },
    clips: { [a.id]: a, [b.id]: b, [c.id]: c },
  };
  return { timeline, track, a, b, c };
}

describe("select / toggleSelect / selectMany / clearSelection", () => {
  it("select replaces the whole selection with one clip", () => {
    const sel = select("clip-1");
    expect(isSelected(sel, "clip-1")).toBe(true);
    const replaced = select("clip-2");
    expect(isSelected(replaced, "clip-1")).toBe(false);
    expect(isSelected(replaced, "clip-2")).toBe(true);
  });

  it("toggleSelect adds and removes without disturbing the rest", () => {
    let sel = selectMany(["a", "b"]);
    sel = toggleSelect(sel, "c");
    expect([...sel.selectedClipIds].sort()).toEqual(["a", "b", "c"]);
    sel = toggleSelect(sel, "b");
    expect([...sel.selectedClipIds].sort()).toEqual(["a", "c"]);
  });

  it("clearSelection empties it", () => {
    const sel = clearSelection();
    expect(sel.selectedClipIds.size).toBe(0);
  });

  it("every operation returns a new value rather than mutating", () => {
    const sel = createSelection();
    const next = toggleSelect(sel, "x");
    expect(sel.selectedClipIds.size).toBe(0);
    expect(next.selectedClipIds.size).toBe(1);
  });
});

describe("selectRange", () => {
  it("selects every clip whose span intersects the range", () => {
    const { timeline, track, a, b, c } = sampleTimeline();
    const sel = selectRange(timeline, track.id, 20, 70); // overlaps a (0-30), b (30-60), c (60-90)
    expect([...sel.selectedClipIds].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("excludes clips entirely outside the range", () => {
    const { timeline, track, a } = sampleTimeline();
    const sel = selectRange(timeline, track.id, 0, 25); // only overlaps a
    expect([...sel.selectedClipIds]).toEqual([a.id]);
  });
});

describe("pruneSelection", () => {
  it("drops selected ids that no longer exist in the timeline", () => {
    const { timeline, a } = sampleTimeline();
    const sel = selectMany([a.id, "deleted-clip"]);
    const pruned = pruneSelection(sel, timeline);
    expect([...pruned.selectedClipIds]).toEqual([a.id]);
  });

  it("is a no-op when every selected clip still exists", () => {
    const { timeline, a, b } = sampleTimeline();
    const sel = selectMany([a.id, b.id]);
    const pruned = pruneSelection(sel, timeline);
    expect([...pruned.selectedClipIds].sort()).toEqual([a.id, b.id].sort());
  });
});
