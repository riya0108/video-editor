import { describe, expect, it } from "vitest";
import { TimelineEngine } from "../timeline/engine";
import { clipTimelineEnd } from "../timeline/clip";
import { AIJobQueue, type AIJob } from "./jobs";
import { AIError, toAIError } from "./errors";
import { AIRegistry, createDefaultRegistry } from "./registry";
import { AIResultStore, applyItemPatch } from "./store";
import type { AIFrame, AIMediaSource } from "./media";
import type { AIProvider, AIRequest, AIServices } from "./provider";
import { conf, confidenceBand, marginConfidence, type AIResult, type Box, type ShotItem, type SceneItem } from "./types";
import { detectSilences, silenceProvider } from "./features/silence";
import { analyseShots, detectBoundaries, frameFeatures, groupScenes } from "./features/shots";
import { trackTemplate, type Gray } from "./features/tracking";
import { buildCleanPlate } from "./features/object-removal";
import { diarize } from "./features/speakers";
import { findFillers, fillerProvider } from "./features/fillers";
import { clearTranscriptCache } from "./features/transcript";
import { suggestBroll } from "./features/broll";
import { scoreHighlights, highlightProvider } from "./features/highlights";
import { createDetectionProvider, iou, linkDetections } from "./features/detection";
import { computeReframePath, cropSize, createReframeProvider } from "./features/reframe";
import { addBrollPlaceholders, addObjectRemovalLayer, applyReframe, labelCaptionSpeakers, maskFromTrack, removeRanges, simplifyKeys, splitAtBoundaries, sourceToTimeline } from "./apply";

/**
 * PHASE 14 — AI EDITING ENGINE acceptance suite. Every algorithm runs on SYNTHETIC media with exact ground truth
 * (known cut frames, known silence, a known motion path, a known background); model-backed providers run against
 * fake backends here (their wiring/linking/errors) and against the REAL models in the browser (test report).
 */

// ---- helpers ------------------------------------------------------------------

const ctx = (services: AIServices = {}) => ({ signal: new AbortController().signal, progress: () => {}, services });

function frame(w: number, h: number, px: (x: number, y: number) => [number, number, number]): AIFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

function fakeMedia(opts: Partial<AIMediaSource> & { frameFn?: (t: number) => AIFrame; pcm?: Float32Array; sampleRate?: number }): AIMediaSource {
  return {
    sourceStart: 0,
    sourceEnd: 4,
    fps: 24,
    width: 1920,
    height: 1080,
    hasVideo: !!opts.frameFn,
    hasAudio: !!opts.pcm,
    frameAt: async (t) => opts.frameFn!(t),
    audio: async () => ({ sampleRate: opts.sampleRate ?? 16000, channels: [opts.pcm!] }),
    ...opts,
  };
}

const req = <P>(media: AIMediaSource, params: P, feature: AIRequest["feature"] = "silence-detection"): AIRequest<P> => ({ feature, clipId: "clip-x", sourceId: "src", media, params });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw (r as unknown as { error: Error }).error;
  return r as Extract<T, { ok: true }>;
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ---- confidence / errors / store -------------------------------------------------

describe("confidence, errors, result store", () => {
  it("confidence is clamped, typed by basis, banded", () => {
    expect(conf(1.7, "model-score")).toEqual({ value: 1, basis: "model-score" });
    expect(conf(NaN, "heuristic").value).toBe(0);
    expect(marginConfidence(5, 5, 1).value).toBeCloseTo(0.5);
    expect(marginConfidence(8, 5, 1).value).toBeGreaterThan(0.99);
    expect(confidenceBand(conf(0.8, "margin"))).toBe("high");
    expect(confidenceBand(conf(0.5, "margin"))).toBe("medium");
    expect(confidenceBand(conf(0.2, "margin"))).toBe("low");
  });

  it("errors normalize with codes and retryability", () => {
    expect(toAIError(new Error("boom"))).toMatchObject({ code: "inference-failed", retryable: true, message: "boom" });
    expect(toAIError(new DOMException("x", "AbortError")).code).toBe("cancelled");
    expect(new AIError("invalid-input", "bad").retryable).toBe(false);
  });

  it("items are editable with validation; results serialize and reload", () => {
    const store = new AIResultStore();
    const result: AIResult = { id: "r1", feature: "silence-detection", providerId: "p", providerKind: "signal-processing", target: { clipId: "c", sourceId: "s", sourceStart: 0, sourceEnd: 10 }, createdAt: 1, items: [{ kind: "silence", id: "i1", accepted: true, start: 2, end: 3, levelDb: -60, confidence: conf(0.9, "margin") }], warnings: [], metrics: { durationMs: 5 }, params: {} };
    store.add(result);
    const edited = store.updateItem("r1", "i1", { start: 1.5, end: 12, accepted: false });
    expect(edited).toMatchObject({ start: 1.5, end: 10, accepted: false, edited: true }); // clamped into the analysed span
    expect(() => store.updateItem("r1", "i1", { start: 5, end: 4 })).toThrow(/end after/);
    expect(() => store.updateItem("r1", "i1", { speaker: "Ana" })).toThrow(/no "speaker"/);
    const json = store.serialize();
    const other = new AIResultStore();
    expect(other.load(json)).toBe(1);
    expect(other.get("r1")!.items[0]).toEqual(store.get("r1")!.items[0]);
    expect(() => other.load('{"format":"nope"}')).toThrow();
    store.setAllAccepted("r1", true);
    expect(store.get("r1")!.items[0].accepted).toBe(true);
    expect(applyItemPatch({ kind: "speaker-turn", id: "t", accepted: true, start: 0, end: 1, speaker: "Speaker 1", confidence: conf(1, "margin") }, { speaker: "  Ana " }, 0, 5)).toMatchObject({ speaker: "Ana" });
  });
});

// ---- job system -----------------------------------------------------------------------

