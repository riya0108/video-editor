import { describe, expect, it } from "vitest";
import { createTimeline, type TimelineModel } from "../timeline/model";
import { addTrack, insertClip } from "../timeline/operations";
import { normalizeShapeSpec } from "../timeline/shape-style";
import { buildRenderPlan } from "../render/plan";
import { checkRenderSettings, placementFor, type RenderSettings } from "../render/settings";
import { alphaCheck, alphaPsnr, audioFrameSec, fidelityCheck, technicalChecks, type ProbedOutput } from "../render/validate";
import { codecDelaySec } from "../render/job";
import type { RenderOutcome, RenderProgress } from "../render/job";
import type { RenderCheck, RenderReport } from "../render/validate";
import { checkExportProfile, normalizeProfile, qualityBitrate, resolvedVideoBitrate, toRenderSettings, type ExportProfile } from "./profile";
import { deliveryFps, EXPORT_PRESETS, presetProfile } from "./presets";
import { exportFileName, ExportQueue, InvalidJobTransition, JOB_TRANSITIONS, jobFraction, type ExportJob, type ExportRunner } from "./queue";

/**
 * PHASE 16 — EXPORT SYSTEM, pure parts: presets, profile checks, framing, the job state machine, and the extra
 * read-back checks (container, codecs, bitrate, alpha). Real files are rendered and checked in the browser and by
 * ffmpeg (EXPORT_TEST_REPORT.md, export-real.eval.test.ts).
 */

function project(fps = 30, comp = { width: 1920, height: 1080 }, seconds = 4): TimelineModel {
  let tl = createTimeline(fps, { ...comp, background: "#000000" });
  const r = addTrack(tl, "graphic", "shapes");
  tl = r.timeline;
  const shape = normalizeShapeSpec({ type: "rect", width: 400, height: 300, fill: "#ff0000", strokeWidth: 0, cornerRadius: 0 });
  return insertClip(tl, r.track.id, { kind: "graphic", shape, durationFrames: Math.round(fps * seconds) }, 0).timeline;
}

describe("presets", () => {
  it("the five presets of the spec, each producing a valid profile for a matching composition", () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual(["instagram-reel", "youtube", "youtube-shorts", "square", "custom"]);
    const shapes: Record<string, { width: number; height: number }> = { "instagram-reel": { width: 1080, height: 1920 }, youtube: { width: 1920, height: 1080 }, "youtube-shorts": { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 }, custom: { width: 1280, height: 720 } };
    for (const p of EXPORT_PRESETS) {
      const tl = project(30, shapes[p.id]);
      const prof = presetProfile(p.id, tl);
      const c = checkExportProfile(tl, prof, p.guidance);
      expect(c.errors, p.id).toEqual([]);
      expect([prof.width, prof.height], p.id).toEqual([shapes[p.id].width, shapes[p.id].height]);
      expect(buildRenderPlan(tl, c.settings).placement, p.id).toEqual({ scale: 1, x: 0, y: 0, width: prof.width, height: prof.height });
    }
  });

  it("platform values: YouTube 8 / 12 Mbit/s by rate with AAC 320k (384k fails to encode on macOS Chrome); Reel and Square at the high quality level", () => {
    const yt30 = presetProfile("youtube", project(30));
    expect([yt30.rateControl, yt30.videoBitrate, yt30.audioCodec, yt30.audioBitrate, yt30.container, yt30.videoCodec]).toEqual(["bitrate", 8e6, "aac", 320_000, "mp4", "avc"]);
    expect(presetProfile("youtube", project(60)).videoBitrate).toBe(12e6);
    expect(presetProfile("youtube-shorts", project(50, { width: 1080, height: 1920 })).videoBitrate).toBe(12e6);
    const reel = presetProfile("instagram-reel", project(30, { width: 1080, height: 1920 }));
    expect([reel.rateControl, reel.quality, reel.audioBitrate]).toEqual(["quality", "high", 128_000]);
    expect(resolvedVideoBitrate(reel)).toBe(Math.round(1080 * 1920 * 30 * 0.15));
  });

  it("frame rate follows the project when it's a delivery rate, else 30", () => {
    expect(deliveryFps(project(25))).toBe(25);
    expect(deliveryFps(project(60))).toBe(60);
    expect(deliveryFps(createTimeline(29.97, { width: 1920, height: 1080 }))).toBe(30);
    expect(presetProfile("square", project(24, { width: 1080, height: 1080 })).fps).toBe(24);
  });

  it("custom starts at the composition's size with framing 'match'", () => {
    const c = presetProfile("custom", project(30, { width: 1000, height: 700 }));
    expect([c.width, c.height, c.framing]).toEqual([1000, 700, "match"]);
  });

  it("platform guidance: too long for Reels/Shorts and needless bitrate are warnings, never errors", () => {
    const long = project(30, { width: 1080, height: 1920 }, 200);
    const shorts = EXPORT_PRESETS.find((p) => p.id === "youtube-shorts")!;
    const c = checkExportProfile(long, { ...presetProfile("youtube-shorts", long), videoBitrate: 80e6 }, shorts.guidance);
    expect(c.ok).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/up to 3 min; this timeline is 3 min 20 s/);
    expect(c.warnings.join(" ")).toMatch(/above ~50 Mbit\/s/);
  });
});

