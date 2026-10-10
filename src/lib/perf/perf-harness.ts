import { MediaFrameProvider } from "../composition/media-frame-provider";
import { PreviewRenderer } from "../composition/preview-renderer";
import { FinalRenderer } from "../composition/final-renderer";
import { previewProfile, type PreviewQuality } from "../composition/render-profile";
import { resolveFrame } from "../composition/resolve";
import { createCanvasTextMeasurer, type TextMeasurer } from "../composition/text-layout";
import type { FrameProvider, FrameRequest } from "../composition/frame-provider";
import { AudioSourceStore } from "../audio/source-store";
import { fingerprintBlob } from "../project/assets";
import { renderTimeline, type RenderDeps } from "../render/job";
import type { RenderSettings } from "../render/settings";
import type { TimelineModel } from "../timeline/model";
import { buildBenchProject, BENCH_FPS, BENCH_SOURCES } from "./bench-project";
import { roundDeep, summarize } from "./stats";

/**
 * BROWSER PERFORMANCE HARNESS (PERFORMANCE_BASELINE.md) — not used by the app. Every Phase 18 number comes from these
 * functions, run in the dev server through chrome-devtools (`await import('/src/lib/perf/perf-harness.ts')`), on the
 * BENCHMARK PROJECT (bench-project.ts) with production code paths: MediaFrameProvider, PreviewRenderer,
 * FinalRenderer, AudioSourceStore, renderTimeline. Nothing here reimplements an engine — it only times them.
 */

const now = () => performance.now();
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BenchDeps extends RenderDeps {
  provider: MediaFrameProvider;
  audio: AudioSourceStore;
}

export async function environment() {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } };
  const adapter = await nav.gpu?.requestAdapter().catch(() => null);
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    devicePixelRatio: devicePixelRatio,
    webgpuAdapter: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null,
    webcodecs: typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined",
  };
}

/** JS heap (performance.memory) and, when cross-origin isolated, the UA's whole-page measurement (DOM, canvases, workers). */
export async function memory() {
  const pm = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  const measure = (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory;
  let uaBytes: number | null = null;
  if (measure && globalThis.crossOriginIsolated) {
    try {
      uaBytes = (await measure.call(performance)).bytes;
    } catch {
      uaBytes = null;
    }
  }
  const mb = (b: number | null | undefined) => (b == null ? null : b / 1048576);
  return { jsHeapUsedMb: mb(pm?.usedJSHeapSize), jsHeapTotalMb: mb(pm?.totalJSHeapSize), pageMb: mb(uaBytes) };
}

/** Collects long tasks (>50 ms main-thread blocks) for the duration of `fn`. */
async function withLongTasks<T>(fn: () => Promise<T>): Promise<{ result: T; longTasks: { count: number; totalMs: number; maxMs: number } }> {
  const entries: PerformanceEntry[] = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((l) => entries.push(...l.getEntries()));
    obs.observe({ type: "longtask", buffered: false });
  } catch {
    obs = null;
  }
  const result = await fn();
  await sleep(0);
  obs?.disconnect();
  const d = entries.map((e) => e.duration);
  return { result, longTasks: { count: d.length, totalMs: d.reduce((a, b) => a + b, 0), maxMs: d.length ? Math.max(...d) : 0 } };
}

// ---------------------------------------------------------------------------
// MEDIA IMPORT — what the editor does for a dropped video (CompositionPlaygroundPanel.addMediaFiles)
// ---------------------------------------------------------------------------

