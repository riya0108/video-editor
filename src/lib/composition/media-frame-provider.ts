import { createCanvas, get2d } from "./canvas";
import type { FrameProvider, FrameRequest } from "./frame-provider";
import type { SourceInfo } from "./resolve";

/**
 * Browser FrameProvider backed by <video> elements and decoded ImageBitmaps.
 *
 * PREVIEW and FINAL never share a decoder:
 *  - Preview uses a pool of <video> elements per source, one per on-screen
 *    slot, that play in real time and are re-seeked only when they drift. It
 *    returns the element itself — drawImage() takes whatever frame is current.
 *  - Final uses one dedicated, never-played <video> per source. Each request
 *    seeks it to the exact frame, waits until that frame is actually
 *    presented, and snapshots it into a full-resolution canvas — so playback
 *    or scrubbing in the preview can't move the frame an export is reading.
 *
 * Exact-frame timing: frame n is requested at (n + 0.5) / fps — the middle of
 * the frame's display interval — so float rounding of currentTime can't land
 * on the previous frame's boundary.
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
}

interface StillSource {
  kind: "still";
  image: CanvasImageSource;
  info: SourceInfo;
}

type Source = VideoSource | StillSource;

/** A preview decoder not on screen for this long is released — covers clips that were deleted/undone/split away, whose slot key will never be asked for again. Short enough to bound memory, long enough that scrubbing back and forth doesn't reload decoders. */
const SLOT_IDLE_EVICT_MS = 10_000;

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

  /** Fires when a preview decoder has a new frame ready (seek finished / metadata loaded) — the preview should redraw. */
  onFrameReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  async addVideo(sourceId: string, url: string, fps: number): Promise<{ info: SourceInfo; durationSec: number }> {
    const probe = createVideoElement(url);
    await waitForEvent(probe, "loadedmetadata");
    const info = { width: probe.videoWidth, height: probe.videoHeight };
    const durationSec = probe.duration;
    probe.removeAttribute("src");
    probe.load();
    if (!(info.width > 0 && info.height > 0)) throw new Error(`Video "${sourceId}" has no video track.`);
    this.sources.set(sourceId, { kind: "video", url, fps, info, durationSec, previewSlots: new Map(), exact: null, exactQueue: Promise.resolve() });
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

  remove(sourceId: string): void {
    const s = this.sources.get(sourceId);
    if (!s) return;
    if (s.kind === "video") {
      for (const el of s.previewSlots.values()) disposeVideo(el);
      if (s.exact) disposeVideo(s.exact);
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

    const target = clampTime((req.sourceFrame + 0.5) / s.fps, s.durationSec);
    const drift = Math.abs(el.currentTime - target);
    if (this.playing) {
      if (drift > PLAYBACK_DRIFT_TOLERANCE_SEC && !el.seeking) el.currentTime = target;
      if (el.paused) void el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      // Paused/scrubbing: chase the exact frame. If a seek is already in flight, setting currentTime again supersedes it — the browser only decodes the latest target.
      if (drift > 0.5 / s.fps) el.currentTime = target;
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

    // One exact decoder per source, so requests are serialized on it. Each resolves with its own snapshot canvas — never the live element.
    const run = async (): Promise<CanvasImageSource> => {
      if (!s.exact) {
        s.exact = createVideoElement(s.url);
        await waitForEvent(s.exact, "loadeddata");
      }
      const el = s.exact;
      const target = clampTime((req.sourceFrame + 0.5) / s.fps, s.durationSec);
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