describe("AI job system", () => {
  const media = fakeMedia({ pcm: new Float32Array(16000) });
  const makeProvider = (impl: AIProvider["run"], id = "test.p"): AIProvider => ({ id, feature: "silence-detection", label: "Test", kind: "heuristic", description: "", needs: {}, availability: () => ({ available: true }), run: impl });

  it("queued -> processing -> completed, with progress and a stored result", async () => {
    const results: AIResult[] = [];
    const q = new AIJobQueue({}, (r) => results.push(r));
    const seen: string[] = [];
    q.subscribe((j) => seen.push(j.status));
    const id = q.submit(
      makeProvider(async (_r, c) => {
        c.progress(0.5, "half");
        return { items: [], warnings: ["w"] };
      }),
      req(media, {}),
    );
    expect(q.job(id)!.status).toBe("queued");
    const done = await q.wait(id);
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(1);
    expect(seen).toEqual(["queued", "processing", "processing", "completed"]);
    expect(results[0]).toMatchObject({ feature: "silence-detection", providerKind: "heuristic", warnings: ["w"], target: { clipId: "clip-x", sourceId: "src" } });
    expect(done.resultId).toBe(results[0].id);
  });

  it("failures become typed errors; a foreign error is wrapped, never a silent success", async () => {
    const results: AIResult[] = [];
    const q = new AIJobQueue({}, (r) => results.push(r));
    const a = await q.wait(q.submit(makeProvider(async () => { throw new AIError("model-load-failed", "no weights"); }), req(media, {})));
    expect(a).toMatchObject({ status: "failed", error: { code: "model-load-failed", retryable: true } });
    const b = await q.wait(q.submit(makeProvider(async () => { throw new TypeError("oops"); }), req(media, {})));
    expect(b.error).toMatchObject({ code: "inference-failed", message: "oops" });
    expect(results).toEqual([]);
  });

  it("cancel: queued jobs never start; running jobs abort; a provider ignoring the abort is still cancelled", async () => {
    const results: AIResult[] = [];
    const q = new AIJobQueue({}, (r) => results.push(r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = q.submit(makeProvider(async () => { await gate; return { items: [], warnings: [] }; }), req(media, {}));
    const queued = q.submit(makeProvider(async () => ({ items: [], warnings: [] })), req(media, {}));
    await Promise.resolve();
    await Promise.resolve();
    expect(q.job(slow)!.status).toBe("processing");
    expect(q.job(queued)!.status).toBe("queued"); // concurrency 1: FIFO
    q.cancel(queued);
    expect(q.job(queued)!.status).toBe("cancelled");
    q.cancel(slow);
    release();
    expect((await q.wait(slow)).status).toBe("cancelled");
    expect(results).toEqual([]);
    // A provider that honours the signal
    const honour = q.submit(makeProvider(async (_r, c) => new Promise((_, rej) => c.signal.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))), req(media, {}));
    await Promise.resolve();
    await Promise.resolve();
    q.cancel(honour);
    expect((await q.wait(honour)).status).toBe("cancelled");
  });

  it("retry re-queues a failed/cancelled job as a new attempt; timeouts fail with code timeout", async () => {
    let calls = 0;
    const q = new AIJobQueue({}, () => {}, { timeoutMs: 30 });
    const id = q.submit(makeProvider(async () => { calls++; if (calls === 1) throw new AIError("inference-failed", "flaky"); return { items: [], warnings: [] }; }), req(media, {}));
    expect((await q.wait(id)).status).toBe("failed");
    expect(q.retry(id)).toBe(true);
    const second = await q.wait(id);
    expect(second).toMatchObject({ status: "completed", attempt: 2 });
    expect(q.retry(id)).toBe(false); // completed jobs can't be retried
    const slow = q.submit(makeProvider(async (_r, c) => new Promise((_, rej) => c.signal.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))), req(media, {}));
    expect(await q.wait(slow)).toMatchObject({ status: "failed", error: { code: "timeout" } });
  });

  it("registry reports every feature honestly, including unavailable ones and why", async () => {
    const reg = createDefaultRegistry({ loadFace: async () => ({ detect: async () => [] }), loadObject: async () => ({ detect: async () => [] }), available: () => ({ available: false, reason: "no WebAssembly" }), faceModel: { name: "F", source: "f", license: "x" }, objectModel: { name: "O", source: "o", license: "x" } });
    const caps = await reg.capabilities({});
    expect(caps.length).toBe(12);
    const by = Object.fromEntries(caps.map((c) => [c.feature, c]));
    expect(by["face-detection"].availability).toEqual({ available: false, reason: expect.stringContaining("no WebAssembly") });
    expect(by["filler-detection"].availability.available).toBe(false); // no transcribe service
    expect(by["object-removal"].availability.available).toBe(false); // no image registration
    expect(by["silence-detection"].availability.available).toBe(true);
    expect(by["silence-detection"].provider!.kind).toBe("signal-processing");
    expect(by["highlight-detection"].provider!.kind).toBe("heuristic");
    expect(by["face-detection"].provider!.kind).toBe("ml-model");
    const caps2 = await reg.capabilities({ transcribe: async () => [], registerImage: (id) => id });
    expect(Object.fromEntries(caps2.map((c) => [c.feature, c.availability.available]))["filler-detection"]).toBe(true);
    expect(() => new AIRegistry().register(silenceProvider).register(silenceProvider)).toThrow(/already registered/);
  });
});

// ---- silence -----------------------------------------------------------------------------