export async function benchMediaImport(url: string, name: string) {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  const provider = new MediaFrameProvider();
  const audio = new AudioSourceStore();
  const before = await memory();
  const t0 = now();
  const objectUrl = URL.createObjectURL(file);
  const { result, longTasks } = await withLongTasks(async () => {
    const tMeta = now();
    const { info, durationSec } = await provider.addVideo("import-test", objectUrl, BENCH_FPS);
    const metadataMs = now() - tMeta;
    const tFp = now();
    await fingerprintBlob(file);
    const fingerprintMs = now() - tFp;
    // The app starts the soundtrack decode in the background (void) — time it to "ready" and to peaks.
    const tAudio = now();
    const st = await audio.add("import-test", objectUrl, name, { video: true });
    const audioReadyMs = now() - tAudio;
    for (let i = 0; i < 500 && !audio.peaks("import-test"); i++) await sleep(5);
    const audioPeaksMs = now() - tAudio;
    return { info, durationSec, metadataMs, fingerprintMs, audioReadyMs, audioPeaksMs, audioState: st.state };
  });
  // Clip insertion is synchronous after metadata+fingerprint: the clip is on the timeline once those two are done.
  const clipVisibleMs = result.metadataMs + result.fingerprintMs;
  const totalMs = now() - t0;
  const after = await memory();
  provider.dispose();
  audio.remove("import-test");
  URL.revokeObjectURL(objectUrl);
  return roundDeep({ file: { name, mb: file.size / 1048576, ...result.info, durationSec: result.durationSec }, ...result, clipVisibleMs, totalMs, longTasks, heapDeltaMb: (after.jsHeapUsedMb ?? 0) - (before.jsHeapUsedMb ?? 0) });
}

// ---------------------------------------------------------------------------
// SETUP — the benchmark project's sources, loaded the way the editor loads them
// ---------------------------------------------------------------------------

export async function setupBench(assets: { videoUrl: string; logoUrl: string }): Promise<{ deps: BenchDeps; timeline: TimelineModel; setupMs: number }> {
  const t0 = now();
  const provider = new MediaFrameProvider();
  const measurer = createCanvasTextMeasurer();
  const audio = new AudioSourceStore();
  const { durationSec } = await provider.addVideo(BENCH_SOURCES.video, assets.videoUrl, BENCH_FPS);
  await provider.addImage(BENCH_SOURCES.logo, assets.logoUrl);
  await audio.add(BENCH_SOURCES.video, assets.videoUrl, "bench.mp4", { video: true });
  const { timeline } = buildBenchProject({ sourceFrames: Math.floor(durationSec * BENCH_FPS) });
  const deps: BenchDeps = {
    provider,
    audio,
    measurer,
    pcm: (id) => audio.pcm(id),
    audioState: (id) => {
      const st = audio.status(id).state;
      return st === "ready" || st === "loading" || st === "no-audio" || st === "error" ? st : "missing";
    },
  };
  return { deps, timeline, setupMs: now() - t0 };
}

/** Preview decoders of a MediaFrameProvider (private field, read for measurement only). */
function previewElements(provider: MediaFrameProvider): HTMLVideoElement[] {
  const sources = (provider as unknown as { sources: Map<string, { kind: string; previewSlots?: Map<string, HTMLVideoElement> }> }).sources;
  const out: HTMLVideoElement[] = [];
  for (const s of sources.values()) if (s.kind === "video" && s.previewSlots) out.push(...s.previewSlots.values());
  return out;
}

/** Renders until every preview decoder has settled on its frame (no seek in flight, a frame decoded). */
async function settle(renderer: PreviewRenderer, provider: MediaFrameProvider, timeline: TimelineModel, frame: number, quality: PreviewQuality, timeoutMs = 5000): Promise<{ ms: number; renders: number; timedOut: boolean }> {
  const t0 = now();
  let renders = 0;
  for (;;) {
    const r = renderer.render(timeline, frame, previewProfile(quality, 1, 1, false));
    renders++;
    const els = previewElements(provider);
    const busy = els.some((el) => el.seeking || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA);
    if (!busy && r.stats.skipped.length === 0) return { ms: now() - t0, renders, timedOut: false };
    if (now() - t0 > timeoutMs) return { ms: now() - t0, renders, timedOut: true };
    await new Promise<void>((resolve) => {
      const off = provider.onFrameReady(() => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, 16);
    });
  }
}

// ---------------------------------------------------------------------------
// PREVIEW: compositing cost, scrubbing latency, playback
// ---------------------------------------------------------------------------

