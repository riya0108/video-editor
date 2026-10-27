import { captionMotionAt } from "./caption-animation";
import { describe, expect, it } from "vitest";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTrack, applyCaptionPreset, captionCuesOf, importCaptionCues, insertClip, mergeCaptionWithNext, moveClip, setCaptionSpeaker, setCaptionTrackSettings, setClipVisual, splitClip, trimClip, updateCaptionText, addKeyframe } from "../timeline/operations";
import { TimelineEngine } from "../timeline/engine";
import { TimelineEditError } from "../timeline/errors";
import { deserializeTimeline, ProjectFormatError, serializeTimeline } from "../timeline/serialize";
import { resolveFrame } from "../composition/resolve";
import { drawResolvedFrame, type Ctx2D } from "../composition/draw";
import { fakeContext } from "../composition/test-helpers";
import { layoutText } from "../composition/text-layout";
import { activeWordIndex, CAPTION_PRESETS, captionDefaultVisual, captionTextStyle, normalizeCaptionStyle, retimeWords, splitCaptionText, DEFAULT_CAPTION_STYLE_SETTINGS } from "./caption-model";
import { formatStamp, parseStamp, parseSubtitles, toSrt, toVtt, type SubtitleCue } from "./subtitle-io";
import { segmentWords, SEGMENT_PROFILES, toMono16k } from "./segmenter";

const FPS = 30;
const COMP = { width: 1920, height: 1080 };
const ctx = fakeContext({});
const base = () => createTimeline(FPS, COMP);
const cue = (start: number, end: number, text: string, extra: Partial<SubtitleCue> = {}): SubtitleCue => ({ start, end, text, ...extra });

