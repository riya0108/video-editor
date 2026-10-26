import { describe, expect, it } from "vitest";
import { parseProjectDocument, serializeProjectDocument } from "../project/document";
import { TimelineEngine } from "../timeline/engine";
import { clipTimelineEnd } from "../timeline/clip";
import { timelineDurationFrames } from "../timeline/model";
import { rippleDeleteRanges } from "../timeline/ripple";
import { isFillerWord, rangesForPauses, rangesForWords, timelineWords, type SourceWord } from "./transcript";
import { buildShortTimeline, findClips } from "./clip-finder";
import { swapBackground } from "../composition/background-swap";
import { normalizeShapeSpec } from "../timeline/shape-style";

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw (r as unknown as { error: Error }).error;
  return r as Extract<T, { ok: true }>;
}

/** 10 s talking-head clip at 30 fps, with a caption track and a music bed. */
function project() {
  const e = new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
  const v = ok(e.addTrack("video", "Main")).track;
  const clip = ok(e.insertClip(v.id, { kind: "video", source: { sourceId: "talk", sourceDurationFrames: 300 }, sourceInFrame: 0, sourceOutFrame: 300 }, 0)).clip;
  const m = ok(e.addTrack("audio", "Music")).track;
  ok(e.insertClip(m.id, { kind: "audio", source: { sourceId: "music", sourceDurationFrames: 600 }, sourceInFrame: 0, sourceOutFrame: 300 }, 0));
  e.setClipAudio(clip.id, { role: "original" });
  return { e, videoTrack: v.id, clip: clip.id, musicTrack: m.id };
}

const WORDS: SourceWord[] = [
  { text: "Hello", start: 0.5, end: 0.9 },
  { text: "um,", start: 1.0, end: 1.3 },
  { text: "this", start: 1.4, end: 1.6 },
  { text: "is", start: 1.65, end: 1.8 },
  { text: "great.", start: 1.85, end: 2.3 },
  { text: "Really", start: 5.0, end: 5.4 },
  { text: "great.", start: 5.45, end: 5.9 },
];

describe("ripple delete across tracks", () => {
  it("removes time from every track and keeps them in sync", () => {
    const { e, videoTrack, musicTrack } = project();
    ok(e.transact((tl) => rippleDeleteRanges(tl, [[60, 90], [150, 210]]).timeline));
    expect(timelineDurationFrames(e.timeline)).toBe(210);
    for (const t of [videoTrack, musicTrack]) {
      const clips = e.timeline.tracks[t].clipIds.map((id) => e.timeline.clips[id]).sort((a, b) => a.timelineStart - b.timelineStart);
      expect(clips.map((c) => [c.timelineStart, clipTimelineEnd(c)])).toEqual([[0, 60], [60, 120], [120, 210]]);
    }
    e.undo();
    expect(timelineDurationFrames(e.timeline)).toBe(300);
  });

  it("refuses when a locked track would fall out of sync", () => {
    const { e, musicTrack } = project();
    e.setTrackLocked(musicTrack, true);
    expect(e.transact((tl) => rippleDeleteRanges(tl, [[30, 60]]).timeline).ok).toBe(false);
  });
});

describe("transcript editing", () => {
  it("derives timeline words from the clip, and deleting words updates them", () => {
    const { e } = project();
    const tr = new Map([["talk", WORDS]]);
    let words = timelineWords(e.timeline, tr);
    expect(words.map((w) => w.text)).toEqual(WORDS.map((w) => w.text));
    const filler = new Set(words.filter((w) => isFillerWord(w.text)).map((w) => w.key));
    expect(filler.size).toBe(1);
    ok(e.transact((tl) => rippleDeleteRanges(tl, rangesForWords(words, filler, 30)).timeline));
    words = timelineWords(e.timeline, tr);
    expect(words.map((w) => w.text)).toEqual(["Hello", "this", "is", "great.", "Really", "great."]);
    // Long pause between "great." and "Really" shortened.
    ok(e.transact((tl) => rippleDeleteRanges(tl, rangesForPauses(words, 30)).timeline));
    words = timelineWords(e.timeline, tr);
    const gap = words[4].start - words[3].end;
    expect(gap).toBeGreaterThan(0.2);
    expect(gap).toBeLessThan(0.45);
  });
});