/** Pure compositing cost of a preview frame with all media already decoded (paused). */
export async function benchPreviewRender(deps: BenchDeps, timeline: TimelineModel, opts: { quality?: PreviewQuality; frames?: number[]; repeats?: number } = {}) {
  const quality = opts.quality ?? "full";
  const renderer = new PreviewRenderer(deps.provider, deps.measurer);
  deps.provider.setPlaying(false);
  const samples: number[] = [];
  const perFrame: Record<number, number> = {};
  for (const f of opts.frames ?? [10, 150, 200]) {
    await settle(renderer, deps.provider, timeline, f, quality);
    const s: number[] = [];
    for (let i = 0; i < (opts.repeats ?? 20); i++) {
      const t = now();
      renderer.render(timeline, f, previewProfile(quality, 1, 1, false));
      s.push(now() - t);
    }
    samples.push(...s);
    perFrame[f] = summarize(s).p50;
  }
  return roundDeep({ quality, size: `${renderer.output.width}x${renderer.output.height}`, renderMs: summarize(samples), p50ByFrame: perFrame });
}

/**
 * Scrubbing: (a) random jumps — time from the request until the exact frame is decoded and rendered; (b) a drag —
 * consecutive frames requested every animation frame, as dragging the playhead does, measuring how far behind the
 * displayed frame lags and how many requested frames were ever shown.
 */
export async function benchScrub(deps: BenchDeps, timeline: TimelineModel, opts: { jumps?: number; dragFrames?: number; quality?: PreviewQuality; seed?: number } = {}) {
  const quality = opts.quality ?? "auto";
  const renderer = new PreviewRenderer(deps.provider, deps.measurer);
  deps.provider.setPlaying(false);
  let seed = opts.seed ?? 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  await settle(renderer, deps.provider, timeline, 0, quality);
  const jumpMs: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < (opts.jumps ?? 20); i++) {
    const f = Math.floor(rand() * 299);
    const r = await settle(renderer, deps.provider, timeline, f, quality);
    if (r.timedOut) timeouts++;
    else jumpMs.push(r.ms);
  }
  // Drag: one new frame per animation frame (the main track's decoder). The frame on screen is the one the decoder
  // last finished seeking to ("seeked"), not currentTime (which jumps to the request immediately).
  const shownLag: number[] = [];
  const n = opts.dragFrames ?? 120;
  const start = 20;
  const renderMs: number[] = [];
  const shownFrames = new Set<number>();
  let main: HTMLVideoElement | undefined;
  let lastShown = -1;
  const onSeeked = () => (lastShown = Math.floor(main!.currentTime * BENCH_FPS));
  for (let k = 0; k < n; k++) {
    await nextFrame();
    const f = start + k;
    const t = now();
    renderer.render(timeline, f, previewProfile(quality, 1, 1, false));
    renderMs.push(now() - t);
    if (!main) {
      main = previewElements(deps.provider)[0];
      main?.addEventListener("seeked", onSeeked);
      lastShown = main ? Math.floor(main.currentTime * BENCH_FPS) : -1;
    }
    shownLag.push(f - lastShown);
    shownFrames.add(lastShown);
  }
  main?.removeEventListener("seeked", onSeeked);
  const shown = shownFrames.size;
  const after = await settle(renderer, deps.provider, timeline, start + n - 1, quality);
  return roundDeep({ quality, jumpToExactFrameMs: summarize(jumpMs), jumpTimeouts: timeouts, drag: { requested: n, renderMs: summarize(renderMs), distinctFramesShown: shown, frameLag: summarize(shownLag), settleAfterReleaseMs: after.ms } });
}

/**
 * Playback the way the editor runs it: the provider in playing mode, the frame derived from the wall clock, one preview
 * render per animation frame, presented to an on-screen canvas. Measures UI frame rate, render cost, how many distinct
 * decoded video frames reached the screen (the real "preview FPS"), and main-thread long tasks.
 */