describe("silence detection (signal processing)", () => {
  const sr = 16000;
  const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: sr * sec }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr));
  const hiss = (sec: number, amp = 0.001) => Float32Array.from({ length: sr * sec }, () => (rnd() * 2 - 1) * amp);
  const cat = (...xs: Float32Array[]) => {
    const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) out.set(x, (o += x.length) - x.length);
    return out;
  };

  it("finds the pauses with padding; ignores pauses shorter than the minimum", () => {
    const pcm = cat(tone(1), hiss(1), tone(1), hiss(0.3), tone(1), hiss(1.5));
    const { ranges, thresholdDb } = detectSilences(pcm, sr);
    expect(thresholdDb).toBeLessThanOrEqual(-30);
    expect(ranges.length).toBe(2);
    expect(ranges[0].start).toBeCloseTo(1.05, 2);
    expect(ranges[0].end).toBeCloseTo(1.95, 2);
    expect(ranges[1].start).toBeCloseTo(4.35, 2);
    expect(ranges[1].end).toBeCloseTo(5.75, 2);
  });

  it("adaptive threshold works on a noisy floor where a fixed -40 dB would fail", () => {
    const pcm = cat(tone(1, 0.5), hiss(1, 0.03), tone(1, 0.5)); // floor ≈ -35 dBFS
    expect(detectSilences(pcm, sr, { thresholdDb: -40 }).ranges.length).toBe(0);
    expect(detectSilences(pcm, sr).ranges.length).toBe(1);
  });

  it("provider maps to source time and rejects clips without audio", async () => {
    const pcm = cat(tone(1), hiss(1), tone(1));
    const out = await silenceProvider.run(req(fakeMedia({ pcm, sourceStart: 10, sourceEnd: 13 }), {}), ctx());
    expect(out.items[0]).toMatchObject({ kind: "silence", start: 11.05, end: 11.95, accepted: true });
    expect(out.items[0].confidence.basis).toBe("margin");
    await expect(silenceProvider.run(req(fakeMedia({}), {}), ctx())).rejects.toMatchObject({ code: "media-unavailable" });
  });
});

// ---- shots & scenes ----------------------------------------------------------------------

describe("shot & scene detection (classical CV)", () => {
  // 24 fps synthetic "video", 64x36:
  //  A  [0, 1.0)   warm gradient, slowly panning          (scene 1)
  //  A' [1.0, 2.0) same place, jump cut (shifted content)  (scene 1)
  //  B  [2.0, 3.0) cold checkerboard                       (scene 2)
  //  dissolve B->C over [3.0, 3.5)
  //  C  [3.5, 4.5) green bars                               (scene 3)
  //  Z  [4.5, 6.0) C slowly zooming in (must NOT be a dissolve)
  // Fixed per-pixel texture (like real footage) so colour histograms aren't a handful of spikes.
  const tex = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) % 25;
  // A: a "person" (bright block) in front of a warm wall; the jump cut moves the person across the frame.
  const A = (t: number, shift = 0) => frame(64, 36, (x, y) => {
    const px = 14 + shift + t * 2;
    return x > px && x < px + 14 && y > 6 ? [230 - tex(x, y), 190 - tex(x, y), 160] : [170 - y + tex(x, y), 110 + tex(x, y), 60];
  });
  const B = () => frame(64, 36, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [30 + tex(x, y), 60 + tex(x, y), 220 - tex(x, y)] : [10 + tex(x, y), 20, 90 + tex(x, y)]));
  const C = (zoom = 1) => frame(64, 36, (x, y) => {
    const zx = Math.floor((x - 32) / zoom + 32);
    const zy = Math.floor((y - 18) / zoom + 18);
    return (zx >> 2) % 2 ? [20 + tex(zx, zy), 200 - tex(zx, zy), 40] : [10, 90 + tex(zx, zy), 20 + tex(zx, zy)];
  });
  const mix = (a: AIFrame, b: AIFrame, w: number) => ({ ...a, data: a.data.map((v, i) => v * (1 - w) + b.data[i] * w) as Uint8ClampedArray });
  const video = (t: number) => {
    if (t < 1) return A(t);
    if (t < 2) return A(t, 26);
    if (t < 3) return B();
    if (t < 3.5) return mix(B(), C(), (t - 3) / 0.5);
    if (t < 4.5) return C();
    return C(1 + (t - 4.5) * 0.25);
  };
  const media = () => fakeMedia({ frameFn: video, sourceEnd: 6 });

  it("finds the jump cut, the hard cut (exact frames) and the dissolve; ignores the zoom", async () => {
    const a = await analyseShots(media(), { analysisFps: 24 }, ctx());
    const shots = a.shots;
    expect(shots.map((s) => s.transitionIn)).toEqual(["start", "cut", "cut", "dissolve"]);
    // Cuts land between frames 23/24 and 47/48 (t = 1.0 and 2.0).
    expect(shots[1].start).toBeCloseTo(1.0, 2);
    expect(shots[2].start).toBeCloseTo(2.0, 2);
    // Dissolve midpoint ~3.25 s.
    expect(Math.abs(shots[3].start - 3.25)).toBeLessThan(0.1);
    expect(shots[3].end).toBe(6);
    for (const s of shots) expect(s.confidence.value).toBeGreaterThan(0.5);
  });

  it("24 fps footage conformed to 30 fps (duplicated frames): the dissolve stays ONE dissolve (precise mode)", async () => {
    // Regression for a live-test finding: duplicates' zero distances chopped the dissolve into cut + fragments.
    const conformed = fakeMedia({ fps: 30, sourceEnd: 6, frameFn: (t) => video((Math.floor(t * 24) + 0.5) / 24) });
    const a = await analyseShots(conformed, { precision: "precise" }, ctx());
    expect(a.shots.map((s) => s.transitionIn)).toEqual(["start", "cut", "cut", "dissolve"]);
    expect(Math.abs(a.shots[3].start - 3.25)).toBeLessThan(0.1);
  });

  it("a burst of motion right before a hard cut doesn't turn the cut into a dissolve", async () => {
    // Regression for a live-test finding (real footage, 12 fps): raised motion samples just before the cut were
    // bridged into one run with the cut, and a free blend fit "explained" it with a mixing weight of ~0.
    const moveThenCut = fakeMedia({ sourceEnd: 4, frameFn: (t) => (t < 2 ? A(t, t > 1.6 ? (t - 1.6) * 30 : 0) : C()) });
    for (const analysisFps of [5, 12, 24]) {
      const a = await analyseShots(moveThenCut, { analysisFps }, ctx());
      expect(a.shots.map((s) => s.transitionIn)).toEqual(["start", "cut"]);
      expect(a.shots[1].start).toBeCloseTo(2.0, 1);
    }
  });

  it("at a coarse analysis rate, cuts are refined to the exact frame", async () => {
    const a = await analyseShots(media(), { analysisFps: 5 }, ctx());
    const cuts = a.shots.filter((s) => s.transitionIn === "cut").map((s) => s.start);
    expect(cuts.length).toBe(2);
    expect(cuts[0]).toBeCloseTo(1.0, 2);
    expect(cuts[1]).toBeCloseTo(2.0, 2);
  });

  it("a coarse analysis rate that doesn't divide the source rate still puts cuts on exact frame boundaries", async () => {
    // Regression for a live-test finding: 30 fps source, Fast (12 fps) analysis reported cuts at 1.983 s instead of
    // 2.000 s — sample times fell between frame centres. Frames here are quantized the way the browser adapter
    // decodes them (frame = round(t x fps - 0.5)).
    const quantized = (t: number) => video((Math.max(0, Math.round(t * 30 - 0.5)) + 0.5) / 30);
    const a = await analyseShots(fakeMedia({ fps: 30, sourceEnd: 6, frameFn: quantized }), { precision: "fast" }, ctx());
    const cuts = a.shots.filter((s) => s.transitionIn === "cut").map((s) => s.start);
    expect(cuts).toEqual([1, 2]);
  });

  it("scenes group the jump cut with its shot and split the different places", async () => {
    const a = await analyseShots(media(), { analysisFps: 24 }, ctx());
    const scenes = groupScenes(a.shots, a.signatures);
    expect(scenes.length).toBe(3);
    expect(scenes[0]).toMatchObject({ start: 0, shotIds: [a.shots[0].id, a.shots[1].id] });
    expect(scenes[1].start).toBeCloseTo(2.0, 2);
  });

  it("steady motion alone produces no boundaries", () => {
    const feats = Array.from({ length: 48 }, (_, i) => frameFeatures(A(i / 24)));
    expect(detectBoundaries(feats)).toEqual([]);
  });
});

