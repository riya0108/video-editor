import { describe, expect, it } from "vitest";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addKeyframe, addTrack, duplicateClip, insertClip, moveClip, setClipAudio, setTrackMuted, setTrackSolo, splitClip, trimClip, normalizeClipAudioOp, setPropertyAnimated } from "../timeline/operations";
import { TimelineEngine } from "../timeline/engine";
import { TimelineEditError } from "../timeline/errors";
import { deserializeTimeline, ProjectFormatError, serializeTimeline } from "../timeline/serialize";
import { clipAudioOf, dbToLinear, fadeGainAt, fadeShape, guessAudioRole, linearToDb, normalizationFor, normalizeClipAudio } from "./model";
import { audioSegments, clipGainAt, clipPeakDb, computePeaks, decodeWav16, encodeWav16, mixTimeline, peakDbOf, sampleEnvelope, waveformColumns, type PcmSource } from "./engine-core";
import { checkAudioFile, checkDecodeBudget, describeAudioDecodeFailure, looksCorruptedDecode, MAX_AUDIO_DURATION_SEC, wavTruncation } from "./safety";

const FPS = 30;
const SR = 1000; // small sample rate keeps exact-value tests readable
const COMP = { width: 100, height: 100 };

/** A source of `sec` seconds with value fn(t) on both channels. */
function pcm(sec: number, fn: (t: number, i: number) => number, sampleRate = SR, channels = 2): PcmSource {
  const n = Math.round(sec * sampleRate);
  return { sampleRate, channels: Array.from({ length: channels }, () => Float32Array.from({ length: n }, (_, i) => fn(i / sampleRate, i))) };
}
const DC = (v: number, sec = 10) => pcm(sec, () => v);

function project() {
  let tl = createTimeline(FPS, COMP);
  const m = addTrack(tl, "audio", "Music");
  tl = m.timeline;
  const v = addTrack(tl, "audio", "Voice");
  tl = v.timeline;
  return { tl, music: m.track.id, voice: v.track.id };
}
const audioContent = (sourceId: string, inF: number, outF: number) => ({ kind: "audio" as const, source: { sourceId, sourceDurationFrames: 300 }, sourceInFrame: inF, sourceOutFrame: outF });

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

const mix = (tl: TimelineModel, sources: Record<string, PcmSource>, startSec: number, endSec: number) => mixTimeline(tl, (id) => sources[id], { sampleRate: SR, startSec, endSec });
const at = (r: { channels: [Float32Array, Float32Array] }, sec: number, startSec = 0) => r.channels[0][Math.round((sec - startSec) * SR)];

describe("audio model", () => {
  it("defaults, validation and clamping", () => {
    expect(clipAudioOf({})).toEqual({ volume: 1, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, fadeCurve: "linear", muted: false });
    expect(normalizeClipAudio({ volume: 9, gainDb: -500, fadeInFrames: 2.6, fadeOutFrames: -3, fadeCurve: "zzz", muted: "yes", role: "voiceover" })).toEqual({
      volume: 2,
      gainDb: -60,
      fadeInFrames: 3,
      fadeOutFrames: 0,
      fadeCurve: "linear",
      muted: false,
      role: "voiceover",
    });
    expect(normalizeClipAudio("x")).toBeNull();
    expect(dbToLinear(6.0206)).toBeCloseTo(2, 4);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(linearToDb(0)).toBe(-Infinity);
  });

  it("fade curves and fade gain (incl. fades longer than a trimmed clip scale down instead of overlapping)", () => {
    expect(fadeShape(0.5, "linear")).toBe(0.5);
    expect(fadeShape(0.5, "equal-power")).toBeCloseTo(Math.SQRT1_2, 9);
    expect(fadeShape(0.25, "s-curve")).toBeCloseTo((1 - Math.cos(Math.PI / 4)) / 2, 9);
    const a = { fadeInFrames: 10, fadeOutFrames: 20, fadeCurve: "linear" as const };
    expect(fadeGainAt(0, 100, a)).toBe(0);
    expect(fadeGainAt(5, 100, a)).toBe(0.5);
    expect(fadeGainAt(50, 100, a)).toBe(1);
    expect(fadeGainAt(90, 100, a)).toBe(0.5);
    expect(fadeGainAt(100, 100, a)).toBe(0);
    // 30 frames of fades on a 15-frame clip: both scaled by 0.5 -> in 5, out 10, meeting without overlap.
    expect(fadeGainAt(5, 15, a)).toBe(1);
    expect(fadeGainAt(2.5, 15, a)).toBe(0.5);
  });

  it("normalization: target − peak, silence refused, target clamped", () => {
    expect(normalizationFor(-12, -1)).toEqual({ targetDb: -1, peakDb: -12, gainDb: 11 });
    expect(normalizationFor(-3, 5).targetDb).toBe(0);
    expect(() => normalizationFor(-Infinity, -1)).toThrow(/silent/);
  });

  it("guesses roles from file names: music / voiceover / sfx / ambient", () => {
    expect(guessAudioRole("Epic Theme.mp3")).toBe("music");
    expect(guessAudioRole("intro_voiceover_take2.m4a")).toBe("voiceover");
    expect(guessAudioRole("whoosh-01.wav")).toBe("sfx");
    expect(guessAudioRole("rain ambience.ogg")).toBe("ambient");
  });
});

