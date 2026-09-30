import type { DecodedFrame } from "./video-matting-session";

/**
 * VIDEO HUMAN MATTING — Phase 9. A real HTMLVideoElement-backed
 * `decodeFrame` implementation for VideoMattingSession, using
 * `requestVideoFrameCallback` (rVFC) rather than seek-per-frame: rVFC
 * delivers frames in actual decode/presentation order at the video's own
 * rate, which is what "decode video efficiently" and "preserve frame rate"
 * actually need — a seek-per-frame loop (this app's existing pattern for
 * SPARSE sampling in captions/person-cutout.ts) is fine when you only need
 * a handful of frames, but reseeking for every single frame of a dense pass
 * is far slower and, depending on keyframe placement, can skip or duplicate
 * frames — exactly what "preserve frame rate" rules out.
 *
 * `VideoMattingSession.decodeFrame` is pull-based (`decodeFrame(index)`);
 * rVFC is push-based (one callback per presented frame, tied to real
 * playback). This adapter bridges the two with a small bounded queue: play
 * the video, capture each rVFC frame into the queue, and pause playback
 * once the queue reaches `maxQueueSize` (backpressure) so decode never runs
 * unboundedly ahead of processing — the same bounded-memory intent as the
 * session's own chunking, one level down.
 *
 * HONESTY NOTE: HTMLVideoElement/requestVideoFrameCallback don't exist in
 * the Node/Vitest environment this repo's automated tests run in, so this
 * file is not (and cannot be) covered by an automated test here — unlike
 * temporal-matting-engine.ts and video-matting-session.ts, which are. It's
 * written to the exact contract VideoMattingSession expects and reviewed
 * carefully, but per this project's standing rule against unverified
 * success claims, treat it as a real, ready integration point that still
 * needs a live-browser smoke test (the same chrome-devtools-mcp pattern
 * used to verify every other browser-facing feature in this codebase)
 * before being trusted end-to-end.
 */
export interface VideoFrameSourceOptions {
  /** Frames buffered ahead of processing before playback is paused for backpressure — bounds how far decode can run ahead of inference/encode. */
  maxQueueSize?: number;
}

export interface VideoFrameSource {
  /** `frameIndex` is accepted for interface-compatibility with VideoMattingSession's contract (strictly increasing calls starting at 0) but otherwise unused — rVFC has no "seek to frame N" concept, so this always returns the next frame the video actually presents, in order. Returns null at end-of-stream. */
  decodeFrame: (frameIndex: number) => Promise<DecodedFrame | null>;
  dispose: () => void;
}

/**
 * `video` must already have a source loaded (readyState >= HAVE_CURRENT_DATA)
 * and be paused at its intended start point — this function takes over
 * playback control (play/pause) itself from here on.
 */
export function createVideoFrameSource(video: HTMLVideoElement, options: VideoFrameSourceOptions = {}): VideoFrameSource {
  const maxQueueSize = options.maxQueueSize ?? 8;
  const queue: DecodedFrame[] = [];
  const waiters: ((frame: DecodedFrame | null) => void)[] = [];
  let ended = false;
  let disposed = false;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  function deliver(frame: DecodedFrame | null): void {
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else if (frame) queue.push(frame);
  }

  function resumeIfNeeded(): void {
    if (disposed || ended) return;
    if (video.paused && queue.length < maxQueueSize) {
      void video.play();
      video.requestVideoFrameCallback(onFrame);
    }
  }

  function onFrame(_now: number, metadata: VideoFrameCallbackMetadata): void {
    if (disposed) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx!.drawImage(video, 0, 0);
    const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
    deliver({ rgba: imageData.data as unknown as Uint8ClampedArray, width: canvas.width, height: canvas.height, timestampMs: metadata.mediaTime * 1000 });

    if (queue.length >= maxQueueSize) video.pause();
    else if (!video.ended) video.requestVideoFrameCallback(onFrame);
  }

  function onEnded(): void {
    ended = true;
    deliver(null);
  }

  video.addEventListener("ended", onEnded);
  video.requestVideoFrameCallback(onFrame);
  void video.play();

  return {
    async decodeFrame(): Promise<DecodedFrame | null> {
      if (disposed) return null;
      if (queue.length > 0) {
        const frame = queue.shift()!;
        resumeIfNeeded();
        return frame;
      }
      if (ended) return null;
      return new Promise((resolve) => {
        waiters.push(resolve);
        resumeIfNeeded();
      });
    },
    dispose(): void {
      disposed = true;
      video.removeEventListener("ended", onEnded);
      video.pause();
    },
  };
}