// ---- tracking -----------------------------------------------------------------------------

describe("object tracking (NCC template matching)", () => {
  const W = 160;
  const H = 90;
  seed = 99;
  const bg = Float32Array.from({ length: W * H }, () => 60 + rnd() * 60);
  const pathAt = (k: number) => ({ x: 20 + k * 3, y: 30 + Math.round(10 * Math.sin(k / 4)) });
  const objFrame = (k: number, visible = true): Gray => {
    const d = Float32Array.from(bg);
    const { x, y } = pathAt(k);
    if (visible) for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) d[(y + j) * W + x + i] = (i >> 2) % 2 ^ (j >> 2) % 2 ? 250 : 5;
    return { width: W, height: H, data: d };
  };

  it("follows a moving object within a pixel", () => {
    const frames = Array.from({ length: 30 }, (_, k) => objFrame(k));
    const { keys } = trackTemplate(frames, { x: 20 / W, y: 30 / H, w: 16 / W, h: 16 / H });
    keys.forEach((k, i) => {
      expect(k.lost).toBe(false);
      expect(Math.abs(k.box.x * W - pathAt(i).x)).toBeLessThanOrEqual(1);
      expect(Math.abs(k.box.y * H - pathAt(i).y)).toBeLessThanOrEqual(1);
    });
  });

  it("reports LOST frames during an occlusion (holding position) and reacquires after", () => {
    const frames = Array.from({ length: 30 }, (_, k) => objFrame(k, k < 12 || k > 15));
    const { keys } = trackTemplate(frames, { x: 20 / W, y: 30 / H, w: 16 / W, h: 16 / H });
    expect(keys.slice(12, 16).every((k) => k.lost)).toBe(true);
    expect(keys[13].box).toEqual(keys[11].box);
    expect(keys.slice(17).every((k) => !k.lost)).toBe(true);
    expect(Math.abs(keys[29].box.x * W - pathAt(29).x)).toBeLessThanOrEqual(1);
  });

  it("a loose box whose target walks out of frame is reported LOST, not snapped back onto the empty start spot", () => {
    // Regression for a live-test finding (person walking out of a static office shot, tracked from a detector box):
    // the box is mostly background, so once the person left, the ORIGINAL template matched the now-empty spot where
    // they started (NCC ~0.7 > the fixed 0.5 threshold) and the track jumped back there.
    // A strongly structured background (like the office) and a low-contrast "person", so the background dominates
    // the template — the conditions under which the empty start spot still correlates.
    seed = 7;
    const office = Float32Array.from({ length: W * H }, (_, p) => (((p % W) * 7) >> 4) % 2 ^ ((((p / W) | 0) * 5) >> 4) % 2 ? 210 + rnd() * 20 : 40 + rnd() * 20);
    const frames = Array.from({ length: 45 }, (_, k) => {
      const d = Float32Array.from(office);
      const x0 = 30 + k * 4;
      for (let j = 0; j < 44; j++) for (let i = 0; i < 14; i++) if (x0 + i < W) d[(30 + j) * W + x0 + i] = 20 + ((i * j) % 7) * 3;
      return { width: W, height: H, data: d };
    });
    // Box ~3x the object's width and taller than it: mostly background, like a detector's person box.
    const { keys } = trackTemplate(frames, { x: 18 / W, y: 24 / H, w: 38 / W, h: 56 / H });
    // While visible it follows (box reaches the right edge)...
    expect(keys[24].lost).toBe(false);
    expect(keys[24].box.x * W).toBeGreaterThan(110);
    // ...and once the object has left (fully outside from k = 33) it is LOST, held at the edge — never back at the start.
    const exited = keys.slice(33);
    expect(exited.every((k) => k.lost)).toBe(true);
    expect(exited.every((k) => k.box.x * W > 110)).toBe(true);
  });
});