describe("audio operations", () => {
  it("setClipAudio on audio and video clips; rejected on clips without sound", () => {
    let { tl, music } = project();
    const a = insertClip(tl, music, audioContent("m", 0, 90), 0);
    tl = setClipAudio(a.timeline, a.clip.id, { volume: 0.5, gainDb: 3, fadeInFrames: 15, fadeOutFrames: 30, fadeCurve: "equal-power", role: "music" });
    expect(tl.clips[a.clip.id].audio).toEqual({ volume: 0.5, gainDb: 3, fadeInFrames: 15, fadeOutFrames: 30, fadeCurve: "equal-power", muted: false, role: "music" });
    const vt = addTrack(tl, "video", "V");
    const v = insertClip(vt.timeline, vt.track.id, { kind: "video", source: { sourceId: "vid" }, sourceInFrame: 0, sourceOutFrame: 60 }, 0);
    expect(setClipAudio(v.timeline, v.clip.id, { muted: true }).clips[v.clip.id].audio!.muted).toBe(true);
    const it = addTrack(v.timeline, "image", "I");
    const img = insertClip(it.timeline, it.track.id, { kind: "image", source: { sourceId: "i" }, durationFrames: 30 }, 0);
    expectEditError(() => setClipAudio(img.timeline, img.clip.id, { volume: 1 }), "kind-mismatch");
    expectEditError(() => setClipAudio(tl, a.clip.id, { volume: NaN }), "invalid-visual");
  });

  it("volume automation through the keyframe engine (and auto-key on edit)", () => {
    let { tl, music } = project();
    const a = insertClip(tl, music, audioContent("m", 0, 90), 0);
    tl = addKeyframe(a.timeline, a.clip.id, "audio.volume", 0, 0);
    tl = addKeyframe(tl, a.clip.id, "audio.volume", 30, 1);
    const clip = tl.clips[a.clip.id];
    expect(clipGainAt(clip, 15, COMP)).toBeCloseTo(0.5, 9); // linear default easing between keys
    expect(clipGainAt(clip, 60, COMP)).toBe(1);
    // Editing volume at the playhead while animated adds a key there; the static base stays.
    tl = setClipAudio(tl, a.clip.id, { volume: 0.25 }, 60);
    expect(tl.clips[a.clip.id].animation!.tracks["audio.volume"].keyframes.map((k) => [k.frame, k.value])).toEqual([[0, 0], [30, 1], [60, 0.25]]);
    expect(tl.clips[a.clip.id].audio!.volume).toBe(1);
    // Gain automation too; visual paths are refused on an audio clip; audio paths refused on an image.
    expect(setPropertyAnimated(tl, a.clip.id, "audio.gainDb", true, 0).clips[a.clip.id].animation!.tracks["audio.gainDb"]).toBeDefined();
    expectEditError(() => addKeyframe(tl, a.clip.id, "visual.opacity", 0, 1), "kind-mismatch");
    const it = addTrack(tl, "image", "I");
    const img = insertClip(it.timeline, it.track.id, { kind: "image", source: { sourceId: "i" }, durationFrames: 30 }, 0);
    expectEditError(() => addKeyframe(img.timeline, img.clip.id, "audio.volume", 0, 1), "kind-mismatch");
  });

  it("fade automation: fades and volume keyframes compose on one envelope", () => {
    let { tl, music } = project();
    const a = insertClip(tl, music, audioContent("m", 0, 90), 0); // 3 s
    tl = setClipAudio(a.timeline, a.clip.id, { fadeInFrames: 30, fadeOutFrames: 30 });
    tl = addKeyframe(tl, a.clip.id, "audio.volume", 0, 0.5);
    const env = sampleEnvelope(tl.clips[a.clip.id], FPS, 0, 3, COMP, 10);
    expect(env[0]).toBe(0);
    expect(env[5]).toBeCloseTo(0.25, 9); // half-way through the fade-in x volume 0.5
    expect(env[15]).toBeCloseTo(0.5, 9);
    expect(env[30]).toBe(0);
  });

  it("trim / split / move / duplicate keep sound in sync with the timeline", () => {
    let { tl, music } = project();
    const a = insertClip(tl, music, audioContent("m", 30, 150), 60); // timeline 2s..6s, source 1s..5s
    tl = setClipAudio(a.timeline, a.clip.id, { fadeInFrames: 15, fadeOutFrames: 15, gainDb: -6 });
    // Split: left keeps the fade-in, right the fade-out; gain carries over; no new fade at the cut.
    const sp = splitClip(tl, a.clip.id, 120);
    expect(sp.left.audio).toMatchObject({ fadeInFrames: 15, fadeOutFrames: 0, gainDb: -6 });
    expect(sp.right.audio).toMatchObject({ fadeInFrames: 0, fadeOutFrames: 15, gainDb: -6 });
    const src = { m: pcm(10, (t) => t / 10) }; // ramp: value encodes source time
    const whole = mix(tl, src, 0, 8);
    const halves = mix(sp.timeline, src, 0, 8);
    for (const s of [2.2, 3.9, 4.0, 4.1, 5.5]) expect(at(halves, s)).toBeCloseTo(at(whole, s), 6);
    // Sync after move: source time 1.0 s plays at the clip's new start.
    const moved = moveClip(tl, a.clip.id, 150); // starts at 5 s
    expect(at(mix(moved, src, 0, 10), 5.75)).toBeCloseTo((1.75 / 10) * dbToLinear(-6), 3);
    // Trim the start by 30 frames: same source sample still lands at the same timeline time.
    const trimmed = trimClip(tl, a.clip.id, "start", 90);
    expect(at(mix(trimmed, src, 0, 8), 4.5)).toBeCloseTo(at(whole, 4.5), 6);
    const dup = duplicateClip(tl, a.clip.id);
    expect(dup.clip.audio).toEqual(tl.clips[a.clip.id].audio);
  });

  it("normalize: stores make-up gain from the measured peak; undo/redo through the engine", () => {
    const e = new TimelineEngine(FPS, COMP);
    const t = e.addTrack("audio", "VO");
    if (!t.ok) throw t.error;
    const c = e.insertClip(t.track.id, audioContent("vo", 0, 90), 0);
    if (!c.ok) throw c.error;
    e.resetHistory();
    const src = pcm(3, (tt) => 0.25 * Math.sin(2 * Math.PI * 5 * tt));
    const peak = clipPeakDb(e.timeline.clips[c.clip.id], src, FPS);
    expect(peak).toBeCloseTo(linearToDb(0.25), 3);
    expect(e.normalizeClipAudio(c.clip.id, peak, -1).ok).toBe(true);
    const n = e.timeline.clips[c.clip.id].audio!.normalize!;
    expect(n.gainDb).toBeCloseTo(-1 - linearToDb(0.25), 3);
    const out = mixTimeline(e.timeline, () => src, { sampleRate: SR, startSec: 0, endSec: 3 });
    expect(linearToDb(out.peak)).toBeCloseTo(-1, 2);
    expect(e.setClipAudio(c.clip.id, { volume: 0.5 }).ok).toBe(true);
    expect(e.setClipAudio(c.clip.id, { normalize: null }).ok).toBe(true);
    expect(e.timeline.clips[c.clip.id].audio!.normalize).toBeUndefined();
    e.undo();
    expect(e.timeline.clips[c.clip.id].audio!.normalize).toEqual(n);
    e.undo();
    e.undo();
    expect(e.timeline.clips[c.clip.id].audio).toBeUndefined();
    e.redo();
    expect(e.timeline.clips[c.clip.id].audio!.normalize).toEqual(n);
    expect(e.normalizeClipAudio(c.clip.id, -Infinity).ok).toBe(false); // silent clip
  });
});

