import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { TimelineEngine } from "./engine";
import { clipDurationFrames, clipTimelineEnd } from "./clip";

const SRC = { sourceId: "src-1" };

beforeEach(() => {
  resetIdCountersForTests();
});

describe("TimelineEngine basics", () => {
  it("starts with an empty timeline at the given frame rate and no undo/redo available", () => {
    const engine = new TimelineEngine(30);
    expect(engine.timeline.frameRate).toBe(30);
    expect(engine.timeline.trackIds).toEqual([]);
    expect(engine.canUndo).toBe(false);
    expect(engine.canRedo).toBe(false);
  });
});

describe("structural edits push history; failed edits do not", () => {
  it("a successful addTrack is one undo step", () => {
    const engine = new TimelineEngine(30);
    const result = engine.addTrack("video", "V1");
    expect(result.ok).toBe(true);
    expect(engine.canUndo).toBe(true);
    engine.undo();
    expect(engine.timeline.trackIds).toEqual([]);
    expect(engine.canRedo).toBe(true);
  });

  it("a failed edit (locked track) returns ok:false and does NOT grow history", () => {
    const engine = new TimelineEngine(30);
    const { track } = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    engine.setTrackLocked(track.id, true);
    const before = engine.timeline;

    const result = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("track-locked");
    expect(engine.timeline).toBe(before); // literally the same object — nothing was pushed
  });

  it("never throws for an expected/invalid edit — always returns a Result", () => {
    const engine = new TimelineEngine(30);
    expect(() => engine.deleteClip("nonexistent")).not.toThrow();
    const result = engine.deleteClip("nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("undo after a split restores the single original clip", () => {
  it("does not leave two half-sized leftovers behind", () => {
    const engine = new TimelineEngine(30);
    const { track } = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    const insertResult = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 30 }, 0);
    if (!insertResult.ok) throw new Error("setup failed");
    const original = insertResult.clip;

    const splitResult = engine.splitClip(original.id, 15);
    expect(splitResult.ok).toBe(true);
    expect(Object.keys(engine.timeline.clips)).toHaveLength(2);

    engine.undo();
    expect(Object.keys(engine.timeline.clips)).toHaveLength(1);
    const restored = engine.timeline.clips[original.id];
    expect(restored).toBeDefined();
    expect(clipDurationFrames(restored)).toBe(30);
    expect(clipTimelineEnd(restored)).toBe(30);
  });
});

describe("multi-select delete is one undo step, not N", () => {
  it("undo restores every deleted clip at once", () => {
    const engine = new TimelineEngine(30);
    const { track } = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    const a = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    const b = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 10);
    if (!a.ok || !b.ok) throw new Error("setup failed");

    engine.selectMany([a.clip.id, b.clip.id]);
    const deleteResult = engine.deleteSelectedClips();
    expect(deleteResult.ok).toBe(true);
    expect(Object.keys(engine.timeline.clips)).toHaveLength(0);

    engine.undo(); // exactly one undo
    expect(Object.keys(engine.timeline.clips)).toHaveLength(2);
  });
});

describe("selection is independent of undo/redo", () => {
  it("undoing a structural edit does not clear an unrelated selection", () => {
    const engine = new TimelineEngine(30);
    const t1 = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    const t2 = engine.addTrack("video", "V2") as { ok: true; timeline: unknown; track: { id: string } };
    const a = engine.insertClip(t1.track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    if (!a.ok) throw new Error("setup failed");

    engine.select(a.clip.id);
    expect(engine.selection.selectedClipIds.has(a.clip.id)).toBe(true);

    engine.removeTrack(t2.track.id); // unrelated structural edit
    expect(engine.selection.selectedClipIds.has(a.clip.id)).toBe(true); // still selected

    engine.undo();
    expect(engine.selection.selectedClipIds.has(a.clip.id)).toBe(true); // undo didn't touch selection either
  });

  it("deleting a selected clip prunes it out of selection automatically", () => {
    const engine = new TimelineEngine(30);
    const { track } = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    const a = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    if (!a.ok) throw new Error("setup failed");

    engine.select(a.clip.id);
    engine.deleteClip(a.clip.id);
    expect(engine.selection.selectedClipIds.has(a.clip.id)).toBe(false);
  });

  it("redoing a delete prunes the restored-then-redeleted clip id back out of selection too", () => {
    const engine = new TimelineEngine(30);
    const { track } = engine.addTrack("video", "V1") as { ok: true; timeline: unknown; track: { id: string } };
    const a = engine.insertClip(track.id, { kind: "video", source: SRC, sourceInFrame: 0, sourceOutFrame: 10 }, 0);
    if (!a.ok) throw new Error("setup failed");
    engine.select(a.clip.id);
    engine.deleteClip(a.clip.id);
    engine.undo(); // clip is back
    expect(engine.selection.selectedClipIds.has(a.clip.id)).toBe(false); // selection was pruned at delete time, undo doesn't restore it
    engine.redo(); // deleted again
    expect(Object.keys(engine.timeline.clips)).toHaveLength(0);
  });
});

describe("solo/mute integration through the engine", () => {
  it("solo on one track silences another without mutating its mute flag", () => {
    const engine = new TimelineEngine(30);
    const { track: a } = engine.addTrack("audio", "A1") as { ok: true; timeline: unknown; track: { id: string } };
    const { track: b } = engine.addTrack("audio", "A2") as { ok: true; timeline: unknown; track: { id: string } };
    engine.setTrackSolo(a.id, true);
    expect(engine.timeline.tracks[b.id].muted).toBe(false); // untouched
    expect(engine.timeline.tracks[a.id].solo).toBe(true);
  });
});

describe("a new edit after undo clears redo", () => {
  it("canRedo becomes false once a fresh edit is made post-undo", () => {
    const engine = new TimelineEngine(30);
    engine.addTrack("video", "V1");
    engine.addTrack("video", "V2");
    engine.undo();
    expect(engine.canRedo).toBe(true);
    engine.addTrack("video", "V3");
    expect(engine.canRedo).toBe(false);
  });
});