// ---- object removal --------------------------------------------------------------------------

describe("object removal (temporal clean plate + harmonic fill)", () => {
  const W = 80;
  const H = 48;
  seed = 7;
  const bgPx = Array.from({ length: W * H }, () => [80 + rnd() * 40, 100 + rnd() * 40, 60 + rnd() * 40] as [number, number, number]);
  const scene = (k: number, opts: { moving?: boolean; shift?: number } = {}) =>
    frame(W, H, (x, y) => {
      const sx = Math.min(W - 1, x + (opts.shift ? k * opts.shift : 0));
      const discX = opts.moving === false ? 40 : 10 + k * 6;
      if ((x - discX) ** 2 + (y - 24) ** 2 < 49) return [250, 20, 20];
      return bgPx[y * W + sx];
    });
  const region: Box = { x: 0, y: 12 / H, w: 1, h: 24 / H };

  it("a moving object is removed with the REAL background recovered", () => {
    const frames = Array.from({ length: 11 }, (_, k) => scene(k));
    const plate = buildCleanPlate(frames, region);
    let err = 0;
    let n = 0;
    for (let y = 14; y < 34; y++)
      for (let x = 2; x < 78; x++) {
        const o = (y * W + x) * 4;
        expect(plate.rgba[o + 3]).toBe(255);
        err += Math.abs(plate.rgba[o] - bgPx[y * W + x][0]);
        n++;
      }
    expect(err / n).toBeLessThan(2); // essentially exact
    expect(plate.method).toBe("temporal-plate");
    expect(plate.realBackgroundFraction).toBe(1);
    expect(plate.cameraMotion).toBeLessThan(1);
    // outside region + feather: transparent
    expect(plate.rgba[(2 * W + 40) * 4 + 3]).toBe(0);
  });

  it("a static object gets a smooth border fill (no real background exists) and says so", () => {
    const frames = Array.from({ length: 9 }, (_, k) => scene(k, { moving: false }));
    const plate = buildCleanPlate(frames, { x: 30 / W, y: 14 / H, w: 20 / W, h: 20 / H });
    expect(plate.method).toBe("temporal-plate+diffusion");
    expect(plate.realBackgroundFraction).toBe(0);
    const o = (24 * W + 40) * 4; // disc centre: no longer red
    expect(plate.rgba[o]).toBeLessThan(150);
    expect(plate.rgba[o + 1]).toBeGreaterThan(80);
  });

  it("a moving camera is measured and flagged", () => {
    const frames = Array.from({ length: 9 }, (_, k) => scene(k, { shift: 1 }));
    expect(buildCleanPlate(frames, { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }).cameraMotion).toBeGreaterThan(8);
  });

  it("the object leaving through the ring around the region is not mistaken for camera motion", () => {
    // Regression for a live-test finding: a person walking out of the region on a locked-off shot crossed the ring
    // used to measure camera motion, and the MEAN ring std flagged it ("motion 9.2", confidence halved).
    const frames = Array.from({ length: 11 }, (_, k) => scene(k));
    const plate = buildCleanPlate(frames, { x: 4 / W, y: 14 / H, w: 20 / W, h: 20 / H });
    expect(plate.realBackgroundFraction).toBe(1);
    expect(plate.cameraMotion).toBeLessThan(3);
  });
});

// ---- speakers ------------------------------------------------------------------------------------

describe("speaker detection (MFCC clustering baseline)", () => {
  const sr = 16000;
  // Two synthetic "voices": different pitch AND spectral envelope (formants), with syllable-like amplitude modulation.
  const voice = (sec: number, f0: number, formants: number[]) =>
    Float32Array.from({ length: Math.floor(sr * sec) }, (_, i) => {
      const t = i / sr;
      let s = 0;
      for (let h = 1; h * f0 < 4000; h++) {
        const f = h * f0;
        const env = formants.reduce((a, fm) => a + Math.exp(-(((f - fm) / 180) ** 2)), 0.02);
        s += env * Math.sin(2 * Math.PI * f * t + h);
      }
      return 0.08 * s * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
    });
  const A = (s: number) => voice(s, 110, [700, 1200, 2600]);
  const B = (s: number) => voice(s, 230, [400, 2300, 3100]);
  const cat = (...xs: Float32Array[]) => {
    const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of xs) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };

  it("separates two voices and places the turn changes within half a second", () => {
    const pcm = cat(A(4), B(4), A(3), B(3));
    const { turns, speakers } = diarize(pcm);
    expect(speakers).toBe(2);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1, 0, 1]);
    const changes = turns.slice(1).map((t) => t.start);
    [4, 8, 11].forEach((truth, i) => expect(Math.abs(changes[i] - truth)).toBeLessThan(0.5));
  });

  it("one voice -> one speaker; a known count is honoured", () => {
    expect(diarize(A(8)).speakers).toBe(1);
    expect(diarize(cat(A(4), B(4)), { speakers: 2 }).speakers).toBe(2);
  });
});

// ---- fillers / b-roll ------------------------------------------------------------------------------