describe("mixing, sync, mute/solo, multiple tracks (exact samples)", () => {
  it("music + voiceover + SFX + ambient sum on separate tracks, each with its own level", () => {
    let tl = createTimeline(FPS, COMP);
    const ids: Record<string, string> = {};
    for (const [name, level] of [["music", 0.1], ["voice", 0.2], ["sfx", 0.3], ["amb", 0.05]] as const) {
      const t = addTrack(tl, "audio", name);
      const c = insertClip(t.timeline, t.track.id, audioContent(name, 0, 60), 0);
      tl = c.timeline;
      ids[name] = c.clip.id;
      void level;
    }
    const sources = { music: DC(0.1), voice: DC(0.2), sfx: DC(0.3), amb: DC(0.05) };
    expect(at(mix(tl, sources, 0, 2), 1)).toBeCloseTo(0.65, 6);
    tl = setClipAudio(tl, ids.music, { volume: 0.5 });
    tl = setClipAudio(tl, ids.sfx, { gainDb: 20 * Math.log10(2) });
    expect(at(mix(tl, sources, 0, 2), 1)).toBeCloseTo(0.05 + 0.2 + 0.6 + 0.05, 5);
  });

  it("track mute, solo (derived — un-soloing restores), clip mute", () => {
    let { tl, music, voice } = project();
    const m = insertClip(tl, music, audioContent("m", 0, 60), 0);
    const v = insertClip(m.timeline, voice, audioContent("v", 0, 60), 0);
    tl = v.timeline;
    const src = { m: DC(0.1), v: DC(0.2) };
    expect(at(mix(setTrackMuted(tl, music, true), src, 0, 2), 1)).toBeCloseTo(0.2, 6);
    expect(at(mix(setTrackSolo(tl, music, true), src, 0, 2), 1)).toBeCloseTo(0.1, 6);
    expect(at(mix(setTrackSolo(setTrackSolo(tl, music, true), music, false), src, 0, 2), 1)).toBeCloseTo(0.3, 6);
    expect(at(mix(setClipAudio(tl, v.clip.id, { muted: true }), src, 0, 2), 1)).toBeCloseTo(0.1, 6);
  });

  it("sync: sample-accurate placement of a click, including trimmed in-points and a mid-clip start", () => {
    let { tl, music } = project();
    // Source has a single click at 0.75 s. Clip starts at timeline 1 s with in-point 0.5 s -> click at 1.25 s.
    const src = { s: pcm(5, (_t, i) => (i === 750 ? 1 : 0)) };
    tl = insertClip(tl, music, audioContent("s", 15, 120), 30).timeline;
    const r = mix(tl, src, 0, 4);
    const idx = r.channels[0].findIndex((x) => x > 0.5);
    expect(idx).toBe(1250);
    // Rendering from mid-clip (playback started at 1.1 s) puts it at the same timeline time.
    const r2 = mix(tl, src, 1.1, 4);
    expect(r2.channels[0].findIndex((x) => x > 0.5)).toBe(1250 - 1100);
    const segs = audioSegments(tl, { fromSec: 1.1, hasAudio: () => true });
    expect(segs[0].sourceOffsetSec).toBeCloseTo(0.6, 9);
    expect(segs[0].timelineStartSec).toBeCloseTo(1.1, 9);
  });

  it("resamples sources at a different rate (linear interpolation) without shifting time", () => {
    let { tl, music } = project();
    tl = insertClip(tl, music, audioContent("lo", 0, 60), 0).timeline;
    const lo = pcm(2, (t) => t, 250); // 250 Hz ramp
    const r = mixTimeline(tl, () => lo, { sampleRate: SR, startSec: 0, endSec: 2 });
    expect(r.channels[0][500]).toBeCloseTo(0.5, 6);
    expect(r.channels[0][501]).toBeCloseTo(0.501, 6);
  });

  it("video soundtracks mix in; missing/undecodable sources are silent, never garbage", () => {
    let { tl, music } = project();
    tl = insertClip(tl, music, audioContent("m", 0, 60), 0).timeline;
    const vt = addTrack(tl, "video", "V");
    const v = insertClip(vt.timeline, vt.track.id, { kind: "video", source: { sourceId: "vid" }, sourceInFrame: 0, sourceOutFrame: 60 }, 0);
    tl = v.timeline;
    expect(at(mix(tl, { m: DC(0.1), vid: DC(0.2) }, 0, 2), 1)).toBeCloseTo(0.3, 6);
    expect(at(mix(tl, { m: DC(0.1) }, 0, 2), 1)).toBeCloseTo(0.1, 6); // video without audio / missing
    expect(at(mix(setClipAudio(tl, v.clip.id, { muted: true }), { m: DC(0.1), vid: DC(0.2) }, 0, 2), 1)).toBeCloseTo(0.1, 6);
    // A source shorter than the clip claims: the tail is silence.
    expect(at(mix(tl, { m: DC(0.1, 1) }, 0, 2), 1.5)).toBe(0);
  });

  it("reports clipping instead of hiding it", () => {
    let { tl, music, voice } = project();
    tl = insertClip(tl, music, audioContent("a", 0, 30), 0).timeline;
    tl = insertClip(tl, voice, audioContent("b", 0, 30), 0).timeline;
    const r = mix(tl, { a: DC(0.7), b: DC(0.7) }, 0, 1);
    expect(r.peak).toBeCloseTo(1.4, 6);
    expect(r.clippedSamples).toBe(2000);
  });
});

