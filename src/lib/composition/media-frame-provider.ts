import { createCanvas, get2d, type AnyCanvas } from "./canvas";
import type { FrameProvider, FrameRequest } from "./frame-provider";
import type { SourceInfo } from "./resolve";
import { normalizeSequence, sampleAt, type SequenceFrame } from "./frame-sequence";
import { SequentialFrameCursor } from "./sequential-frame-cursor";
import { MatteTrack, alphaToRgba } from "./matte-track";
import type { Input, VideoSample, VideoSampleSink } from "mediabunny";

/**
 * Browser FrameProvider backed by <video> elements and decoded ImageBitmaps.
 *
 * PREVIEW and FINAL never share a decoder:
 *  - Preview uses a pool of <video> elements per source, one per on-screen
 *    slot, that play in real time and are re-seeked only when they drift. It
 *    returns the element itself — drawImage() takes whatever frame is current.
 *  - Final decodes with WebCodecs (Mediabunny), one forward-only decoder per
 *    on-screen slot (SequentialFrameCursor): an export's in-order requests
 *    decode each frame once instead of re-seeking from a keyframe per frame
 *    (PERFORMANCE_OPTIMIZATION_REPORT.md §2). Each request is snapshotted into
 *    its own full-resolution canvas. Sources it can't decode exactly as the
 *    <video> element would (no WebCodecs decoder, rotation metadata, alpha, a
 *    different display size) use one dedicated, never-played <video> per
 *    source instead: each request seeks it to the exact frame and waits until
 *    that frame is presented. Either way playback or scrubbing in the preview
 *    can't move the frame an export is reading.
 *
 * Exact-frame timing: frame n is requested at (n + 0.5 + FRAME_TIME_NUDGE) / fps
 * — the middle of the frame's display interval — so float rounding of
 * currentTime can't land on the previous frame's boundary (see sourceTimeSec).
 */

interface VideoSource {
  kind: "video";
  url: string;
  fps: number;
  info: SourceInfo;
  durationSec: number;
  previewSlots: Map<string, HTMLVideoElement>;
  exact: HTMLVideoElement | null;
  exactQueue: Promise<unknown>;
  /** The file itself when known (read without going through the URL). */
  blob?: Blob;
  /** WebCodecs decode of the source, opened on the first exact request; null = use the <video> path. */
  decoder: Promise<ExactDecoder | null> | null;
  /** One forward-only decoder per slot key. */
  cursors: Map<string, ExactSlot>;
}

interface ExactDecoder {
  input: Input;
  sink: VideoSampleSink;
}

interface ExactSlot {
  cursor: SequentialFrameCursor<VideoSample>;
  queue: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface StillSource {
  kind: "still";
  image: CanvasImageSource;
  info: SourceInfo;
}

/** Individually rendered frames (e.g. a video's background-removal matte), sample-and-hold between samples. */
interface SequenceSource {
  kind: "sequence";
  frames: SequenceFrame<CanvasImageSource & { width: number; height: number }>[];
  info: SourceInfo;
}

/**
 * A per-frame background-removal matte stored compactly (matte-track.ts). Frames are decoded on demand into small
 * canvases held in a bounded LRU, so memory is the compressed track plus MATTE_CACHE_FRAMES decoded frames however
 * long the clip is.
 */
interface MatteTrackSource {
  kind: "matte-track";
  track: MatteTrack;
  info: SourceInfo;
  /** Decoded frames, least recently used first. */
  cache: Map<number, AnyCanvas>;
  pending: Map<number, Promise<AnyCanvas>>;
}

type Source = VideoSource | StillSource | SequenceSource | MatteTrackSource;

/** Decoded matte frames kept per track (a 360x640 frame is 0.9 MB). */
const MATTE_CACHE_FRAMES = 48;
/** Frames decoded ahead of the one shown, so playback finds them ready. */
const MATTE_PREFETCH_FRAMES = 8;

/** A preview decoder not on screen for this long is released — covers clips that were deleted/undone/split away, whose slot key will never be asked for again. Short enough to bound memory, long enough that scrubbing back and forth doesn't reload decoders. */
const SLOT_IDLE_EVICT_MS = 10_000;

/** An exact-frame decoder not asked for a frame this long is closed (WebCodecs decoders are a limited hardware resource). */
const EXACT_IDLE_CLOSE_MS = 5_000;

/** A paused preview seek taking longer than this is superseded by the newest target instead of awaited. */
const SEEK_STUCK_MS = 1_000;

/** Re-seek a playing preview element only when it's this far off — seeking every frame would stall playback. */
const PLAYBACK_DRIFT_TOLERANCE_SEC = 0.2;

export class MediaFrameProvider implements FrameProvider {
  private readonly sources = new Map<string, Source>();
  private playing = false;
  private usedThisFrame = new Set<HTMLVideoElement>();
  private readonly listeners = new Set<() => void>();
  /** Preview elements that have decoded at least one frame. */
  private readonly hasShownFrame = new WeakSet<HTMLVideoElement>();
  private readonly lastUsed = new WeakMap<HTMLVideoElement, number>();
  private readonly seekStartedAt = new WeakMap<HTMLVideoElement, number>();