describe("transcript features (fillers, B-roll)", () => {
  const W = (text: string, start: number) => ({ text, start, end: start + 0.3 });

  it("hesitations always count; discourse markers only as asides", () => {
    const words = [W("Um,", 0), W("so", 0.4), W("today", 0.8), W("we,", 1.2), W("uh,", 1.6), W("talk.", 2), W("Do", 3), W("you", 3.3), W("know", 3.6), W("her?", 3.9), W("It's,", 5), W("you", 5.3), W("know,", 5.6), W("like,", 6), W("great.", 6.3), W("I", 7), W("like", 7.3), W("it.", 7.6)];
    const f = findFillers(words);
    expect(f.map((x) => [x.text, x.category])).toEqual([
      ["Um,", "hesitation"],
      ["uh,", "hesitation"],
      ["you know,", "discourse"],
      ["like,", "discourse"],
    ]);
  });

  it("provider uses the shared transcript service; hesitations pre-accepted, discourse left to the user", async () => {
    clearTranscriptCache();
    let calls = 0;
    const services: AIServices = { transcribe: async () => (calls++, [W("Hello,", 0), W("um,", 0.5), W("you", 1), W("know,", 1.3), W("yes.", 1.6)]) };
    const media = fakeMedia({ pcm: new Float32Array(16000 * 3), sourceStart: 5, sourceEnd: 8 });
    const out = await fillerProvider.run(req(media, {}, "filler-detection"), ctx(services));
    expect(out.items.map((i) => (i as { text: string; accepted: boolean; start: number }).text)).toEqual(["um,", "you know,"]);
    expect(out.items[0]).toMatchObject({ accepted: true, start: 5.5 });
    expect(out.items[1]).toMatchObject({ accepted: false });
    await fillerProvider.run(req(media, {}, "filler-detection"), ctx(services));
    expect(calls).toBe(1); // cached transcript
    await expect(fillerProvider.run(req(fakeMedia({ pcm: new Float32Array(16000) }), {}, "filler-detection"), ctx({}))).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("B-roll keywords come from the content words of each phrase", () => {
    const words = "Last summer we hiked the Rocky Mountains near Denver. The coffee there was amazing, really strong coffee. Then we went home.".split(" ").map((t, i) => W(t, i * 0.4));
    const s = suggestBroll(words);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s[0].keywords).toEqual(expect.arrayContaining(["mountains"]));
    expect(s.find((x) => x.transcript.includes("coffee"))!.keywords[0]).toBe("coffee");
    for (const x of s) for (const k of x.keywords) expect(["the", "we", "was", "really", "there"]).not.toContain(k);
  });
});

// ---- highlights --------------------------------------------------------------------------------------

describe("highlight detection (heuristic)", () => {
  it("the loud, busy window wins and the reasons say why", () => {
    const windows = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 4, loudness: i === 6 ? -6 : -24, activity: 0.6, motion: i === 6 ? 0.3 : 0.05 }));
    const h = scoreHighlights(windows, 3);
    expect(h[0]).toMatchObject({ start: 6, score: 1 });
    expect(h[0].reasons.join(" ")).toMatch(/louder/);
    expect(h[0].reasons.join(" ")).toMatch(/visual action/);
    expect(h.length).toBe(1); // nothing else stands out above 0.5
  });

  it("provider over audio only (no picture) still works", async () => {
    const sr = 16000;
    const pcm = Float32Array.from({ length: sr * 20 }, (_, i) => (i > sr * 12 && i < sr * 15 ? 0.6 : 0.03) * Math.sin(i * 0.05));
    const out = await highlightProvider.run(req(fakeMedia({ pcm, sourceEnd: 20 }), { windowSec: 3 }, "highlight-detection"), ctx());
    const top = out.items[0] as unknown as { start: number; end: number };
    expect(top.start).toBeGreaterThanOrEqual(10.5);
    expect(top.end).toBeLessThanOrEqual(16.5);
    expect(out.items[0].confidence.basis).toBe("heuristic");
  });
});

// ---- detection / reframe ----------------------------------------------------------------------------------

describe("detection wiring + IoU tracks; reframe path", () => {
  const movingFace = { detect: async (f: AIFrame) => [{ box: { x: f.data[0] / 255, y: 0.3, w: 0.1, h: 0.2 }, label: "face", score: 0.9 }] };
  const mediaWithX = (xAt: (t: number) => number, end = 4) => fakeMedia({ sourceEnd: end, frameFn: (t) => ({ width: 2, height: 2, data: new Uint8ClampedArray([Math.round(xAt(t) * 255), 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]) }) });

  it("IoU linking groups one moving face into one track; two far apart faces into two", () => {
    const d = (t: number, x: number) => ({ time: t, box: { x, y: 0.3, w: 0.1, h: 0.2 }, label: "face", confidence: conf(0.9, "model-score") });
    expect(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0, w: 1, h: 1 })).toBeCloseTo(1 / 3);
    const tracks = linkDetections([[d(0, 0.1), d(0, 0.7)], [d(1, 0.12), d(1, 0.72)], [], [d(3, 0.15)]], [0, 1, 2, 3]);
    expect(tracks.length).toBe(2);
    expect(tracks[0].length).toBe(3); // gap of one sample bridged
  });

  it("provider samples, filters by score, links; a model that fails to load is model-load-failed", async () => {
    const p = createDetectionProvider({ id: "f", feature: "face-detection", label: "F", description: "", model: { name: "Fake", source: "-", license: "-" }, load: async () => movingFace, available: () => ({ available: true }), defaultSamplesPerSecond: 4 });
    const out = await p.run(req(mediaWithX((t) => 0.1 + t * 0.02), {}, "face-detection"), ctx());
    expect(out.items.length).toBe(1);
    expect(out.items[0]).toMatchObject({ kind: "detection-track", label: "face" });
    expect((out.items[0] as { detections: unknown[] }).detections.length).toBe(16);
    const broken = createDetectionProvider({ id: "b", feature: "face-detection", label: "B", description: "", model: { name: "Fake", source: "-", license: "-" }, load: async () => { throw new Error("404"); }, available: () => ({ available: true }), defaultSamplesPerSecond: 4 });
    await expect(broken.run(req(mediaWithX(() => 0.1), {}, "face-detection"), ctx())).rejects.toMatchObject({ code: "model-load-failed" });
  });

  it("reframe: crop size, dead zone (no jitter), speed limit, clamped inside the frame", () => {
    expect(cropSize(16 / 9, 9 / 16)).toEqual({ cropW: (9 / 16) / (16 / 9), cropH: 1 });
    const crop = cropSize(16 / 9, 9 / 16);
    const jitter = Array.from({ length: 20 }, (_, i) => ({ time: i * 0.25, subject: { cx: 0.5 + (i % 2 ? 0.01 : -0.01), cy: 0.5 } }));
    const steady = computeReframePath(jitter, crop);
    expect(new Set(steady.map((k) => k.cx)).size).toBe(1); // jitter under the dead zone never moves the camera
    const jump = computeReframePath([{ time: 0, subject: { cx: 0.2, cy: 0.5 } }, { time: 0.25, subject: { cx: 0.95, cy: 0.5 } }, { time: 0.5, subject: { cx: 0.95, cy: 0.5 } }], crop);
    expect(jump[0].cx).toBeCloseTo(Math.max(crop.cropW / 2, 0.2), 3);
    expect(jump[1].cx - jump[0].cx).toBeLessThanOrEqual(0.35 * crop.cropW * 0.25 + 1e-4); // speed-limited (keys stored to 4 decimals)
    for (const k of jump) expect(k.cx).toBeLessThanOrEqual(1 - crop.cropW / 2 + 1e-9);
  });

  it("reframe provider follows the face; with no face/person it stays centred and says so", async () => {
    const p = createReframeProvider(async () => movingFace, async () => ({ detect: async () => [] }), () => ({ available: true }));
    const out = await p.run(req(mediaWithX((t) => 0.1 + t * 0.15, 4), { aspect: 9 / 16 }, "auto-reframe"), ctx());
    const item = out.items[0] as unknown as { subject: string; keys: { cx: number }[] };
    expect(item.subject).toBe("face");
    expect(item.keys[item.keys.length - 1].cx).toBeGreaterThan(item.keys[0].cx);
    const none = createReframeProvider(async () => ({ detect: async () => [] }), async () => ({ detect: async () => [] }), () => ({ available: true }));
    const o2 = await none.run(req(mediaWithX(() => 0), {}, "auto-reframe"), ctx());
    expect((o2.items[0] as unknown as { subject: string }).subject).toBe("center");
    expect(o2.warnings[0]).toMatch(/No face or person/);
  });
});