describe("profile → render settings", () => {
  const tl = project();
  const yt = presetProfile("youtube", tl);

  it("quality level derives the bitrate from pixels × fps × level × codec efficiency, clamped", () => {
    expect(qualityBitrate({ width: 1920, height: 1080, fps: 30, quality: "high", videoCodec: "avc" })).toBe(9_331_200);
    expect(qualityBitrate({ width: 1920, height: 1080, fps: 30, quality: "high", videoCodec: "av1" })).toBe(Math.round(9_331_200 * 0.55));
    expect(qualityBitrate({ width: 1920, height: 1080, fps: 30, quality: "draft", videoCodec: "avc" })).toBe(3_110_400);
    expect(qualityBitrate({ width: 64, height: 64, fps: 1, quality: "draft", videoCodec: "avc" })).toBe(1e6);
    expect(qualityBitrate({ width: 4096, height: 2304, fps: 120, quality: "max", videoCodec: "vp8" })).toBe(120e6);
  });

  it("every field reaches the render settings exactly", () => {
    const p: ExportProfile = { ...yt, container: "webm", videoCodec: "vp9", audioCodec: "opus", audioBitrate: 160_000, bitrateMode: "constant", alpha: true, fps: 50, videoBitrate: 6e6 };
    expect(toRenderSettings(p)).toEqual({ width: 1920, height: 1080, fps: 50, framing: "fit", container: "webm", videoCodec: "vp9", videoBitrate: 6e6, bitrateMode: "constant", alpha: true, audio: { sampleRate: 48000, channels: 2, codec: "opus", bitrate: 160_000 } });
    expect(toRenderSettings({ ...p, audioCodec: "none" }).audio).toBeNull();
  });

  it("container ↔ codec compatibility: impossible pairs are refused with the reason; normalize repairs them", () => {
    const errs = (p: Partial<ExportProfile>) => checkExportProfile(tl, { ...yt, ...p }).errors.join(" ");
    expect(errs({ container: "webm", videoCodec: "avc", audioCodec: "opus" })).toMatch(/H\.264 can't go in WEBM/);
    expect(errs({ container: "webm", videoCodec: "vp9", audioCodec: "aac" })).toMatch(/AAC audio can't go in WEBM/);
    expect(errs({ container: "mov", videoCodec: "vp9" })).toMatch(/VP9 can't go in MOV/);
    expect(errs({ container: "mp4", alpha: true })).toMatch(/Transparency needs WebM with VP9 or VP8/);
    expect(errs({ container: "webm", videoCodec: "av1", audioCodec: "opus", alpha: true })).toMatch(/Transparency needs WebM/);
    expect(errs({ container: "webm", videoCodec: "vp9", audioCodec: "opus", alpha: true })).toBe("");
    expect(errs({ container: "mov", videoCodec: "hevc" })).toBe("");
    expect(normalizeProfile({ ...yt, container: "webm" })).toMatchObject({ container: "webm", videoCodec: "vp9", audioCodec: "opus", alpha: false });
    expect(normalizeProfile({ ...yt, container: "mov", videoCodec: "hevc", alpha: true })).toMatchObject({ videoCodec: "hevc", audioCodec: "aac", alpha: false });
    expect(normalizeProfile({ ...yt, audioCodec: "none", container: "webm" }).audioCodec).toBe("none");
  });

  it("bitrates out of range are refused", () => {
    expect(checkExportProfile(tl, { ...yt, videoBitrate: 0.2e6 }).errors.join(" ")).toMatch(/Video bitrate must be between 1 and 120/);
    expect(checkExportProfile(tl, { ...yt, audioBitrate: 8000 }).errors.join(" ")).toMatch(/Audio bitrate/);
  });

  it("an uneven rate ratio is warned about (judder), a multiple isn't", () => {
    expect(checkExportProfile(tl, { ...yt, fps: 25 }).warnings.join(" ")).toMatch(/uneven frame cadence/);
    expect(checkExportProfile(tl, { ...yt, fps: 60 }).warnings.join(" ")).not.toMatch(/cadence/);
  });
});

describe("framing (output shape ≠ composition shape)", () => {
  it("match refuses; fit letterboxes with nothing cropped; fill covers and crops symmetrically", () => {
    const tl = project(30, { width: 1920, height: 1080 });
    const s = (framing: RenderSettings["framing"]): RenderSettings => ({ width: 1080, height: 1920, fps: 30, framing });
    expect(checkRenderSettings(tl, s("match")).ok).toBe(false);
    const fit = checkRenderSettings(tl, s("fit"));
    expect(fit.ok).toBe(true);
    expect(fit.placement).toEqual({ scale: 0.5625, x: 0, y: 656, width: 1080, height: 608 });
    const fill = checkRenderSettings(tl, s("fill"));
    expect(fill.placement).toEqual({ scale: 1920 / 1080, x: -1166, y: 0, width: 3413, height: 1920 });
    // Same shape: framing changes nothing.
    expect(placementFor(1920, 1080, 3840, 2160, "fill")).toEqual({ scale: 2, x: 0, y: 0, width: 3840, height: 2160 });
  });

  it("a framed preset still checks out and says what will happen", () => {
    const tl = project(30, { width: 1920, height: 1080 });
    const c = checkExportProfile(tl, presetProfile("instagram-reel", tl));
    expect(c.ok).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/letterboxed inside 1080×1920/);
  });
});

describe("read-back checks: container, codecs, bitrate, alpha", () => {
  const tl = project(25);
  const plan = (s: Partial<RenderSettings> = {}) => buildRenderPlan(tl, { width: 1920, height: 1080, fps: 25, videoBitrate: 8e6, audio: null, ...s });
  const good = (): ProbedOutput => ({
    mimeType: "video/mp4",
    container: "MP4",
    containerMime: "video/mp4",
    video: { codec: "avc", width: 1920, height: 1080, frameCount: 100, timestamps: Array.from({ length: 100 }, (_, i) => i / 25), durationSec: 4, bytes: 3_000_000, canBeTransparent: false },
    audio: null,
  });
  const failing = (p: ProbedOutput, s?: Partial<RenderSettings>, enc = { video: "avc", audio: null }) => technicalChecks(plan(s), p, enc).filter((c) => !c.ok).map((c) => c.id);

  it("a correct file passes, and every new check is present", () => {
    const checks = technicalChecks(plan(), good(), { video: "avc", audio: null });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(["container", "video-track", "video-codec", "resolution", "frame-count", "fps", "duration", "bitrate", "alpha", "audio-track"]);
  });

  it("each defect fails its own check", () => {
    const g = good();
    expect(failing({ ...g, container: "QuickTime File Format", containerMime: "video/quicktime" })).toEqual(["container"]);
    expect(failing(g, { container: "webm", videoCodec: "vp9" }, { video: "vp9", audio: null })).toEqual(["container", "video-codec"]);
    expect(failing({ ...g, video: { ...g.video!, codec: "hevc" } })).toEqual(["video-codec"]);
    expect(failing({ ...g, video: { ...g.video!, bytes: 8e6 * 4 * 1.6 / 8 } })).toEqual(["bitrate"]);
    expect(failing({ ...g, video: { ...g.video!, bytes: 0 } })).toEqual(["bitrate"]);
    expect(failing({ ...g, video: { ...g.video!, canBeTransparent: true } })).toEqual(["alpha"]);
  });

  it("audio codec mismatch fails audio-codec only", () => {
    const tlA = project(25);
    const p = buildRenderPlan(tlA, { width: 1920, height: 1080, fps: 25, videoBitrate: 8e6 });
    // project() has no audible clip -> plan.audio is null; fake one to exercise the audio branch.
    const withAudio = { ...p, settings: { ...p.settings, audio: { sampleRate: 48000 as const, channels: 2 as const, codec: "aac" as const, bitrate: 192_000 } } };
    const g = { ...good(), audio: { codec: "opus", sampleRate: 48000, channels: 2, durationSec: 4, bytes: 96_000 } };
    expect(technicalChecks(withAudio, g, { video: "avc", audio: "aac" }).filter((c) => !c.ok).map((c) => c.id)).toEqual(["audio-codec"]);
    expect(technicalChecks(withAudio, { ...g, audio: { ...g.audio, codec: "aac" } }, { video: "avc", audio: "aac" }).find((c) => c.id === "audio-codec")!.detail).toMatch(/192 kbit\/s measured/);
  });

  it("alpha: the track must be transparent and the decoded alpha must match the render", () => {
    const g = good();
    const transparent = { ...g, video: { ...g.video!, canBeTransparent: true } };
    expect(alphaCheck(transparent, [{ frame: 0, psnr: Infinity }, { frame: 10, psnr: 41 }])).toMatchObject({ ok: true });
    expect(alphaCheck(g, [{ frame: 0, psnr: Infinity }])).toMatchObject({ ok: false, detail: expect.stringMatching(/alpha channel was lost/) });
    expect(alphaCheck(transparent, [{ frame: 3, psnr: 12 }])).toMatchObject({ ok: false, detail: expect.stringMatching(/frame 3/) });
    expect(alphaCheck(transparent, []).ok).toBe(false);
    // Decoding broke off after 2 of 14 checkpoints: fidelity fails even though the compared frames were fine.
    expect(fidelityCheck([{ frame: 0, psnr: 45 }, { frame: 5, psnr: 44 }], undefined, 14)).toMatchObject({ ok: false, detail: expect.stringMatching(/^2 of 14 checkpoint frames/) });
    expect(fidelityCheck([{ frame: 0, psnr: 45 }], undefined, 1).ok).toBe(true);
    const a = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    expect(alphaPsnr(a, a)).toBe(Infinity);
    expect(alphaPsnr(a, new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]))).toBeCloseTo(10 * Math.log10(2), 6);
  });
});