  /** Fires when a preview decoder has a new frame ready (seek finished / metadata loaded) — the preview should redraw. */
  onFrameReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  /** `blob`: the file behind `url`, when the caller has it — the exact-frame decoder then reads it directly. */
  async addVideo(sourceId: string, url: string, fps: number, blob?: Blob): Promise<{ info: SourceInfo; durationSec: number }> {
    const probe = createVideoElement(url);
    await waitForEvent(probe, "loadedmetadata");
    const info = { width: probe.videoWidth, height: probe.videoHeight };
    const durationSec = probe.duration;
    probe.removeAttribute("src");
    probe.load();
    if (!(info.width > 0 && info.height > 0)) throw new Error(`Video "${sourceId}" has no video track.`);
    this.sources.set(sourceId, { kind: "video", url, fps, info, durationSec, previewSlots: new Map(), exact: null, exactQueue: Promise.resolve(), blob, decoder: null, cursors: new Map() });
    this.notify();
    return { info, durationSec };
  }

  /** Images (incl. transparent PNG/WebP), or any already-rendered canvas/bitmap such as a background-removal matte. */
  async addImage(sourceId: string, blobOrUrl: Blob | string): Promise<SourceInfo> {
    const blob = typeof blobOrUrl === "string" ? await (await fetch(blobOrUrl)).blob() : blobOrUrl;
    // premultiplyAlpha "default" + no colorSpaceConversion change: decode exactly as an <img> would, alpha preserved.
    const bitmap = await createImageBitmap(blob);
    return this.addStill(sourceId, bitmap);
  }

  addStill(sourceId: string, image: CanvasImageSource & { width: number; height: number }): SourceInfo {
    const info = { width: image.width, height: image.height };
    this.sources.set(sourceId, { kind: "still", image, info });
    this.notify();
    return info;
  }

  /**
   * A source made of separately rendered frames keyed by SOURCE frame — what a per-frame background-removal matte of
   * a video is. Frames without a sample hold the nearest earlier one. All frames must share one size.
   */
  addFrameSequence(sourceId: string, frames: readonly SequenceFrame<CanvasImageSource & { width: number; height: number }>[]): SourceInfo {
    const sorted = normalizeSequence(frames);
    if (sorted.length === 0) throw new Error(`Frame sequence "${sourceId}" has no frames.`);
    const info = { width: sorted[0].image.width, height: sorted[0].image.height };
    this.sources.set(sourceId, { kind: "sequence", frames: sorted, info });
    this.notify();
    return info;
  }

  /**
   * A per-frame matte track (chunks from MatteTrackBuilder / a project file). Validated up front: a damaged or gappy
   * track throws here instead of failing mid-render.
   */
  addMatteTrack(sourceId: string, chunks: readonly Uint8Array[]): SourceInfo {
    const track = new MatteTrack(chunks);
    const info = { width: track.width, height: track.height };
    this.sources.set(sourceId, { kind: "matte-track", track, info, cache: new Map(), pending: new Map() });
    this.notify();
    return info;
  }

  /** True when `sourceId` is registered (used to tell a missing matte from a loaded one). */
  has(sourceId: string): boolean {
    return this.sources.has(sourceId);
  }

  remove(sourceId: string): void {
    const s = this.sources.get(sourceId);
    if (!s) return;
    if (s.kind === "sequence" || s.kind === "matte-track") {
      this.sources.delete(sourceId);
      return;
    }
    if (s.kind === "video") {
      for (const el of s.previewSlots.values()) disposeVideo(el);
      if (s.exact) disposeVideo(s.exact);
      for (const key of [...s.cursors.keys()]) this.closeExactSlot(s, key);
      void s.decoder?.then((d) => d?.input.dispose()).catch(() => {});
    } else if (typeof ImageBitmap !== "undefined" && s.image instanceof ImageBitmap) {
      s.image.close();
    }
    this.sources.delete(sourceId);
  }