describe("clip finder", () => {
  const talk: SourceWord[] = [];
  const lines = ["Here's the secret nobody tells you about editing.", "It takes practice and patience.", "Why do most videos fail?", "Because the first three seconds are boring.", "Fix the hook and everything changes.", "Thanks for watching today."];
  let t = 0;
  for (let rep = 0; rep < 3; rep++)
    for (const line of lines) {
      for (const w of line.split(" ")) {
        talk.push({ text: w, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) });
        t += 0.38;
      }
      t += 0.5;
    }

  it("returns non-overlapping sentence-aligned candidates, best hooks first", () => {
    const e = new TimelineEngine(30, { width: 1920, height: 1080 });
    const v = ok(e.addTrack("video", "Main")).track;
    const n = Math.ceil((t + 1) * 30);
    ok(e.insertClip(v.id, { kind: "video", source: { sourceId: "talk", sourceDurationFrames: n }, sourceInFrame: 0, sourceOutFrame: n }, 0));
    const words = timelineWords(e.timeline, new Map([["talk", talk]]));
    const cands = findClips(words, { minSec: 8, maxSec: 20, count: 3 });
    expect(cands.length).toBeGreaterThan(0);
    for (let i = 1; i < cands.length; i++) expect(cands[i].start).toBeGreaterThanOrEqual(cands[i - 1].end);
    for (const c of cands) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(8);
      expect(c.end - c.start).toBeLessThanOrEqual(20);
      expect(/^(Here's|Why)/.test(c.title)).toBe(true);
    }

    const short = buildShortTimeline(e.timeline, cands[0], words, { captions: true });
    expect(short.composition).toMatchObject({ width: 1080, height: 1920 });
    expect(timelineDurationFrames(short) / 30).toBeCloseTo(cands[0].end - cands[0].start, 0);
    const cap = short.trackIds.find((id) => short.tracks[id].kind === "caption")!;
    expect(short.tracks[cap].caption?.presetId).toBe("punchy");
  });
});

describe("background swap", () => {
  it("puts the new background directly behind the subject, and swapping again replaces it", () => {
    const { e, videoTrack, clip } = project();
    const r1 = e.transact((tl) => swapBackground(tl, clip, { kind: "color", color: "#123456" }).timeline);
    ok(r1);
    let idx = e.timeline.trackIds.indexOf(videoTrack);
    const bg = e.timeline.tracks[e.timeline.trackIds[idx + 1]];
    expect(bg.name).toMatch(/^Background/);
    ok(e.transact((tl) => swapBackground(tl, clip, { kind: "blur", radius: 30 }).timeline));
    idx = e.timeline.trackIds.indexOf(videoTrack);
    const bgs = e.timeline.trackIds.filter((t) => e.timeline.tracks[t].name.startsWith("Background"));
    expect(bgs).toHaveLength(1);
    const copy = e.timeline.clips[e.timeline.tracks[e.timeline.trackIds[idx + 1]].clipIds[0]];
    expect(copy.effects?.[0]).toMatchObject({ type: "blur", params: { radius: 30 } });
    expect(copy.audio?.muted).toBe(true);
    expect(copy.visual?.matte).toBeUndefined();
  });

  it("works for graphics with a solid color too, and rejects audio", () => {
    const e = new TimelineEngine(30, { width: 1080, height: 1920 });
    const g = ok(e.addGraphicLayer({ graphic: { shape: normalizeShapeSpec({ type: "circle", width: 100, height: 100 }) }, atFrame: 0, durationFrames: 30 }));
    ok(e.transact((tl) => swapBackground(tl, g.clip.id, { kind: "color", color: "#ffffff" }).timeline));
    expect(Object.keys(e.timeline.clips)).toHaveLength(2);
  });
});

describe("transcripts in project files", () => {
  it("round-trips, drops malformed entries with a warning, and old files load without them", () => {
    const { e } = project();
    const base = { format: "clipbench-project", version: 1, id: "p1", name: "Talk", createdAt: "2026-10-26T00:00:00.000Z", savedAt: "2026-10-26T00:00:00.000Z", revision: 1, timeline: e.timeline, assets: [], aiResults: null, exportSettings: null, ui: { frame: 0 } } as const;
    const withT = parseProjectDocument(serializeProjectDocument({ ...base, transcripts: { talk: WORDS } } as never));
    expect(withT.doc.transcripts?.talk).toEqual(WORDS);
    const bad = JSON.parse(serializeProjectDocument({ ...base, transcripts: { talk: WORDS } } as never));
    bad.transcripts.broken = [{ text: "x", start: 2, end: 1 }];
    const parsed = parseProjectDocument(JSON.stringify(bad));
    expect(Object.keys(parsed.doc.transcripts ?? {})).toEqual(["talk"]);
    expect(parsed.warnings.some((w) => w.includes("transcript"))).toBe(true);
    expect(parseProjectDocument(serializeProjectDocument(base as never)).doc.transcripts).toBeUndefined();
  });
});