// ---- apply (non-destructive editor edits) ---------------------------------------------------------------

describe("apply actions: results -> editable editor objects, one undo step, media untouched", () => {
  function project() {
    const e = new TimelineEngine(24, { width: 1920, height: 1080, background: "#000000" });
    const t = ok(e.addTrack("video", "V")).track.id;
    // Source frames 24..264 (1 s .. 11 s) placed at timeline frame 48.
    const id = ok(e.insertClip(t, { kind: "video", source: { sourceId: "src" }, sourceInFrame: 24, sourceOutFrame: 264 }, 48)).clip.id;
    e.resetHistory();
    return { e, id };
  }
  const result = (clipId: string, feature: AIResult["feature"], items: AIResult["items"]): AIResult => ({ id: `r-${feature}`, feature, providerId: "p", providerKind: "classical-cv", target: { clipId, sourceId: "src", sourceStart: 1, sourceEnd: 11 }, createdAt: 0, items, warnings: [], metrics: { durationMs: 0 }, params: {} });
  const shot = (start: number, end: number, accepted = true): ShotItem => ({ kind: "shot", id: `s${start}`, accepted, start, end, transitionIn: "cut", confidence: conf(1, "margin") });

  it("source seconds map through the clip's in point and position", () => {
    const { e, id } = project();
    const c = e.timeline.clips[id];
    expect(sourceToTimeline(e.timeline, c, 1)).toBe(48);
    expect(sourceToTimeline(e.timeline, c, 3)).toBe(96);
    expect(sourceToTimeline(e.timeline, c, 0.5)).toBeNull(); // before the in point
  });

  it("split at shots: accepted boundaries only, one undo step, source refs untouched", () => {
    const { e, id } = project();
    const r = result(id, "shot-detection", [shot(1, 3), shot(3, 6), shot(6, 8, false), shot(8, 11)]);
    let cuts = 0;
    ok(e.transact((tl) => ((r2) => ((cuts = r2.cuts), r2.timeline))(splitAtBoundaries(tl, r))));
    expect(cuts).toBe(2); // 3 s and 8 s (6 s rejected; 1 s is the clip start)
    const clips = Object.values(e.timeline.clips).sort((a, b) => a.timelineStart - b.timelineStart);
    expect(clips.map((c) => c.timelineStart)).toEqual([48, 96, 216]);
    expect(clips.every((c) => (c.content as { source: { sourceId: string } }).source.sourceId === "src")).toBe(true);
    e.undo();
    expect(Object.keys(e.timeline.clips)).toEqual([id]);
  });

  it("scene results split at scene starts, not every shot", () => {
    const { e, id } = project();
    const scene: SceneItem = { kind: "scene", id: "sc2", accepted: true, start: 6, end: 11, shotIds: [], confidence: conf(1, "margin") };
    const r = result(id, "scene-detection", [{ ...scene, id: "sc1", start: 1, end: 6 }, scene, shot(3, 6)]);
    expect(splitAtBoundaries(e.timeline, r).cuts).toBe(1);
  });

  it("cut silences: with and without closing gaps", () => {
    const { e, id } = project();
    const sil = (start: number, end: number) => ({ kind: "silence" as const, id: `x${start}`, accepted: true, start, end, levelDb: -60, confidence: conf(1, "margin") });
    const r = result(id, "silence-detection", [sil(3, 4), sil(7, 7.5)]);
    const gaps = removeRanges(e.timeline, r, { closeGaps: false });
    expect(gaps.removedFrames).toBe(24 + 12);
    const g = Object.values(gaps.timeline.clips).sort((a, b) => a.timelineStart - b.timelineStart);
    expect(g.map((c) => [c.timelineStart, clipTimelineEnd(c)])).toEqual([[48, 96], [120, 192], [204, 288]]);
    const closed = removeRanges(e.timeline, r, { closeGaps: true });
    const c2 = Object.values(closed.timeline.clips).sort((a, b) => a.timelineStart - b.timelineStart);
    expect(c2.map((c) => [c.timelineStart, clipTimelineEnd(c)])).toEqual([[48, 96], [96, 168], [168, 252]]);
    expect(clipTimelineEnd(c2[2]) - 48).toBe(240 - 36);
  });

  it("speaker turns label overlapping captions (Phase 12)", () => {
    const { e, id } = project();
    const cap = ok(e.importCaptionCues([{ start: 2.2, end: 3, text: "Hi" }, { start: 6, end: 7, text: "Hello" }], { name: "C" }));
    const turn = (start: number, end: number, speaker: string) => ({ kind: "speaker-turn" as const, id: speaker, accepted: true, start, end, speaker, confidence: conf(1, "margin") });
    // Timeline 2.2 s = frame 52.8 -> source 1 + (52.8-48)/24 ≈ 1.2 s
    const r = result(id, "speaker-detection", [turn(1, 3, "Ana"), turn(3, 8, "Ben")]);
    const out = labelCaptionSpeakers(e.timeline, r);
    expect(out.labelled).toBe(2);
    const speakers = cap.clips.map((c) => (out.timeline.clips[c.id].content as { speaker?: string }).speaker);
    expect(speakers).toEqual(["Ana", "Ben"]);
  });

  it("a detected face becomes a keyframed ellipse mask, or a blurred masked copy with muted audio", () => {
    const { e, id } = project();
    const det = (t: number, x: number) => ({ time: t, box: { x, y: 0.2, w: 0.1, h: 0.2 }, label: "face", confidence: conf(0.9, "model-score") });
    const r = result(id, "face-detection", [{ kind: "detection-track", id: "f1", accepted: true, label: "face", detections: [det(2, 0.1), det(3, 0.3), det(4, 0.5)], start: 2, end: 4, confidence: conf(0.9, "model-score") }]);
    const m = maskFromTrack(e.timeline, r, "f1", { mode: "mask" });
    const clip = m.timeline.clips[id];
    expect(clip.masks!.length).toBe(1);
    expect(Object.keys(clip.animation!.tracks).filter((p) => p.startsWith("masks.")).length).toBe(4);
    const blur = maskFromTrack(e.timeline, r, "f1", { mode: "blur" });
    const copy = blur.timeline.clips[blur.clipId];
    expect(copy.id).not.toBe(id);
    expect(copy.effects![0].type).toBe("blur");
    expect(copy.audio?.muted).toBe(true);
    expect(blur.timeline.clips[id].masks).toBeUndefined(); // original untouched
  });

  it("reframe keys position with a cover scale; B-roll placeholders; clean-plate overlay layer", () => {
    const { e, id } = project();
    const reframe = result(id, "auto-reframe", [{ kind: "reframe", id: "rf", accepted: true, aspect: 9 / 16, cropW: 0.3164, cropH: 1, subject: "face", keys: [{ time: 1, cx: 0.3, cy: 0.5 }, { time: 5, cx: 0.6, cy: 0.5 }, { time: 10, cx: 0.6, cy: 0.5 }], confidence: conf(1, "agreement") }]);
    const tl9x16 = { ...e.timeline, composition: { ...e.timeline.composition, width: 1080, height: 1920 } };
    const rf = applyReframe(tl9x16, reframe, { width: 1920, height: 1080 });
    const v = rf.timeline.clips[id].visual!;
    expect(v.fit).toBe("none");
    expect(v.transform.scaleX).toBeCloseTo(1920 / 1080, 3); // crop height fills the 1920 px frame
    expect(rf.timeline.clips[id].animation!.tracks["visual.transform.x"].keyframes.length).toBeGreaterThanOrEqual(2);
    // Regression for a live-test finding: a 9:16 path applied to a 16:9 composition silently zoomed the clip 4.7x
    // onto a sliver of the picture. It must refuse and say what to do instead.
    expect(() => applyReframe(e.timeline, reframe, { width: 1920, height: 1080 })).toThrow(/9:16.*16:9/);
    const broll = result(id, "broll-suggestions", [{ kind: "broll", id: "b1", accepted: true, start: 2, end: 4, keywords: ["coffee"], query: "coffee", transcript: "", confidence: conf(1, "heuristic") }]);
    const b = addBrollPlaceholders(e.timeline, broll);
    expect(b.added).toBe(1);
    const ph = Object.values(b.timeline.clips).find((c) => c.content.kind === "text")!;
    expect((ph.content as { text: string }).text).toBe("B-roll: coffee");
    expect(ph.timelineStart).toBe(72);
    const rm = result(id, "object-removal", [{ kind: "object-removal", id: "o1", accepted: true, region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, method: "temporal-plate", plateSourceId: "aiplate:1", realBackgroundFraction: 1, cameraMotion: 0, confidence: conf(1, "agreement") }]);
    const o = addObjectRemovalLayer(e.timeline, rm, "o1", { width: 960, height: 540 }, { width: 1920, height: 1080 });
    const layer = o.timeline.clips[o.clipId];
    expect(layer).toMatchObject({ timelineStart: 48, content: { kind: "image", source: { sourceId: "aiplate:1" }, durationFrames: 240 } });
    expect(o.timeline.trackIds.indexOf(layer.trackId)).toBeLessThan(o.timeline.trackIds.indexOf(e.timeline.clips[id].trackId)); // above
    expect(e.timeline.clips[id]).toEqual(o.timeline.clips[id]); // original clip unchanged
  });

  it("simplifyKeys keeps corners and drops collinear keys", () => {
    const keys = [0, 1, 2, 3, 4, 5, 6].map((f) => ({ frame: f, value: f < 3 ? f * 10 : 30 }));
    expect(simplifyKeys(keys, 0.5).map((k) => k.frame)).toEqual([0, 3, 6]);
  });
});

export type _UnusedForDocs = AIJob;