export async function benchPlayback(deps: BenchDeps, timeline: TimelineModel, opts: { seconds?: number; quality?: PreviewQuality; startFrame?: number } = {}) {
  const quality = opts.quality ?? "auto";
  const seconds = opts.seconds ?? 5;
  const renderer = new PreviewRenderer(deps.provider, deps.measurer);
  const screen = document.createElement("canvas");
  screen.width = 1280;
  screen.height = 720;
  screen.style.cssText = "position:fixed;right:0;bottom:0;width:320px;height:180px;z-index:99999";
  document.body.appendChild(screen);
  const sctx = screen.getContext("2d")!;
  const start = opts.startFrame ?? 0;
  await settle(renderer, deps.provider, timeline, start, quality);
  // Count decoded frames that each video element actually presented.
  const presented = new Map<HTMLVideoElement, number>();
  let seeks = 0;
  const watched = new Set<HTMLVideoElement>();
  const watch = () => {
    for (const el of previewElements(deps.provider)) {
      if (watched.has(el)) continue;
      watched.add(el);
      el.addEventListener("seeking", () => seeks++);
      const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
      if (!rvfc) continue;
      const tick = () => {
        presented.set(el, (presented.get(el) ?? 0) + 1);
        rvfc.call(el, tick);
      };
      rvfc.call(el, tick);
    }
  };
  watch();
  const intervals: number[] = [];
  const renderMs: number[] = [];
  const skippedFrames: number[] = [];
  const { longTasks } = await withLongTasks(async () => {
    deps.provider.setPlaying(true);
    const t0 = now();
    let last = t0;
    while (now() - t0 < seconds * 1000) {
      const ts = await nextFrame();
      intervals.push(ts - last);
      last = ts;
      const f = start + Math.floor(((now() - t0) / 1000) * BENCH_FPS);
      const t = now();
      const r = renderer.render(timeline, f % 300, previewProfile(quality, 0.6, devicePixelRatio, true));
      sctx.drawImage(renderer.output as CanvasImageSource, 0, 0, screen.width, screen.height);
      renderMs.push(now() - t);
      if (r.stats.skipped.length) skippedFrames.push(f);
      watch();
    }
    deps.provider.setPlaying(false);
  });
  screen.remove();
  intervals.shift();
  const decoded = [...presented.values()];
  const busy = renderMs.reduce((a, b) => a + b, 0);
  return roundDeep({
    quality,
    seconds,
    uiFps: intervals.length / (intervals.reduce((a, b) => a + b, 0) / 1000),
    frameIntervalMs: summarize(intervals),
    droppedUiFrames: intervals.filter((i) => i > 1000 / 60 * 1.5).length,
    renderMs: summarize(renderMs),
    renderBusyPct: (busy / (seconds * 1000)) * 100,
    decodedFpsPerVideo: decoded.map((n) => n / seconds),
    reseeksDuringPlayback: seeks,
    framesWithMissingLayer: skippedFrames.length,
    longTasks,
  });
}

// ---------------------------------------------------------------------------
// FINAL RENDER + EXPORT
// ---------------------------------------------------------------------------

class TimedProvider implements FrameProvider {
  fetchMs: number[] = [];
  constructor(private readonly inner: FrameProvider) {}
  getSourceInfo(id: string) {
    return this.inner.getSourceInfo(id);
  }
  peekFrame(req: FrameRequest) {
    return this.inner.peekFrame(req);
  }
  async getExactFrame(req: FrameRequest) {
    const t = now();
    try {
      return await this.inner.getExactFrame(req);
    } finally {
      this.fetchMs.push(now() - t);
    }
  }
}

