import { describe, it, expect, beforeEach } from "vitest";
import { resetIdCountersForTests } from "./id";
import { createTrack, withTrack, isTrackAudible } from "./track";

beforeEach(() => {
  resetIdCountersForTests();
});

describe("createTrack", () => {
  it("starts unlocked, visible, unmuted, not soloed, with no clips", () => {
    const t = createTrack("video", "V1");
    expect(t).toMatchObject({ kind: "video", name: "V1", clipIds: [], locked: false, visible: true, muted: false, solo: false });
  });
});

describe("withTrack", () => {
  it("returns a new object and does not mutate the original", () => {
    const t = createTrack("audio", "A1");
    const locked = withTrack(t, { locked: true });
    expect(locked.locked).toBe(true);
    expect(t.locked).toBe(false);
    expect(locked).not.toBe(t);
  });
});

describe("isTrackAudible", () => {
  it("is audible by default (no mute, no solo anywhere)", () => {
    const a = createTrack("audio", "A1");
    const b = createTrack("audio", "A2");
    expect(isTrackAudible(a, [a, b])).toBe(true);
  });

  it("a muted track is inaudible when nothing is soloed", () => {
    const a = withTrack(createTrack("audio", "A1"), { muted: true });
    const b = createTrack("audio", "A2");
    expect(isTrackAudible(a, [a, b])).toBe(false);
    expect(isTrackAudible(b, [a, b])).toBe(true);
  });

  it("when any track is soloed, only soloed tracks are audible — including a muted-but-soloed track", () => {
    const a = withTrack(createTrack("audio", "A1"), { muted: true, solo: true });
    const b = createTrack("audio", "A2"); // not muted, not soloed
    expect(isTrackAudible(a, [a, b])).toBe(true); // soloed wins over its own mute
    expect(isTrackAudible(b, [a, b])).toBe(false); // silenced by the other track's solo
  });

  it("un-soloing restores normal mute-based audibility without any stored 'previous mute state'", () => {
    const soloed = withTrack(createTrack("audio", "A1"), { solo: true });
    const other = withTrack(createTrack("audio", "A2"), { muted: true });
    expect(isTrackAudible(other, [soloed, other])).toBe(false);

    const unsoloedAgain = withTrack(soloed, { solo: false });
    // other's mute flag was never touched — it's exactly what it was before any solo happened.
    expect(other.muted).toBe(true);
    expect(isTrackAudible(other, [unsoloedAgain, other])).toBe(false); // still muted, now for the ordinary reason
    expect(isTrackAudible(unsoloedAgain, [unsoloedAgain, other])).toBe(true);
  });
});