// ---------------------------------------------------------------- job system

const check = (ok: boolean, id = "fidelity"): RenderCheck => ({ id, label: id, ok, detail: ok ? "fine" : "bad" });
const outcome = (ok: boolean): RenderOutcome => ({ blob: new Blob(["x"]), plan: {} as RenderOutcome["plan"], report: { ok, checks: [check(true, "frame-count"), check(ok)], warnings: [], codec: "avc", bytes: 1, renderMs: 1, frameCount: 1, durationSec: 1 } as RenderReport, stageMs: { setup: 0, frames: 0, checks: 0, encode: 0, audio: 0, finalize: 0, validate: 0 }, release: async () => {} });

/** A runner whose renders are finished by hand. */
function manualRunner() {
  const calls: { tl: TimelineModel; settings: RenderSettings; signal: AbortSignal; onProgress: (p: RenderProgress) => void; resolve: (o: RenderOutcome) => void; reject: (e: unknown) => void }[] = [];
  const runner: ExportRunner = (tl, settings, { signal, onProgress }) =>
    new Promise((resolve, reject) => {
      const c = { tl, settings, signal, onProgress, resolve, reject };
      calls.push(c);
      signal.addEventListener("abort", () => reject(new DOMException("Render cancelled.", "AbortError")));
    });
  return { runner, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const S: RenderSettings = { width: 1920, height: 1080, fps: 30, container: "mp4" };

describe("export job system", () => {
  it("state machine: only queued→processing→completed|failed|cancelled and queued→cancelled", () => {
    expect(JOB_TRANSITIONS).toEqual({ queued: ["processing", "cancelled"], processing: ["completed", "failed", "cancelled"], completed: [], failed: [], cancelled: [] });
  });

  it("queued → processing → completed only when every validation check passed; jobs run one at a time, in order", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const a = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    const b = q.enqueue({ name: "B", presetId: "square", settings: S, fileName: "b.mp4", timeline: project() });
    await tick();
    expect([q.get(a)!.status, q.get(b)!.status]).toEqual(["processing", "queued"]);
    expect(calls).toHaveLength(1);
    calls[0].resolve(outcome(true));
    await tick();
    expect(q.get(a)!.status).toBe("completed");
    expect(q.get(a)!.history).toEqual(["queued", "processing", "completed"]);
    expect(q.get(a)!.outcome).toBeDefined();
    expect(q.get(b)!.status).toBe("processing");
    calls[1].resolve(outcome(true));
    await q.idle();
    expect(q.get(b)!.status).toBe("completed");
  });

  it("the encoder returning a file is NOT success: a failed check makes the job failed, naming the check; the file is kept", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    calls[0].resolve(outcome(false));
    await q.idle();
    const j = q.get(id)!;
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/^Validation failed: fidelity — bad$/);
    expect(j.outcome?.blob.size).toBe(1);
  });

  it("an error during rendering → failed with the message (a RenderPlanError's reasons joined)", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    calls[0].reject(Object.assign(new Error("x"), { errors: ["Can't encode HEVC here.", "Pick another codec."] }));
    await q.idle();
    expect(q.get(id)).toMatchObject({ status: "failed", error: "Can't encode HEVC here. Pick another codec.", history: ["queued", "processing", "failed"] });
    expect(q.get(id)!.outcome).toBeUndefined();
  });

  it("cancel: a queued job never starts; a processing one is aborted; a finished one is untouched", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const a = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    const b = q.enqueue({ name: "B", presetId: "youtube", settings: S, fileName: "b.mp4", timeline: project() });
    const c = q.enqueue({ name: "C", presetId: "youtube", settings: S, fileName: "c.mp4", timeline: project() });
    await tick();
    q.cancel(b);
    expect(q.get(b)!.history).toEqual(["queued", "cancelled"]);
    q.cancel(a);
    expect(calls[0].signal.aborted).toBe(true);
    await tick();
    expect(q.get(a)!.history).toEqual(["queued", "processing", "cancelled"]);
    // B was skipped; C runs next.
    expect(calls).toHaveLength(2);
    expect(q.get(c)!.status).toBe("processing");
    calls[1].resolve(outcome(true));
    await q.idle();
    q.cancel(c);
    expect(q.get(c)!.status).toBe("completed");
  });

  it("a render that finishes after cancel was pressed is still cancelled (the user asked for no file)", async () => {
    const q = new ExportQueue(async () => {
      await new Promise((r) => setTimeout(r, 30)); // ignores the signal, like an encoder flush that can't be interrupted
      return outcome(true);
    });
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    q.cancel(id);
    await q.idle();
    expect(q.get(id)!.status).toBe("cancelled");
  });

  it("each job renders a snapshot of the timeline taken at enqueue time", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const tl = project();
    q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: tl });
    const clipId = Object.keys(tl.clips)[0];
    (tl.clips[clipId] as { timelineStart: number }).timelineStart = 999; // the editor mutating/replacing its model
    (tl.composition as { width: number }).width = 1;
    await tick();
    expect(calls[0].tl.clips[clipId].timelineStart).toBe(0);
    expect(calls[0].tl.composition.width).toBe(1920);
    expect(calls[0].tl).not.toBe(tl);
  });

  it("progress: phases map onto one 0..1 bar; ETA appears once frames are flowing; snapshots are immutable", async () => {
    let t = 0;
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner, () => t);
    const seen: ExportJob[][] = [];
    q.subscribe((jobs) => seen.push([...jobs]));
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    const on = calls[0].onProgress;
    on({ phase: "video", done: 0, total: 100 });
    t = 10_000;
    on({ phase: "video", done: 50, total: 100 });
    const p = q.get(id)!.progress!;
    expect(p.fraction).toBeCloseTo(0.07 + 0.83 * 0.5, 9);
    // 0.415 of the bar took 10 s -> the remaining 0.515 takes ~12.4 s.
    expect(p.etaSec).toBeCloseTo((0.515 / 0.415) * 10, 6);
    expect(jobFraction({ phase: "validating", done: 1, total: 1 })).toBe(1);
    expect(jobFraction({ phase: "preparing", done: 0, total: 1 })).toBe(0);
    const fractions = seen.map((js) => js[0]?.progress?.fraction ?? 0);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions); // monotonic
    expect(seen.at(-2)![0]).not.toBe(seen.at(-1)![0]); // a new object per change (React-friendly)
    calls[0].resolve(outcome(true));
    await q.idle();
    expect(q.get(id)!.progress!.fraction).toBe(1);
  });

  it("remove: only finished jobs; invalid transitions throw", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    expect(() => q.remove(id)).toThrow(/Cancel the export/);
    calls[0].resolve(outcome(true));
    await q.idle();
    q.remove(id);
    expect(q.jobs).toEqual([]);
    expect(new InvalidJobTransition("completed", "processing").message).toBe("Export job can't go from completed to processing.");
  });

  it("file names carry preset, size, rate and container; a failed file is marked", () => {
    expect(exportFileName("youtube", { width: 1920, height: 1080, fps: 30, container: "mp4" })).toBe("render-youtube-1920x1080-30fps.mp4");
    expect(exportFileName("custom", { width: 1080, height: 1080, fps: 25, container: "webm" }, true)).toBe("render-custom-1080x1080-25fps-FAILED-VALIDATION.webm");
  });
});