/** Sequential final frames (as an export renders them): total per frame, and how much of it is waiting for exact source frames. */
export async function benchFinalFrames(deps: BenchDeps, timeline: TimelineModel, opts: { start?: number; count?: number } = {}) {
  const timed = new TimedProvider(deps.provider);
  const renderer = new FinalRenderer(timed, deps.measurer);
  const start = opts.start ?? 0;
  const count = opts.count ?? 60;
  const frameMs: number[] = [];
  const fetchPerFrame: number[] = [];
  for (let f = start; f < start + count; f++) {
    const before = timed.fetchMs.length;
    const t = now();
    await renderer.renderFrame(timeline, f);
    frameMs.push(now() - t);
    // Layers are fetched concurrently; the frame waits for the slowest.
    fetchPerFrame.push(Math.max(0, ...timed.fetchMs.slice(before)));
  }
  const fps = count / (frameMs.reduce((a, b) => a + b, 0) / 1000);
  return roundDeep({ frames: count, framesPerSec: fps, frameMs: summarize(frameMs), slowestFetchMs: summarize(fetchPerFrame), drawAndResolveMsP50: summarize(frameMs).p50 - summarize(fetchPerFrame).p50 });
}

export async function benchExport(deps: BenchDeps, timeline: TimelineModel, settings: Partial<RenderSettings> = {}) {
  const s: RenderSettings = { width: 1920, height: 1080, fps: 30, ...settings };
  const before = await memory();
  const t0 = now();
  const { result, longTasks } = await withLongTasks(() => renderTimeline(timeline, s, deps));
  const wallMs = now() - t0;
  const after = await memory();
  const { report, stageMs, plan } = result;
  return roundDeep({
    settings: `${s.width}x${s.height}@${s.fps}`,
    ok: report.ok,
    failedChecks: report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
    frames: plan.frameCount,
    durationSec: plan.durationSec,
    wallMs,
    realtimeFactor: plan.durationSec / (wallMs / 1000),
    renderFps: plan.frameCount / ((stageMs.frames + stageMs.encode + stageMs.checks) / 1000),
    stageMs,
    perFrameMs: { frames: stageMs.frames / plan.frameCount, encode: stageMs.encode / plan.frameCount, checks: stageMs.checks / plan.frameCount },
    bytes: report.bytes,
    longTasks,
    heapDeltaMb: (after.jsHeapUsedMb ?? 0) - (before.jsHeapUsedMb ?? 0),
  });
}

// ---------------------------------------------------------------------------
// CACHES
// ---------------------------------------------------------------------------

/** Cold vs warm cost of every cache on the render path, measured through the public entry points. */
export async function benchCaches(deps: BenchDeps, timeline: TimelineModel) {
  // Text layout (resolve.ts layoutCache, keyed by content object + measurer generation).
  const coldMeasurer: TextMeasurer = createCanvasTextMeasurer();
  const ctx = (m: TextMeasurer) => ({ getSourceInfo: (id: string) => deps.provider.getSourceInfo(id), measurer: m });
  let t = now();
  resolveFrame(timeline, 100, ctx(coldMeasurer));
  const resolveCold = now() - t;
  const warm: number[] = [];
  for (let i = 0; i < 50; i++) {
    t = now();
    resolveFrame(timeline, 100, ctx(coldMeasurer));
    warm.push(now() - t);
  }
  // Mask raster (draw.ts MaskRasterCache): first render of a frame vs the same frame again, on the masked PiP.
  const renderer = new PreviewRenderer(deps.provider, deps.measurer);
  await settle(renderer, deps.provider, timeline, 77, "full");
  const fresh = { ...timeline, clips: { ...timeline.clips } };
  const pipId = Object.values(timeline.clips).find((c) => (c.masks ?? []).length > 0)!.id;
  const pip = timeline.clips[pipId];
  // A slightly different feather = a guaranteed cache miss with otherwise identical work.
  fresh.clips[pipId] = { ...pip, masks: pip.masks!.map((m) => ({ ...m, feather: m.feather + 0.37 })) };
  t = now();
  renderer.render(fresh, 77, previewProfile("full", 1, 1, false));
  const maskMiss = now() - t;
  t = now();
  renderer.render(fresh, 77, previewProfile("full", 1, 1, false));
  const maskHit = now() - t;
  // Fonts: document.fonts.load of a registry face, first vs second.
  t = now();
  await document.fonts.load("700 64px Anton", "Ab");
  const fontFirst = now() - t;
  t = now();
  await document.fonts.load("700 64px Anton", "Ab");
  const fontSecond = now() - t;
  // ML model cache (Cache Storage): what's stored.
  let modelCache: { entries: number; mb: number } | null = null;
  try {
    const cache = await caches.open("clipbench-ml-models-v1");
    const keys = await cache.keys();
    let bytes = 0;
    for (const k of keys) bytes += (await (await cache.match(k))!.blob()).size;
    modelCache = { entries: keys.length, mb: bytes / 1048576 };
  } catch {
    modelCache = null;
  }
  return roundDeep({ textLayout: { resolveColdMs: resolveCold, resolveWarmMs: summarize(warm) }, maskRaster: { missFrameMs: maskMiss, hitFrameMs: maskHit }, fonts: { firstLoadMs: fontFirst, secondLoadMs: fontSecond }, modelCache });
}

