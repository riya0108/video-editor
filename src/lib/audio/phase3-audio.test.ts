import { describe, expect, it } from "vitest";
import { fft, istft, stft } from "./dsp";
import { cleanVoice } from "./clean";
import { applyDucking, speechRegions } from "./ducking";
import { detectBeats, snapCutsToBeats, splitOnBeats } from "./beats";
import { TimelineEngine } from "../timeline/engine";
import { valueAt } from "../animation/properties";
import { clipTimelineEnd } from "../timeline/clip";

/** Deterministic noise (tests must not flake). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

describe("DSP core", () => {
  it("FFT finds a pure tone's bin", () => {
    const n = 64;
    const re = new Float32Array(n).map((_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float32Array(n);
    fft(re, im);
    const mags = [...re].map((r, i) => Math.hypot(r, im[i]));
    expect(mags.indexOf(Math.max(...mags.slice(0, n / 2)))).toBe(5);
  });

  it("STFT -> ISTFT reconstructs the signal", () => {
    const r = rng(1);
    const x = new Float32Array(5000).map(() => r());
    const y = istft(stft(x, 512, 128), x.length);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
    expect(err).toBeLessThan(1e-4);
  });
});

describe("Clean Audio", () => {
  it("cuts steady noise in pauses while keeping the voice-band tone", async () => {
    const sr = 16000;
    const r = rng(2);
    const x = new Float32Array(sr * 4);
    for (let i = 0; i < x.length; i++) {
      const speaking = i > sr && i < sr * 3;
      x[i] = 0.02 * r() + (speaking ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr) : 0);
    }
    const { audio, report } = await cleanVoice(x, sr, { strength: 0.6, normalize: false });
    const noiseBefore = rms(x, 0, sr * 0.8);
    const noiseAfter = rms(audio, 0, sr * 0.8);
    expect(20 * Math.log10(noiseAfter / noiseBefore)).toBeLessThan(-9);
    const toneBefore = rms(x, sr * 1.5, sr * 2.5);
    const toneAfter = rms(audio, sr * 1.5, sr * 2.5);
    expect(toneAfter / toneBefore).toBeGreaterThan(0.85);
    expect(report.reductionDb).toBeGreaterThan(10);
  });

  it("levels quiet speech up and never clips", async () => {
    const sr = 16000;
    // Quiet "speech" (bursts with pauses) over a faint noise floor.
    const r = rng(3);
    const x = new Float32Array(sr * 3).map((_, i) => 0.001 * r() + (Math.floor(i / (sr * 0.5)) % 2 === 1 ? 0.02 * Math.sin((2 * Math.PI * 300 * i) / sr) : 0));
    const { audio, report } = await cleanVoice(x, sr, { strength: 0.3, normalize: true });
    expect(report.gainDb).toBeGreaterThan(6);
    expect(Math.max(...audio.map(Math.abs))).toBeLessThanOrEqual(0.892);
  });
});

describe("auto-ducking", () => {
  it("finds speech regions and ducks only the music under them", () => {
    const sr = 16000;
    const x = new Float32Array(sr * 6);
    for (let i = 0; i < x.length; i++) if ((i > sr * 1 && i < sr * 2.5) || (i > sr * 4 && i < sr * 5)) x[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / sr);
    const regions = speechRegions(x, sr);
    expect(regions).toHaveLength(2);
    expect(regions[0][0]).toBeCloseTo(1, 1);
    expect(regions[1][1]).toBeCloseTo(5.2, 0);

    const e = new TimelineEngine(30, { width: 1920, height: 1080 });
    const t = e.addTrack("audio", "Music");
    if (!t.ok) throw t.error;
    const c = e.insertClip(t.track.id, { kind: "audio", source: { sourceId: "m", sourceDurationFrames: 300 }, sourceInFrame: 0, sourceOutFrame: 180 }, 0);
    if (!c.ok) throw c.error;
    const r = e.transact((tl) => applyDucking(tl, [c.clip.id], regions).timeline);
    if (!r.ok) throw r.error;
    const clip = e.timeline.clips[c.clip.id];
    const g = (sec: number) => valueAt(clip, "audio.gainDb", Math.round(sec * 30), e.timeline.composition);
    expect(g(0.3)).toBeCloseTo(0);
    expect(g(1.8)).toBeCloseTo(-12);
    expect(g(3.6)).toBeCloseTo(0);
    expect(g(4.5)).toBeCloseTo(-12);
  });
});

describe("beat detection and beat sync", () => {
  it("finds the tempo and beats of a 120 BPM click track", async () => {
    const sr = 22050;
    const x = new Float32Array(sr * 12);
    for (let b = 0; b < 24; b++) {
      const at = Math.round(b * 0.5 * sr);
      for (let i = 0; i < 600 && at + i < x.length; i++) x[at + i] += Math.exp(-i / 120) * Math.sin(i * 0.9);
    }
    const a = await detectBeats(x, sr);
    expect(a.bpm).toBeGreaterThan(115);
    expect(a.bpm).toBeLessThan(125);
    const near = a.beats.filter((t) => Math.abs(t / 0.5 - Math.round(t / 0.5)) < 0.06).length;
    expect(near / a.beats.length).toBeGreaterThan(0.85);
  });

  it("splits on beats and snaps cuts to the beat grid", () => {
    const e = new TimelineEngine(30, { width: 1920, height: 1080 });
    const t = e.addTrack("video", "Main");
    if (!t.ok) throw t.error;
    const add = (at: number, len: number) => {
      const r = e.insertClip(t.track.id, { kind: "video", source: { sourceId: "v", sourceDurationFrames: 900 }, sourceInFrame: 0, sourceOutFrame: len }, at);
      if (!r.ok) throw r.error;
    };
    add(0, 50);
    add(50, 70);
    add(120, 60);
    const beats = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165];
    const r = e.transact((tl) => snapCutsToBeats(tl, t.track.id, beats, 10).timeline);
    if (!r.ok) throw r.error;
    const clips = e.timeline.tracks[t.track.id].clipIds.map((id) => e.timeline.clips[id]).sort((a, b) => a.timelineStart - b.timelineStart);
    expect(clipTimelineEnd(clips[0])).toBe(45);
    expect(clips[1].timelineStart).toBe(45);
    expect(clipTimelineEnd(clips[1])).toBe(105);
    expect(clips[2].timelineStart).toBe(105);
    const s = e.transact((tl) => splitOnBeats(tl, t.track.id, [120, 135, 150], 1).timeline);
    if (!s.ok) throw s.error;
    expect(e.timeline.tracks[t.track.id].clipIds).toHaveLength(6);
  });
});