describe("audio length fixes found by real exports", () => {
  const tl = project(30);
  const base = buildRenderPlan(tl, { width: 1920, height: 1080, fps: 30, videoBitrate: 8e6 });
  const planFor = (container: "mp4" | "mov" | "webm", codec: "aac" | "opus") => ({ ...base, settings: { ...base.settings, container, audio: { sampleRate: 48000 as const, channels: 2 as const, codec, bitrate: 160_000 } } });
  const probe = (container: string, codec: string, durationSec: number, decodedSec?: number): ProbedOutput => ({
    mimeType: "x",
    video: { codec: "avc", width: 1920, height: 1080, frameCount: 120, timestamps: Array.from({ length: 120 }, (_, i) => i / 30), durationSec: 4 },
    audio: { codec, sampleRate: 48000, channels: 2, durationSec, decodedSec },
  });
  const dur = (p: ReturnType<typeof planFor>, o: ProbedOutput) => technicalChecks(p, o).find((c) => c.id === "audio-duration")!;

  it("Opus pre-skip is read from the OpusHead the encoder hands out (312 samples on Chrome)", () => {
    const head = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 2, 56, 1, 128, 187, 0, 0, 0, 0, 0]);
    expect(codecDelaySec("opus", { codec: "opus", sampleRate: 48000, numberOfChannels: 2, description: head })).toBe(312 / 48000);
    expect(codecDelaySec("opus", { codec: "opus", sampleRate: 48000, numberOfChannels: 2, description: head.buffer })).toBe(312 / 48000);
    expect(codecDelaySec("opus", { codec: "opus", sampleRate: 48000, numberOfChannels: 2 })).toBe(0);
    expect(codecDelaySec("aac", { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: head })).toBe(0);
  });

  it("the live Opus bug (track 20 ms short) fails; a WebM Opus overhang under one frame passes; MP4/MOV stay at ±1 ms", () => {
    expect(dur(planFor("webm", "opus"), probe("webm", "opus", 3.98, 3.9935)).ok).toBe(false);
    expect(dur(planFor("webm", "opus"), probe("webm", "opus", 4.02, 4.0135)).ok).toBe(true);
    expect(dur(planFor("webm", "opus"), probe("webm", "opus", 4.05, 4.05)).ok).toBe(false);
    expect(dur(planFor("mp4", "aac"), probe("mp4", "aac", 4.0135, 4.0135)).ok).toBe(false);
  });

  it("duration = decoded end bounded by the container's end (Mediabunny decodes past an MP4/MOV edit list; players don't)", () => {
    expect(dur(planFor("mov", "aac"), probe("mov", "aac", 4.0, 4.009333)).ok).toBe(true);
    expect(dur(planFor("mp4", "aac"), probe("mp4", "aac", 4.0, 3.95)).ok).toBe(false); // decoded audio short -> caught
    expect(audioFrameSec("opus")).toBe(0.02);
  });
});