// ---------------------------------------------------------------------------
// EDITOR (real UI) — needs the playground page and its dev handles
// ---------------------------------------------------------------------------

/**
 * Playback inside the real editor page: presses Play, then samples animation-frame intervals, long tasks and React's
 * share of the main thread for `seconds`. Run on /tools/video/composition-preview with a project open.
 */
export async function benchEditorPlayback(seconds = 5) {
  const play = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Play");
  if (!play) throw new Error("No Play button on this page.");
  const intervals: number[] = [];
  const { longTasks } = await withLongTasks(async () => {
    play.click();
    await nextFrame();
    let last = await nextFrame();
    const t0 = now();
    while (now() - t0 < seconds * 1000) {
      const ts = await nextFrame();
      intervals.push(ts - last);
      last = ts;
    }
    [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Pause")?.click();
  });
  return roundDeep({ seconds, uiFps: intervals.length / (intervals.reduce((a, b) => a + b, 0) / 1000), frameIntervalMs: summarize(intervals), droppedUiFrames: intervals.filter((i) => i > 1000 / 60 * 1.5).length, longTasks });
}

// ---------------------------------------------------------------------------
// CORRECTNESS — the WebCodecs exact-frame path against the <video> seek path
// ---------------------------------------------------------------------------

function pixelsOf(img: CanvasImageSource & { width: number; height: number }, side = 480): Uint8ClampedArray {
  const k = Math.min(1, side / Math.max(img.width, img.height));
  const c = new OffscreenCanvas(Math.round(img.width * k), Math.round(img.height * k));
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, c.width, c.height);
  return g.getImageData(0, 0, c.width, c.height).data;
}

function psnrOf(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      se += d * d;
    }
    n += 3;
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

/**
 * Requests `frames` (in order) through the production decoder path and through a provider forced onto the <video>
 * seek path, and compares them. A frame counts as "same frame" when the decoder's output matches the reference frame
 * n better than the reference frames n-1 and n+1 — i.e. the right frame was chosen, whatever tiny colour-conversion
 * differences remain.
 */