describe("waveform, levels, WAV", () => {
  it("peaks are exact per bin and reduce to drawing columns", () => {
    const src = pcm(1, (_t, i) => (i % 100 === 0 ? 0.9 : i % 100 === 50 ? -0.4 : 0));
    const p = computePeaks(src, 10); // 100 samples per bin
    expect(p.min.length).toBe(10);
    expect(Array.from(p.max)).toEqual(new Array(10).fill(Math.fround(0.9)));
    expect(Array.from(p.min).every((v) => Math.abs(v + 0.4) < 1e-6)).toBe(true);
    const cols = waveformColumns(p, 0.2, 0.6, 2);
    expect(cols.max[0]).toBeCloseTo(0.9, 6);
    expect(cols.min[1]).toBeCloseTo(-0.4, 6);
  });

  it("peak level over a trimmed range only", () => {
    const src = pcm(4, (t) => (t < 2 ? 0.1 : 0.8));
    expect(peakDbOf(src)).toBeCloseTo(linearToDb(0.8), 4);
    expect(peakDbOf(src, 0, 1.9)).toBeCloseTo(linearToDb(0.1), 4);
    expect(peakDbOf(DC(0))).toBe(-Infinity);
  });

  it("16-bit WAV export round-trips within quantization; out-of-range samples are clamped", () => {
    const L = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.7]);
    const R = Float32Array.from([0.25, -0.25, 0, 0, 0, -2]);
    const back = decodeWav16(encodeWav16([L, R], 44100));
    expect(back.sampleRate).toBe(44100);
    for (let i = 0; i < 5; i++) expect(back.channels[0][i]).toBeCloseTo(L[i], 4);
    expect(back.channels[0][5]).toBe(1);
    expect(back.channels[1][5]).toBe(-1);
  });
});