describe("fidelity check: codec-limited detail (Phase 20, P1-1)", () => {
  const ok = (frame: number) => ({ frame, psnr: 41, neighborPsnr: 30 });
  it("passes a dither-dissolve frame that is lossy but matches its own frame best (the Project 7 case: 21.7 dB)", () => {
    const r = fidelityCheck([ok(0), ok(30), ok(60), { frame: 108, psnr: 21.7, neighborPsnr: 17.8 }, { frame: 107, psnr: 23.3, neighborPsnr: 17.0 }]);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/2 high-detail frame\(s\) below 30 dB .* codec-limited/);
  });
  it("still fails a SHIFTED frame (matches a neighbour better than itself)", () => {
    const r = fidelityCheck([ok(0), ok(30), ok(60), { frame: 108, psnr: 22.2, neighborPsnr: 26.7 }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/frame 108 matches a neighbouring frame better/);
  });
  it("still fails a black / garbage frame, whatever its neighbours", () => {
    const r = fidelityCheck([ok(0), ok(30), ok(60), { frame: 90, psnr: 11, neighborPsnr: 9 }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/frame 90 is only 11\.0 dB/);
  });
  it("fails when most checkpoints are below 30 dB (a global problem can't hide as codec-limited)", () => {
    const r = fidelityCheck([{ frame: 0, psnr: 25, neighborPsnr: 20 }, { frame: 1, psnr: 24, neighborPsnr: 19 }, ok(2)]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/only 1 of 3 reach 30 dB/);
  });
  it("a frame without a captured neighbour can't be codec-limited", () => {
    expect(fidelityCheck([ok(0), ok(1), ok(2), { frame: 3, psnr: 25 }]).ok).toBe(false);
  });
  it("identical behaviour for clean exports", () => {
    expect(fidelityCheck([ok(0), ok(1)]).ok).toBe(true);
    expect(fidelityCheck([]).ok).toBe(false);
    expect(fidelityCheck([ok(0)], undefined, 2).ok).toBe(false);
  });
});

describe("export files are released (Phase 20, P1-2)", () => {
  it("removing a finished job releases its written file; removing an active one is refused", async () => {
    const { runner, calls } = manualRunner();
    const q = new ExportQueue(runner);
    const id = q.enqueue({ name: "A", presetId: "youtube", settings: S, fileName: "a.mp4", timeline: project() });
    await tick();
    expect(() => q.remove(id)).toThrow(/Cancel/);
    let released = 0;
    calls[0].resolve({ ...outcome(true), release: async () => void released++ });
    await q.idle();
    q.remove(id);
    expect(released).toBe(1);
    expect(q.get(id)).toBeUndefined();
  });

  it("packet bounds for MP4 'reserve' fast start cover every frame and audio packet with margin", async () => {
    const { maxPacketCounts } = await import("../render/output-file");
    const b = maxPacketCounts(18000, 600, { codec: "aac", sampleRate: 48000 });
    expect(b.video).toBeGreaterThanOrEqual(18000);
    expect(b.audio).toBeGreaterThan(Math.ceil((600 * 48000) / 1024));
    expect(maxPacketCounts(300, 10, { codec: "opus", sampleRate: 48000 }).audio).toBeGreaterThan(500);
    expect(maxPacketCounts(300, 10, null).audio).toBe(0);
  });
});

describe("audio sync check on a slice (Phase 20, P1-2)", () => {
  it("measureLag over lagSlice equals measureLag over the whole signals — wherever the loud part is", async () => {
    const { lagSlice, measureLag } = await import("../render/validate");
    const sr = 48000;
    let seed = 9;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
    // (The lag VALUE measureLag finds on white noise isn't what's under test — that it is the SAME on the slice is.)
    for (const [lenSec, burstAt, lag] of [[30, 0.2, 37], [30, 14.6, -12], [30, 29.1, 2112], [3, 1.5, 0]] as const) {
      const n = lenSec * sr;
      const ref = new Float32Array(n);
      for (let i = 0; i < n; i++) ref[i] = rnd() * 0.02;
      const b0 = Math.round(burstAt * sr);
      for (let i = b0; i < Math.min(n, b0 + sr / 2); i++) ref[i] = rnd() * 0.8;
      const dec = new Float32Array(n);
      for (let i = 0; i < n; i++) dec[i] = (i - lag >= 0 && i - lag < n ? ref[i - lag] : 0) * 0.9 + rnd() * 0.001;
      const full = measureLag(ref, dec, sr);
      const { from, to } = lagSlice(ref, sr);
      const part = measureLag(ref.subarray(from, to), dec.subarray(from, to), sr);
      expect(part, `burst at ${burstAt}s`).toEqual(full);
      expect(to - from).toBeLessThan(4 * sr);
    }
  });
});