function expectEditError(fn: () => unknown, reason: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TimelineEditError);
    expect((e as TimelineEditError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected ${reason}`);
}

describe("SRT / VTT", () => {
  const SRT = "﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> there,\r\nworld!\r\n\r\n2\r\n00:00:04,250 --> 00:00:06,000\r\n{\\an8}JOHN: Top line &amp; more\r\n\r\n00:00:07,000 --> 00:00:08,000\r\nNote: not a speaker\r\n\r\n4\r\n00:00:09,000 --> 00:00:08,000\r\nbackwards\r\n\r\ngarbage block\r\n";

  it("parses real-world SRT: BOM, CRLF, tags, ASS overrides, entities, missing index, SDH speakers; reports skipped blocks", () => {
    const r = parseSubtitles(SRT, "a.srt");
    expect(r.format).toBe("srt");
    expect(r.cues).toEqual([
      { start: 1, end: 3.5, text: "Hello there,\nworld!" },
      { start: 4.25, end: 6, text: "Top line & more", speaker: "JOHN" },
      { start: 7, end: 8, text: "Note: not a speaker" },
    ]);
    expect(r.warnings.join(" ")).toMatch(/Block 4: ends before it starts/);
    expect(r.warnings.join(" ")).toMatch(/Block 5: no timing line/);
  });

  const VTT = `WEBVTT - demo
Kind: captions

NOTE this is a comment

STYLE
::cue { color: yellow }

intro
00:01.000 --> 00:03.000 align:start line:85%
<v Alice>Hi <b>there</b></v>

01:00:02.500 --> 01:00:04.000
<v.loud Bob>Long show</v>

00:00:05.000 --> 00:00:07.000
<c.yellow>The</c> <00:00:05.500>quick <00:00:06.000>fox
`;

  it("parses VTT: header, NOTE/STYLE, cue ids + settings, hour-less stamps, voices -> speakers, inline stamps -> word timing", () => {
    const r = parseSubtitles(VTT);
    expect(r.format).toBe("vtt");
    expect(r.cues[0]).toEqual({ start: 1, end: 3, text: "Hi there", speaker: "Alice" });
    expect(r.cues[1]).toEqual({ start: 5, end: 7, text: "The quick fox", words: [{ text: "The", start: 5, end: 5.5 }, { text: "quick", start: 5.5, end: 6 }, { text: "fox", start: 6, end: 7 }] });
    expect(r.cues[2]).toMatchObject({ start: 3602.5, end: 3604, speaker: "Bob", text: "Long show" });
    expect(r.warnings).toEqual([]);
  });

  it("timestamps format and parse to the millisecond", () => {
    expect(formatStamp(3725.0456, ",")).toBe("01:02:05,046");
    expect(formatStamp(0.9995, ".")).toBe("00:00:01.000");
    expect(parseStamp("01:02:05,046")).toBeCloseTo(3725.046, 9);
    expect(parseStamp("02:05.5")).toBeCloseTo(125.5, 9);
    expect(parseStamp("00:61:00.000")).toBeNull();
  });

  it("SRT and VTT export round-trip through the parser (speakers, multi-line, word timings)", () => {
    const cues = [cue(0.5, 2, "First line\nsecond line", { speaker: "Ann" }), cue(2.5, 4.25, "A < B & C"), cue(5, 6.5, "word timed cue", { words: [{ text: "word", start: 5, end: 5.4 }, { text: "timed", start: 5.4, end: 6 }, { text: "cue", start: 6, end: 6.5 }] })];
    const srt = parseSubtitles(toSrt(cues), "x.srt").cues;
    expect(srt.map((c) => [c.start, c.end, c.text, c.speaker])).toEqual([[0.5, 2, "First line\nsecond line", "ANN"], [2.5, 4.25, "A < B & C", undefined], [5, 6.5, "word timed cue", undefined]]);
    const vttText = toVtt(cues, { language: "en", wordTimings: true });
    expect(vttText.startsWith("WEBVTT\nLanguage: en\n")).toBe(true);
    const vtt = parseSubtitles(vttText).cues;
    expect(vtt[0]).toEqual({ start: 0.5, end: 2, text: "First line\nsecond line", speaker: "Ann" });
    expect(vtt[1].text).toBe("A < B & C");
    expect(vtt[2].words).toEqual(cues[2].words);
  });
});

describe("speech-to-text words -> segments", () => {
  const W = (text: string, start: number, end: number) => ({ text, start, end });
  it("subtitle profile: sentence ends and pauses split; long runs split by length", () => {
    const words = [W("Hello", 0, 0.4), W("there.", 0.45, 0.9), W("This", 1.0, 1.2), W("is", 1.25, 1.4), W("after", 1.45, 1.8), W("a", 3.0, 3.1), W("pause", 3.15, 3.6)];
    const segs = segmentWords(words, SEGMENT_PROFILES.subtitle);
    expect(segs.map((s) => s.text)).toEqual(["Hello there.", "This is after", "a pause"]);
    expect(segs[1]).toMatchObject({ start: 1, end: 2 }); // 0.8 s of speech, held to the 1 s minimum (the next caption starts at 3 s)
    expect(segs[1].words).toHaveLength(3);
  });
  it("short-form profile: a few words at a time", () => {
    const words = "one two three four five six seven".split(" ").map((t, i) => W(t, i * 0.3, i * 0.3 + 0.25));
    expect(segmentWords(words, SEGMENT_PROFILES["short-form"]).map((s) => s.text)).toEqual(["one two three four", "five six seven"]);
  });
  it("minimum duration extends into the gap but never overlaps the next caption", () => {
    const segs = segmentWords([W("Hi.", 0, 0.2), W("Yo.", 0.6, 0.7)], { ...SEGMENT_PROFILES.subtitle, minDurationSec: 1 });
    expect(segs[0].end).toBeCloseTo(0.6, 9);
    expect(segs[1].end).toBeCloseTo(1.6, 9);
  });
  it("long speech: many words segment without loss, in order, never overlapping", () => {
    const words = Array.from({ length: 2000 }, (_, i) => W(`w${i}${i % 37 === 36 ? "." : ""}`, i * 0.3, i * 0.3 + 0.25));
    const segs = segmentWords(words);
    expect(segs.flatMap((s) => s.words!.map((w) => w.text))).toEqual(words.map((w) => w.text));
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end);
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(SEGMENT_PROFILES.subtitle.maxChars);
  });
  it("audio is down-mixed and resampled to 16 kHz mono for the recognizer", () => {
    const L = Float32Array.from({ length: 48000 }, (_, i) => i / 48000);
    const R = new Float32Array(48000);
    const m = toMono16k([L, R], 48000);
    expect(m.length).toBe(16000);
    expect(m[8000]).toBeCloseTo(0.25, 6);
  });
});

describe("caption model", () => {
  it("style normalization clamps and fills defaults; presets are valid styles", () => {
    expect(normalizeCaptionStyle({ fontSize: 9999, color: "red", x: 2, anchor: "sideways", fontWeight: 650 })).toMatchObject({ fontSize: 400, color: "#ffffff", x: 1, anchor: "bottom", fontWeight: 700 });
    expect(CAPTION_PRESETS.length).toBeGreaterThanOrEqual(8);
    for (const p of CAPTION_PRESETS) expect(normalizeCaptionStyle(p.style)).toEqual(p.style);
  });
  it("maps to the Text Engine's TextStyle and a bottom-anchored placement", () => {
    const s = { ...DEFAULT_CAPTION_STYLE_SETTINGS, fontSize: 60, stroke: true, padding: 10, maxWidth: 0.5 };
    expect(captionTextStyle(s, COMP)).toMatchObject({ fontSize: 60, stroke: true, padding: 10, maxWidth: 940, sizing: "point", background: true, textAlign: "center" });
    expect(captionTextStyle(s, COMP, "#ff0000").color).toBe("#ff0000");
    expect(captionDefaultVisual(s, COMP).transform).toMatchObject({ x: 960, y: 972, anchorX: 0.5, anchorY: 1 });
    expect(captionDefaultVisual({ ...s, textAlign: "left", anchor: "top", x: 0.05, y: 0.1 }, COMP).transform).toMatchObject({ x: 96, y: 108, anchorX: 0, anchorY: 0 });
  });
  it("manual correction keeps per-word timing when the word count is unchanged, re-spreads otherwise", () => {
    const words = [{ text: "teh", start: 0, end: 0.5 }, { text: "cat", start: 0.5, end: 1 }];
    expect(retimeWords(words, "the cat", 1)).toEqual([{ text: "the", start: 0, end: 0.5 }, { text: "cat", start: 0.5, end: 1 }]);
    const re = retimeWords(words, "the black cat", 1)!;
    expect(re.map((w) => w.text)).toEqual(["the", "black", "cat"]);
    expect(re[0].start).toBe(0);
    expect(re[2].end).toBeCloseTo(1, 9);
    expect(retimeWords(undefined, "x", 1)).toBeUndefined();
  });
  it("split by word timing or by proportional word boundary; active word for future highlighting", () => {
    const words = [{ text: "a", start: 0, end: 0.4 }, { text: "b", start: 0.5, end: 0.9 }, { text: "c", start: 1.2, end: 1.5 }];
    const s = splitCaptionText("a b c", words, 1, 2);
    expect(s.left).toEqual({ text: "a b", words: [words[0], words[1]] });
    expect(s.right).toEqual({ text: "c", words: [{ text: "c", start: 0.2, end: 0.5 }] });
    expect(splitCaptionText("one two three four", undefined, 1, 2)).toEqual({ left: { text: "one two" }, right: { text: "three four" } });
    expect(activeWordIndex(words, 0.6)).toBe(1);
    expect(activeWordIndex(words, 1.0)).toBe(-1);
  });
});

describe("captions on the timeline", () => {
  const sample = [cue(1, 3, "Short speech."), cue(3.5, 6, "Second caption", { speaker: "Bob" }), cue(5.5, 8, "Overlaps the previous one")];

  it("imports cues as caption clips on a new front track, frame-accurate, trimming overlaps (and counting them)", () => {
    let tl = base();
    tl = addTrack(tl, "video", "V").timeline;
    const r = importCaptionCues(tl, sample, { name: "English" });
    expect(r.timeline.trackIds[0]).toBe(r.trackId);
    expect(r.timeline.tracks[r.trackId]).toMatchObject({ kind: "caption", name: "English" });
    expect(r.clips.map((c) => [c.timelineStart, c.content.kind === "caption" && c.content.durationFrames])).toEqual([[30, 60], [105, 60], [165, 75]]);
    expect(r.adjusted).toBe(1); // the second cue was cut at 5.5 s
    expect(r.clips[1].content).toMatchObject({ speaker: "Bob" });
    // Export matches the input (after the overlap fix).
    expect(captionCuesOf(r.timeline, r.trackId).map((c) => [c.start, c.end, c.text])).toEqual([[1, 3, "Short speech."], [3.5, 5.5, "Second caption"], [5.5, 8, "Overlaps the previous one"]]);
  });

  it("cues starting on the same frame are placed back to back (never stacked on one track)", () => {
    const r = importCaptionCues(base(), [cue(1, 2, "first"), cue(1.01, 1.5, "same frame start"), cue(1.02, 1.03, "tiny")]);
    const spans = r.clips.map((c) => [c.timelineStart, c.timelineStart + (c.content as { durationFrames: number }).durationFrames]);
    expect(spans).toEqual([[30, 60], [60, 61], [61, 62]]);
    expect(r.adjusted).toBeGreaterThanOrEqual(3);
  });

  it("word timings are stored clip-relative and survive move / trim / split / merge", () => {
    const words = [{ text: "one", start: 2, end: 2.5 }, { text: "two", start: 2.5, end: 3 }, { text: "three", start: 3.2, end: 4 }];
    let r = importCaptionCues(base(), [cue(2, 4, "one two three", { words })]);
    let tl = r.timeline;
    const id = r.clips[0].id;
    const content = () => tl.clips[id].content as { words?: { start: number; end: number; text: string }[]; text?: string };
    expect(content().words![2]).toEqual({ text: "three", start: 1.2, end: 2 });
    tl = moveClip(tl, id, 90); // 3 s
    expect(captionCuesOf(tl, r.trackId)[0].words![0]).toEqual({ text: "one", start: 3, end: 3.5 });
    tl = trimClip(tl, id, "start", 105); // cut 0.5 s off the front: "one" is gone, "two" now starts at 0
    expect(content().words!.map((w) => [w.text, +w.start.toFixed(6)])).toEqual([["two", 0], ["three", 0.7]]);
    expect(captionCuesOf(tl, r.trackId)[0].words![0].start).toBeCloseTo(3.5, 9); // same timeline moment as before
    const sp = splitClip(tl, id, 120); // split at 4 s (0.5 s into the clip)
    expect([(sp.left.content as { text?: string }).text, (sp.right.content as { text?: string }).text]).toEqual(["two", "three"]);
    tl = mergeCaptionWithNext(sp.timeline, id);
    expect(content().text).toBe("two three");
    expect(content().words!.map((w) => +w.start.toFixed(6))).toEqual([0, 0.7]);
    void r;
  });

  it("manual correction, speaker, restyle, preset — and typed rejections", () => {
    const r = importCaptionCues(base(), sample);
    let tl = updateCaptionText(r.timeline, r.clips[0].id, "Corrected text.");
    expect((tl.clips[r.clips[0].id].content as { text?: string }).text).toBe("Corrected text.");
    expectEditError(() => updateCaptionText(tl, r.clips[0].id, "   "), "out-of-range");
    tl = setCaptionSpeaker(tl, r.clips[0].id, "Ann");
    expect(tl.clips[r.clips[0].id].content).toMatchObject({ speaker: "Ann" });
    tl = setCaptionSpeaker(tl, r.clips[0].id, null);
    expect("speaker" in tl.clips[r.clips[0].id].content).toBe(false);
    tl = setCaptionTrackSettings(tl, r.trackId, { style: { fontSize: 80, color: "#00ff00" }, speakerColors: { Bob: "#ff00ff" } });
    expect(tl.tracks[r.trackId].caption!.style).toMatchObject({ fontSize: 80, color: "#00ff00", background: true });
    tl = applyCaptionPreset(tl, r.trackId, "cinema");
    expect(tl.tracks[r.trackId].caption).toMatchObject({ presetId: "cinema", speakerColors: { Bob: "#ff00ff" }, style: { color: "#facc15", background: false } });
    // Hand-tuning after a preset makes the look "Custom"; non-style settings keep it.
    expect(setCaptionTrackSettings(tl, r.trackId, { language: "en" }).tracks[r.trackId].caption!.presetId).toBe("cinema");
    expect(setCaptionTrackSettings(tl, r.trackId, { style: { y: 0.2 } }).tracks[r.trackId].caption!.presetId).toBeUndefined();
    expectEditError(() => applyCaptionPreset(tl, r.trackId, "nope"), "out-of-range");
    const v = addTrack(tl, "video", "V");
    expectEditError(() => setCaptionTrackSettings(v.timeline, v.track.id, { style: { fontSize: 1 } }), "kind-mismatch");
    expectEditError(() => updateCaptionText(tl, "clip-nope", "x"), "clip-not-found");
    // Generic ops keep refusing invalid placements: a caption can't be dropped onto a video track.
    expectEditError(() => insertClip(v.timeline, v.track.id, { kind: "caption", text: "x", durationFrames: 10 }, 0), "kind-mismatch");
  });

  it("renders through the Text Engine: same layout as an equivalent text layer, track style, uppercase, speaker color, placement", () => {
    let r = importCaptionCues(base(), sample);
    let tl = setCaptionTrackSettings(r.timeline, r.trackId, { style: { uppercase: true }, speakerColors: { Bob: "#ff00ff" } });
    const at = (t: TimelineModel, sec: number) => resolveFrame(t, Math.round(sec * FPS), ctx).layers;
    expect(at(tl, 0.5)).toHaveLength(0); // no caption before 1 s
    const [layer] = at(tl, 2);
    expect(layer.kind).toBe("caption");
    if (layer.content.type !== "text") throw new Error("expected a text layer");
    expect(layer.content.layout.lines.map((l) => l.text).join(" ")).toBe("SHORT SPEECH.");
    // Identical to laying out the same text with the caption's TextStyle directly — no second text renderer.
    const style = captionTextStyle(tl.tracks[r.trackId].caption!.style, COMP);
    expect(layer.content.layout).toEqual(layoutText("SHORT SPEECH.", style, ctx.measurer));
    // Bottom-anchored at 90 % height, centered.
    expect(layer.bounds.y + layer.bounds.height).toBeCloseTo(0.9 * 1080, 6);
    expect(layer.bounds.x + layer.bounds.width / 2).toBeCloseTo(960, 6);
    const [bob] = at(tl, 4);
    expect(bob.content.type === "text" && bob.content.style.color).toBe("#ff00ff");
    // Restyling the track moves every caption that wasn't placed individually; a placed one keeps its spot.
    tl = setClipVisual(tl, r.clips[1].id, { transform: { y: 200 } });
    tl = setCaptionTrackSettings(tl, r.trackId, { style: { y: 0.5, anchor: "middle" } });
    expect(at(tl, 2)[0].bounds.y + at(tl, 2)[0].bounds.height / 2).toBeCloseTo(540, 6);
    expect(at(tl, 4)[0].visual.transform.y).toBe(200);
    void r;
  });

  it("captions can be keyframed (animated captions) without jumping, and draw with the text path", () => {
    const r = importCaptionCues(base(), [cue(0, 2, "Animated")]);
    const id = r.clips[0].id;
    const tl = addKeyframe(r.timeline, id, "visual.opacity", 0, 0);
    expect(tl.clips[id].visual!.transform.y).toBeCloseTo(972, 6); // placement made concrete, not the frame center
    const tl2 = addKeyframe(tl, id, "visual.opacity", 30, 1);
    expect(resolveFrame(tl2, 15, ctx).layers[0].opacity).toBeCloseTo(0.5, 6);
    const calls: string[] = [];
    const rec = new Proxy({}, { get: (_t, p: string) => (p === "canvas" ? { width: 1920, height: 1080 } : (...a: unknown[]) => void calls.push(`${p}:${String(a[0])}`)), set: () => true }) as Ctx2D;
    drawResolvedFrame(rec, resolveFrame(r.timeline, 10, ctx), new Map(), { renderScale: 1, smoothing: "high", getScratch: () => rec });
    expect(calls).toContain("fillText:Animated");
  });

  it("undo/redo through the engine: import, edit, restyle, delete", () => {
    const e = new TimelineEngine(FPS, COMP);
    const r = e.importCaptionCues(sample);
    if (!r.ok) throw r.error;
    const snaps = [e.timeline];
    expect(e.updateCaptionText(r.clips[0].id, "Fixed.").ok).toBe(true);
    snaps.push(e.timeline);
    expect(e.applyCaptionPreset(r.trackId, "boxed").ok).toBe(true);
    snaps.push(e.timeline);
    expect(e.deleteClip(r.clips[2].id).ok).toBe(true);
    snaps.push(e.timeline);
    for (let k = snaps.length - 2; k >= 0; k--) {
      e.undo();
      expect(e.timeline).toBe(snaps[k]);
    }
    e.undo();
    expect(Object.keys(e.timeline.tracks)).toHaveLength(0); // before the import
  });
});

describe("persistence (project v9)", () => {
  it("round-trips captions, words, speakers, track style and per-caption placement; renders identically", () => {
    const r = importCaptionCues(base(), [cue(1, 3, "Hello world", { speaker: "Ann", words: [{ text: "Hello", start: 1, end: 1.6 }, { text: "world", start: 1.7, end: 2.5 }] }), cue(3, 4, "Bye")]);
    let tl = applyCaptionPreset(r.timeline, r.trackId, "news");
    tl = setCaptionTrackSettings(tl, r.trackId, { language: "en-US", speakerColors: { Ann: "#22c55e" } });
    tl = setClipVisual(tl, r.clips[1].id, { transform: { y: 300 } });
    const loaded = deserializeTimeline(serializeTimeline(tl));
    expect(loaded.tracks).toEqual(tl.tracks);
    expect(loaded.clips).toEqual(tl.clips);
    for (const f of [30, 50, 95]) expect(resolveFrame(loaded, f, ctx)).toEqual(resolveFrame(tl, f, ctx));
  });
  it("rejects corrupt caption data; older projects load", () => {
    const r = importCaptionCues(base(), [cue(1, 3, "x", { words: [{ text: "x", start: 1, end: 2 }] })]);
    const bad = (fn: (doc: { timeline: Record<string, Record<string, Record<string, unknown>>> }) => void) => {
      const doc = JSON.parse(serializeTimeline(r.timeline));
      fn(doc);
      return () => deserializeTimeline(JSON.stringify(doc));
    };
    expect(bad((d) => ((d.timeline.clips[r.clips[0].id].content as Record<string, unknown>).words = [{ text: "x", start: 2, end: 1 }]))).toThrow(ProjectFormatError);
    expect(bad((d) => delete (d.timeline.clips[r.clips[0].id].content as Record<string, unknown>).text)).toThrow(/no text/);
    const v = addTrack(r.timeline, "video", "V");
    const doc = JSON.parse(serializeTimeline(v.timeline));
    doc.timeline.tracks[v.track.id].caption = {};
    expect(() => deserializeTimeline(JSON.stringify(doc))).toThrow(/caption settings/);
    const old = JSON.parse(serializeTimeline(addTrack(base(), "video", "V").timeline));
    old.version = 8;
    expect(() => deserializeTimeline(JSON.stringify(old))).not.toThrow();
  });
});

describe("caption animation (rendered through resolveFrame)", () => {
  const words = [
    { text: "one", start: 0, end: 0.4 },
    { text: "two", start: 0.5, end: 0.9 },
    { text: "three", start: 1.0, end: 1.4 },
  ];

  it("word modes follow the word timings", () => {
    expect(captionMotionAt("word-reveal", "one two three", words, 0.6, 1.5, 56)?.text).toBe("one two");
    expect(captionMotionAt("word-reveal", "one two three", words, 0, 1.5, 56)?.text).toBe("one");
    expect(captionMotionAt("word-single", "one two three", words, 1.2, 1.5, 56)?.text).toBe("three");
    expect(captionMotionAt("word-single", "one two three", words, 0.45, 1.5, 56)?.text).toBe("one");
  });

  it("word modes without timings fall back to the whole segment", () => {
    const m = captionMotionAt("word-single", "hello", undefined, 1, 2, 56);
    expect(m?.text).toBeUndefined();
    expect(m?.scale).toBeCloseTo(1);
  });

  it("entrances settle to rest; unknown or none render static", () => {
    expect(captionMotionAt("pop", "x", undefined, 0, 2, 56)!.scale).toBeLessThan(1);
    expect(captionMotionAt("pop", "x", undefined, 1, 2, 56)!.scale).toBeCloseTo(1);
    expect(captionMotionAt("rise", "x", undefined, 0, 2, 56)!.dy).toBeGreaterThan(0);
    expect(captionMotionAt("rise", "x", undefined, 1, 2, 56)!.dy).toBeCloseTo(0);
    expect(captionMotionAt("fade", "x", undefined, 2, 2, 56)!.opacity).toBe(0);
    expect(captionMotionAt("none", "x", undefined, 0, 2, 56)).toBeNull();
    expect(captionMotionAt("from-the-future", "x", undefined, 0, 2, 56)).toBeNull();
  });

  it("the resolved caption layer shows only the spoken words", () => {
    const e = new TimelineEngine(30, { width: 1920, height: 1080, background: "#000000" });
    const r = e.importCaptionCues([{ text: "one two three", start: 0, end: 1.5, words }], { name: "Captions" });
    if (!r.ok) throw r.error;
    const ok = e.applyCaptionPreset(r.trackId, "word-pop");
    if (!ok.ok) throw ok.error;
    const at = (f: number) => resolveFrame(e.timeline, f, fakeContext({})).layers[0];
    const text = (f: number) => {
      const l = at(f);
      return l.content.type === "text" ? l.content.layout.lines.map((ln: { text: string }) => ln.text).join(" ") : "";
    };
    expect(text(18)).toBe("ONE TWO");
    expect(text(40)).toBe("ONE TWO THREE");
  });
});