  dispose(): void {
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.listeners.clear();
  }

  getSourceInfo(sourceId: string): SourceInfo | undefined {
    return this.sources.get(sourceId)?.info;
  }

  // -------------------------------------------------------------------------
  // PREVIEW
  // -------------------------------------------------------------------------

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) {
      for (const s of this.sources.values()) if (s.kind === "video") for (const el of s.previewSlots.values()) el.pause();
    }
  }

  beginPreviewFrame(): void {
    this.usedThisFrame = new Set();
  }

  /** Parks every preview decoder that wasn't on screen this frame (so off-screen clips don't keep decoding), and releases ones idle long enough to be stale. */
  endPreviewFrame(): void {
    const now = performance.now();
    for (const s of this.sources.values()) {
      if (s.kind !== "video") continue;
      for (const [key, el] of s.previewSlots) {
        if (this.usedThisFrame.has(el)) {
          this.lastUsed.set(el, now);
          continue;
        }
        if (!el.paused) el.pause();
        if (now - (this.lastUsed.get(el) ?? now) > SLOT_IDLE_EVICT_MS) {
          disposeVideo(el);
          s.previewSlots.delete(key);
        }
      }
    }
  }

  peekFrame(req: FrameRequest): CanvasImageSource | null {
    const s = this.sources.get(req.sourceId);
    if (!s) return null;
    if (s.kind === "still") return s.image;
    if (s.kind === "sequence") return sampleAt(s.frames, sequenceFrameIndex(req.sourceFrame))?.image ?? null;
    if (s.kind === "matte-track") return this.peekMatte(s, req.sourceFrame);

    let el = s.previewSlots.get(req.slotKey);
    if (!el) {
      el = createVideoElement(s.url);
      const ready = el;
      el.addEventListener("seeked", () => this.notify());
      el.addEventListener("loadeddata", () => {
        this.hasShownFrame.add(ready);
        this.notify();
      });
      s.previewSlots.set(req.slotKey, el);
    }
    this.usedThisFrame.add(el);

    const target = sourceTimeSec(req.sourceFrame, s.fps, s.durationSec);
    const drift = Math.abs(el.currentTime - target);
    if (this.playing) {
      if (drift > PLAYBACK_DRIFT_TOLERANCE_SEC && !el.seeking) el.currentTime = target;
      if (el.paused) void el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      // Paused/scrubbing: chase the exact frame, one seek at a time. A new target while a seek is in flight waits for
      // it: superseding every in-flight seek meant a fast drag finished almost none of them (28 of 120 frames shown,
      // PERFORMANCE_OPTIMIZATION_REPORT.md §6). "seeked" notifies the preview, whose next render issues the newest
      // target. A seek stuck longer than SEEK_STUCK_MS is superseded anyway.
      const now = performance.now();
      const inFlight = el.seeking && now - (this.seekStartedAt.get(el) ?? now) < SEEK_STUCK_MS;
      if (drift > 0.5 / s.fps && !inFlight) {
        el.currentTime = target;
        this.seekStartedAt.set(el, now);
      }
    }
    // readyState can dip below HAVE_CURRENT_DATA mid-seek; the element still holds (and drawImage still draws) the last decoded frame. Returning it keeps the layer on screen while scrubbing instead of blinking out every seek.
    return el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || this.hasShownFrame.has(el) ? el : null;
  }

  // -------------------------------------------------------------------------
  // FINAL
  // -------------------------------------------------------------------------

  getExactFrame(req: FrameRequest): Promise<CanvasImageSource> {
    const s = this.sources.get(req.sourceId);
    if (!s) return Promise.reject(new Error(`Unknown source "${req.sourceId}".`));
    if (s.kind === "still") return Promise.resolve(s.image);
    if (s.kind === "sequence") return Promise.resolve(sampleAt(s.frames, sequenceFrameIndex(req.sourceFrame))!.image);
    if (s.kind === "matte-track") return this.matteFrame(s, s.track.clampFrame(sequenceFrameIndex(req.sourceFrame)));

    return this.exactDecoder(s).then((decoder) => (decoder ? this.exactViaDecoder(s, decoder, req) : this.exactViaElement(s, req)));
  }

  /**
   * Preview: the exact matte frame when decoded; otherwise its decode starts (the preview redraws when it lands) and the
   * nearest decoded frame stands in — the same way a seeking <video> keeps showing its last frame. Final renders use
   * getExactFrame, which always waits for the exact frame.
   */
  private peekMatte(s: MatteTrackSource, sourceFrame: number): CanvasImageSource | null {
    const f = s.track.clampFrame(sequenceFrameIndex(sourceFrame));
    for (let k = 1; k <= MATTE_PREFETCH_FRAMES; k++) {
      const n = s.track.clampFrame(f + k);
      if (!s.cache.has(n)) void this.matteFrame(s, n).catch(() => {});
    }
    const hit = s.cache.get(f);
    if (hit) {
      s.cache.delete(f);
      s.cache.set(f, hit);
      return hit;
    }
    void this.matteFrame(s, f).then(
      () => this.notify(),
      () => {},
    );
    let best: AnyCanvas | null = null;
    let bestD = Infinity;
    for (const [n, c] of s.cache) {
      const d = Math.abs(n - f);
      if (d < bestD) [best, bestD] = [c, d];
    }
    return best;
  }

  /** Decodes (once) and caches one matte frame as a drawable white-with-alpha canvas. */
  private matteFrame(s: MatteTrackSource, f: number): Promise<AnyCanvas> {
    const hit = s.cache.get(f);
    if (hit) {
      s.cache.delete(f);
      s.cache.set(f, hit);
      return Promise.resolve(hit);
    }
    let p = s.pending.get(f);
    if (!p) {
      p = s.track.decodeFrame(f).then((alpha) => {
        const canvas = createCanvas(s.track.width, s.track.height);
        get2d(canvas).putImageData(new ImageData(alphaToRgba(alpha), s.track.width, s.track.height), 0, 0);
        s.cache.set(f, canvas);
        while (s.cache.size > MATTE_CACHE_FRAMES) s.cache.delete(s.cache.keys().next().value!);
        return canvas;
      });
      const pending = p;
      s.pending.set(f, pending);
      void pending.finally(() => s.pending.delete(f)).catch(() => {});
    }
    return p;
  }

  /** Opens the WebCodecs decode of a source once; null when it can't reproduce what the <video> element shows. */
  private exactDecoder(s: VideoSource): Promise<ExactDecoder | null> {
    s.decoder ??= (async () => {
      if (typeof VideoDecoder === "undefined") return null;
      let input: Input | null = null;
      try {
        // Loaded on the first export/exact request, not with the editor: Mediabunny is ~400 KB the preview never needs.
        const { ALL_FORMATS, BlobSource, Input, UrlSource, VideoSampleSink } = await import("mediabunny");
        input = new Input({ source: s.blob ? new BlobSource(s.blob) : new UrlSource(s.url), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        const usable =
          !!track &&
          (await track.canDecode()) &&
          (await track.getRotation()) === 0 &&
          !(await track.canBeTransparent()) &&
          (await track.getDisplayWidth()) === s.info.width &&
          (await track.getDisplayHeight()) === s.info.height;
        if (!usable) {
          input.dispose();
          return null;
        }
        return { input, sink: new VideoSampleSink(track) };
      } catch {
        input?.dispose();
        return null;
      }
    })();
    return s.decoder;
  }

  private exactViaDecoder(s: VideoSource, decoder: ExactDecoder, req: FrameRequest): Promise<CanvasImageSource> {
    let slot = s.cursors.get(req.slotKey);
    if (!slot) {
      slot = { cursor: new SequentialFrameCursor<VideoSample>((t) => decoder.sink.samples(t)), queue: Promise.resolve(), idleTimer: null };
      s.cursors.set(req.slotKey, slot);
    }
    const target = sourceTimeSec(req.sourceFrame, s.fps, s.durationSec);
    const own = slot;
    const run = async (): Promise<CanvasImageSource> => {
      try {
        const sample = await own.cursor.frameAt(target);
        const snap = createCanvas(s.info.width, s.info.height);
        sample.draw(get2d(snap), 0, 0, s.info.width, s.info.height);
        return snap;
      } catch {
        // A decode failure mid-stream: this source goes back to the <video> path for good (same frames, slower).
        s.decoder = Promise.resolve(null);
        this.closeExactSlot(s, req.slotKey);
        return this.exactViaElement(s, req);
      }
    };
    // Requests on one slot are served in order (the cursor is sequential); each resolves with its own snapshot.
    const result = own.queue.then(run, run);
    own.queue = result.catch(() => {});
    if (own.idleTimer) clearTimeout(own.idleTimer);
    own.idleTimer = setTimeout(() => this.closeExactSlot(s, req.slotKey, own), EXACT_IDLE_CLOSE_MS);
    return result;
  }

  private closeExactSlot(s: VideoSource, key: string, only?: ExactSlot) {
    const slot = s.cursors.get(key);
    if (!slot || (only && slot !== only)) return;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    s.cursors.delete(key);
    // After whatever is queued on it: never close a frame a pending request is drawing.
    slot.queue = slot.queue.then(() => slot.cursor.close()).catch(() => {});
  }

  /** One exact <video> per source, so requests are serialized on it. Each resolves with its own snapshot canvas — never the live element. */
  private exactViaElement(s: VideoSource, req: FrameRequest): Promise<CanvasImageSource> {
    const run = async (): Promise<CanvasImageSource> => {
      if (!s.exact) {
        s.exact = createVideoElement(s.url);
        await waitForEvent(s.exact, "loadeddata");
      }
      const el = s.exact;
      const target = sourceTimeSec(req.sourceFrame, s.fps, s.durationSec);
      if (Math.abs(el.currentTime - target) > 1e-6 || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        const seeked = waitForEvent(el, "seeked");
        el.currentTime = target;
        await seeked;
      }
      await waitForPresentedFrame(el);
      const snap = createCanvas(s.info.width, s.info.height);
      const ctx = get2d(snap);
      ctx.drawImage(el, 0, 0, s.info.width, s.info.height);
      return snap;
    };
    const result = s.exactQueue.then(run, run);
    s.exactQueue = result.catch(() => {});
    return result;
  }
}

/**
 * The sequence frame shown at a (possibly fractional, Phase 15 rate conversion) source frame — the same frame a video
 * shows when seeked to (sourceFrame + 0.5) / fps, so a video and its per-frame matte never disagree. Identity for
 * integer frames.
 */
export function sequenceFrameIndex(sourceFrame: number): number {
  return Math.floor(sourceFrame + 0.5 + 1e-9);
}

function createVideoElement(url: string): HTMLVideoElement {
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.src = url;
  return el;
}

function disposeVideo(el: HTMLVideoElement) {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/**
 * The time at which project frame `frame` samples a source: the middle of its display interval, nudged 1/10000 of a
 * frame later. The nudge matters when the source's rate differs from the project's: a 24 fps source on a 30 fps
 * timeline puts every 5th midpoint EXACTLY on a source-frame boundary, where which frame a decoder shows is decided by
 * sub-microsecond rounding — Chrome's <video> and the WebCodecs path disagreed there (measured,
 * PERFORMANCE_OPTIMIZATION_REPORT.md §2). ~3 µs past the boundary is far beyond any µs rounding, so preview and
 * export both show the frame that starts there.
 */
export const FRAME_TIME_NUDGE = 1e-4;

export function sourceTimeSec(frame: number, fps: number, durationSec: number): number {
  return clampTime((frame + 0.5 + FRAME_TIME_NUDGE) / fps, durationSec);
}

function clampTime(t: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, t);
  // Seeking to exactly `duration` shows a blank/ended frame in some browsers; stay just inside it.
  return Math.min(Math.max(0, t), Math.max(0, duration - 1e-3));
}

function waitForEvent(el: HTMLMediaElement, event: "loadedmetadata" | "loadeddata" | "seeked", timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${event}".`));
    }, timeoutMs);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Media error while waiting for "${event}": ${el.error?.message ?? "unknown"}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

/**
 * "seeked" means the seek finished, not necessarily that the new frame is the
 * one drawImage() will read in every browser. requestVideoFrameCallback fires
 * once the frame is actually ready for compositing; on a paused element it
 * may never fire (or the tab may be hidden), so it's raced with a short
 * timeout — by then "seeked" has already guaranteed the decode.
 */
function waitForPresentedFrame(el: HTMLVideoElement): Promise<void> {
  const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  if (!rvfc) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    rvfc.call(el, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