describe("safe handling", () => {
  it("file checks: unsupported codec, unknown, empty, too large", () => {
    expect(checkAudioFile({ name: "a.mp3", type: "audio/mpeg", size: 10 }).ok).toBe(true);
    expect(checkAudioFile({ name: "a.flac", type: "", size: 10 }).ok).toBe(true);
    const wma = checkAudioFile({ name: "a.wma", type: "audio/x-ms-wma", size: 10 });
    expect(!wma.ok && wma.reason).toBe("unsupported");
    expect(checkAudioFile({ name: "a.wav", type: "audio/wav", size: 0 })).toMatchObject({ ok: false, reason: "empty" });
    expect(checkAudioFile({ name: "a.wav", type: "audio/wav", size: 600 * 1024 * 1024 })).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("very long files are refused from metadata, before decoding allocates anything", () => {
    expect(checkDecodeBudget("long.mp3", MAX_AUDIO_DURATION_SEC + 60, 48000, 0)).toMatchObject({ ok: false, reason: "too-long" });
    expect(checkDecodeBudget("ok.mp3", 600, 48000, 0).ok).toBe(true);
    expect(checkDecodeBudget("x.mp3", 1200, 48000, 1.4 * 1024 ** 3)).toMatchObject({ ok: false, reason: "over-budget" });
    expect(checkDecodeBudget("bad.mp3", NaN, 48000, 0)).toMatchObject({ ok: false, reason: "no-duration" });
    expect(checkDecodeBudget("live.mp3", Infinity, 48000, 0)).toMatchObject({ ok: false, reason: "no-duration" });
  });

  it("truncated WAVs are detected from the header (browsers silently play them short)", () => {
    const full = encodeWav16([new Float32Array(1000)], 1000); // 1 s mono
    expect(wavTruncation(full.buffer as ArrayBuffer)).toBeNull();
    const cut = full.slice(0, 44 + 500).buffer as ArrayBuffer; // header still claims 1 s
    expect(wavTruncation(cut)).toEqual({ declaredSec: 1, presentSec: 0.25 });
    expect(wavTruncation(new Uint8Array(100).buffer)).toBeNull(); // not a WAV
  });

  it("decoder failures are classified and phrased; truncated decodes are detected", () => {
    const enc = Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" });
    expect(describeAudioDecodeFailure("x.m4a", enc).reason).toBe("unsupported-codec");
    expect(describeAudioDecodeFailure("x.mp3", new Error("Decoding timed out")).reason).toBe("timeout");
    expect(describeAudioDecodeFailure("x.mp3", new Error("bad header")).reason).toBe("corrupted");
    expect(looksCorruptedDecode(0, 48000, 10)).toBe(true);
    expect(looksCorruptedDecode(48000 * 2, 48000, 10)).toBe(true); // 2 s decoded of a claimed 10 s
    expect(looksCorruptedDecode(48000 * 10, 48000, 10)).toBe(false);
  });
});

describe("persistence (project v8)", () => {
  it("round-trips audio settings, roles, normalization, automation and mute/solo; mix identical after reload", () => {
    let { tl, music, voice } = project();
    const m = insertClip(tl, music, audioContent("m", 0, 90), 0);
    const v = insertClip(m.timeline, voice, audioContent("v", 0, 60), 15);
    tl = setClipAudio(v.timeline, m.clip.id, { volume: 0.8, fadeInFrames: 10, fadeOutFrames: 20, fadeCurve: "s-curve", role: "music" });
    tl = normalizeClipAudioOp(tl, v.clip.id, -9, -1);
    tl = addKeyframe(tl, m.clip.id, "audio.volume", 30, 0.2);
    tl = addKeyframe(tl, m.clip.id, "audio.volume", 60, 1);
    tl = setTrackSolo(setTrackMuted(tl, voice, true), music, true);
    const loaded = deserializeTimeline(serializeTimeline(tl));
    expect(loaded.clips).toEqual(tl.clips);
    expect(loaded.tracks).toEqual(tl.tracks);
    const src = { m: pcm(5, (t) => Math.sin(t * 40)), v: DC(0.3) };
    const a = mix(tl, src, 0, 3);
    const b = mix(loaded, src, 0, 3);
    expect(Array.from(b.channels[0])).toEqual(Array.from(a.channels[0]));
  });

  it("rejects invalid audio data", () => {
    let { tl, music } = project();
    const m = insertClip(tl, music, audioContent("m", 0, 90), 0);
    tl = m.timeline;
    const doc = JSON.parse(serializeTimeline(tl));
    doc.timeline.clips[m.clip.id].animation = { tracks: { "visual.opacity": { keyframes: [{ id: "k", frame: 0, value: 1, easing: { type: "linear" } }] } } };
    expect(() => deserializeTimeline(JSON.stringify(doc))).toThrow(ProjectFormatError);
    const it = addTrack(tl, "image", "I");
    const img = insertClip(it.timeline, it.track.id, { kind: "image", source: { sourceId: "i" }, durationFrames: 30 }, 0);
    const doc2 = JSON.parse(serializeTimeline(img.timeline));
    doc2.timeline.clips[img.clip.id].audio = { volume: 1 };
    expect(() => deserializeTimeline(JSON.stringify(doc2))).toThrow(/can't have audio/);
    const doc3 = JSON.parse(serializeTimeline(tl));
    doc3.timeline.clips[m.clip.id].audio = "loud";
    expect(() => deserializeTimeline(JSON.stringify(doc3))).toThrow(/invalid audio/);
  });

  it("older projects (v7) load with default audio", () => {
    let { tl, music } = project();
    tl = insertClip(tl, music, audioContent("m", 0, 90), 0).timeline;
    const doc = JSON.parse(serializeTimeline(tl));
    doc.version = 7;
    const loaded = deserializeTimeline(JSON.stringify(doc));
    expect(clipAudioOf(Object.values(loaded.clips)[0])).toMatchObject({ volume: 1, gainDb: 0 });
  });
});