export async function verifyExactDecode(url: string, fps: number, frames: number[], opts: { useBlob?: boolean } = {}) {
  const blob = opts.useBlob ? await (await fetch(url)).blob() : undefined;
  const ref = new MediaFrameProvider();
  const dec = new MediaFrameProvider();
  await ref.addVideo("v", url, fps);
  await dec.addVideo("v", url, fps, blob);
  // Force the reference onto the <video> path.
  (ref as unknown as { sources: Map<string, { decoder: Promise<null> }> }).sources.get("v")!.decoder = Promise.resolve(null);
  const usedDecoder = !!(await (dec as unknown as { exactDecoder(s: unknown): Promise<unknown> }).exactDecoder((dec as unknown as { sources: Map<string, unknown> }).sources.get("v")));
  const refPx = new Map<number, Uint8ClampedArray>();
  const getRef = async (n: number) => {
    if (n < 0) return null;
    if (!refPx.has(n)) refPx.set(n, pixelsOf((await ref.getExactFrame({ sourceId: "v", sourceFrame: n, slotKey: "r" })) as OffscreenCanvas));
    return refPx.get(n)!;
  };
  const rows: { frame: number; psnr: number; sameFrame: boolean }[] = [];
  const t0 = now();
  const decPx: Uint8ClampedArray[] = [];
  for (const n of frames) decPx.push(pixelsOf((await dec.getExactFrame({ sourceId: "v", sourceFrame: n, slotKey: "d" })) as OffscreenCanvas));
  const decodeMs = now() - t0;
  for (let i = 0; i < frames.length; i++) {
    const n = frames[i];
    const r = (await getRef(n))!;
    const p = psnrOf(decPx[i], r);
    const prev = await getRef(n - 1);
    const next = await getRef(n + 1).catch(() => null);
    const sameFrame = (!prev || psnrOf(decPx[i], prev) < p || p === Infinity) && (!next || psnrOf(decPx[i], next) < p || p === Infinity);
    rows.push({ frame: n, psnr: p, sameFrame });
  }
  ref.dispose();
  dec.dispose();
  const finite = rows.map((r) => r.psnr).filter(Number.isFinite);
  return roundDeep({ usedDecoder, frames: rows.length, decodeMs, wrongFrames: rows.filter((r) => !r.sameFrame).map((r) => r.frame), identical: rows.filter((r) => r.psnr === Infinity).length, minPsnr: finite.length ? Math.min(...finite) : Infinity, worst: rows.filter((r) => Number.isFinite(r.psnr)).sort((a, b) => a.psnr - b.psnr).slice(0, 3) });
}

/** SHA-256 of full-resolution FINAL renders (and PREVIEW renders at full quality) — the pixel-exactness check run before and after each optimization. */
export async function renderHashes(deps: BenchDeps, timeline: TimelineModel, frames: number[]) {
  const hash = async (canvas: OffscreenCanvas | HTMLCanvasElement) => {
    const g = (canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", px)))
      .slice(0, 12)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const final = new FinalRenderer(deps.provider, deps.measurer);
  const preview = new PreviewRenderer(deps.provider, deps.measurer);
  const out: Record<number, { final: string; preview: string }> = {};
  for (const f of frames) {
    const { canvas } = await final.renderFrame(timeline, f);
    const fh = await hash(canvas as OffscreenCanvas);
    await settle(preview, deps.provider, timeline, f, "full");
    preview.render(timeline, f, previewProfile("full", 1, 1, false));
    out[f] = { final: fh, preview: await hash(preview.output as OffscreenCanvas) };
  }
  return out;
}

/**
 * GPU vs CPU isolation surfaces on the SAME code: renders final frames normally, then with every scratch surface forced
 * CPU-backed (the pre-change behaviour), and compares. Returns per-frame PSNR and max channel difference.
 */
export async function compareScratchModes(deps: BenchDeps, timeline: TimelineModel, frames: number[]) {
  const read = (c: OffscreenCanvas) => (c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
  const gpu = new FinalRenderer(deps.provider, deps.measurer);
  const cpu = new FinalRenderer(deps.provider, deps.measurer);
  const priv = cpu as unknown as { getScratch(slot: number, readback: boolean, w: number, h: number): unknown };
  const orig = priv.getScratch.bind(cpu);
  priv.getScratch = (slot, _readback, w, h) => orig(slot, true, w, h);
  const rows: { frame: number; psnr: number; maxDiff: number; differing: number }[] = [];
  for (const f of frames) {
    const a = read((await gpu.renderFrame(timeline, f)).canvas as OffscreenCanvas).slice();
    const b = read((await cpu.renderFrame(timeline, f)).canvas as OffscreenCanvas);
    let se = 0;
    let max = 0;
    let differing = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d) differing++;
      if (d > max) max = d;
      se += d * d;
    }
    rows.push({ frame: f, psnr: se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.length)), maxDiff: max, differing });
  }
  return roundDeep(rows);
}
