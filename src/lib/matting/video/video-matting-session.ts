import { TemporalMattingEngine, type TemporalMattingOptions, type SerializedTemporalState } from "./temporal-matting-engine";

/**
 * VIDEO HUMAN MATTING — Phase 9. VideoMattingSession is the streaming/
 * chunked/cancellable/resumable orchestration around TemporalMattingEngine.
 * It deliberately knows nothing about how frames are actually decoded or
 * encoded — those are injected callbacks (`decodeFrame`/`inferFrame`/
 * `encodeChunk`) — so this whole control-flow layer (chunking, progress,
 * cancellation, resume-from-checkpoint) is unit-testable without a real
 * browser, video file, or ML model, the same "engine, not UI" split every
 * prior phase in this codebase uses. See frame-source.ts for a real (but
 * necessarily browser-only, not live-tested in this environment) decode
 * adapter that implements `decodeFrame` against an actual HTMLVideoElement.
 *
 * "Decode video efficiently" / "streaming/chunked... does not have to
 * reside in RAM": frames are decoded and inferred one at a time within a
 * chunk, and only the current chunk's decoded frames are held in memory —
 * once `encodeChunk` returns, that chunk's raw RGBA buffers (by far the
 * largest thing in memory here — much bigger than the eventual compressed
 * output) fall out of scope and are eligible for GC before the next chunk
 * starts. Peak memory is bounded by `chunkSizeFrames`, not by video length.
 *
 * "Preserve frame rate" / "preserve resolution": this layer never resamples,
 * drops, or duplicates a frame, and never resizes anything itself — every
 * frame index from the resume point through `totalFrames - 1` is decoded,
 * inferred, and encoded exactly once, at whatever resolution `decodeFrame`
 * returns it at. See the "preserves every frame exactly once" test.
 */

export interface DecodedFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  timestampMs: number;
}

export interface EncodableFrame extends DecodedFrame {
  alpha: Float32Array;
}

export interface VideoMattingProgress {
  framesProcessed: number;
  totalFrames: number;
  /** 0..1 */
  fraction: number;
  currentChunk: number;
  sceneCutsDetected: number;
  artifactFramesFlagged: number;
}

export interface VideoMattingCheckpoint {
  /** The next frame index that has NOT yet been processed — resuming starts here. */
  nextFrameIndex: number;
  temporalState: SerializedTemporalState;
  sceneCutsDetected: number;
  artifactFramesFlagged: number;
}

export interface VideoMattingSummary {
  framesProcessed: number;
  /** True only when the run stopped because `cancel()` was called before reaching `totalFrames` — a clean end-of-stream is never reported as cancelled. */
  cancelled: boolean;
  sceneCutsDetected: number;
  artifactFramesFlagged: number;
  /** Always present, even on a full, non-cancelled completion (where it trivially points past the last frame) — a caller doesn't need to branch on why it wants a checkpoint. */
  checkpoint: VideoMattingCheckpoint;
}

export interface VideoMattingSessionOptions {
  /** Best known total frame count. If the real stream ends earlier (decodeFrame returns null), the session stops cleanly there instead of throwing — see VideoMattingSummary.framesProcessed for the real count. */
  totalFrames: number;
  /** Frames held in memory at once — bounds peak RAM. */
  chunkSizeFrames: number;
  /** Returns null to signal end-of-stream (e.g. totalFrames was an estimate that overshot). */
  decodeFrame: (frameIndex: number) => Promise<DecodedFrame | null>;
  /** Runs whatever per-frame model was selected (e.g. via Phase 8's ModelRouter) — raw, un-smoothed alpha for this frame alone. */
  inferFrame: (frame: DecodedFrame) => Promise<Float32Array>;
  /** Receives one chunk's worth of fully temporally-processed frames, in order, ready to append to the output (e.g. this app's existing ProRes-4444-via-ffmpeg transparent-video path — see bg-removal-command.ts's finalizeArgs for the established encoder choice this is meant to feed). */
  encodeChunk: (frames: EncodableFrame[], chunkIndex: number) => Promise<void>;
  /** Called once after the last chunk, only on a non-cancelled completion — e.g. to mux/finalize the output container. */
  finalizeEncode?: () => Promise<void>;
  temporalOptions?: Partial<TemporalMattingOptions>;
  onProgress?: (progress: VideoMattingProgress) => void;
  /** Continues a previously cancelled/interrupted run — see VideoMattingSummary.checkpoint. */
  resumeFrom?: VideoMattingCheckpoint;
}

export class VideoMattingSession {
  private readonly options: VideoMattingSessionOptions;
  private readonly engine: TemporalMattingEngine;
  private nextFrameIndex: number;
  private sceneCutsDetected: number;
  private artifactFramesFlagged: number;
  private cancelled = false;

  constructor(options: VideoMattingSessionOptions) {
    this.options = options;
    if (options.resumeFrom) {
      this.engine = TemporalMattingEngine.fromCheckpoint(options.resumeFrom.temporalState);
      this.nextFrameIndex = options.resumeFrom.nextFrameIndex;
      this.sceneCutsDetected = options.resumeFrom.sceneCutsDetected;
      this.artifactFramesFlagged = options.resumeFrom.artifactFramesFlagged;
    } else {
      this.engine = new TemporalMattingEngine(options.temporalOptions);
      this.nextFrameIndex = 0;
      this.sceneCutsDetected = 0;
      this.artifactFramesFlagged = 0;
    }
  }

  /** Requests a stop at the next safe point (after the frame currently in flight finishes, before the next one starts) — never mid-frame. Safe to call from anywhere, including from inside onProgress. */
  cancel(): void {
    this.cancelled = true;
  }

  async run(): Promise<VideoMattingSummary> {
    const { totalFrames, chunkSizeFrames, decodeFrame, inferFrame, encodeChunk, finalizeEncode, onProgress } = this.options;
    let hitEndOfStream = false;

    while (this.nextFrameIndex < totalFrames && !this.cancelled && !hitEndOfStream) {
      const chunkIndex = Math.floor(this.nextFrameIndex / chunkSizeFrames);
      const chunkEnd = Math.min(totalFrames, this.nextFrameIndex + chunkSizeFrames);
      const encodable: EncodableFrame[] = [];

      while (this.nextFrameIndex < chunkEnd && !this.cancelled) {
        const decoded = await decodeFrame(this.nextFrameIndex);
        if (!decoded) {
          hitEndOfStream = true;
          break;
        }
        const rawAlpha = await inferFrame(decoded);
        const result = this.engine.processFrame(decoded.rgba, rawAlpha, decoded.width, decoded.height);
        if (result.sceneCutDetected) this.sceneCutsDetected++;
        if (result.artifactPixelCount > 0) this.artifactFramesFlagged++;

        encodable.push({ ...decoded, alpha: result.alpha });
        this.nextFrameIndex++;

        onProgress?.({
          framesProcessed: this.nextFrameIndex,
          totalFrames,
          fraction: this.nextFrameIndex / totalFrames,
          currentChunk: chunkIndex,
          sceneCutsDetected: this.sceneCutsDetected,
          artifactFramesFlagged: this.artifactFramesFlagged,
        });
      }

      if (encodable.length > 0) await encodeChunk(encodable, chunkIndex);
      // `encodable` (and every decoded RGBA buffer it holds) is unreachable
      // from here on — this is the chunk boundary that keeps peak memory
      // bounded rather than growing with video length.
    }

    const cancelled = this.cancelled && this.nextFrameIndex < totalFrames;
    if (!cancelled && finalizeEncode) await finalizeEncode();

    return {
      framesProcessed: this.nextFrameIndex,
      cancelled,
      sceneCutsDetected: this.sceneCutsDetected,
      artifactFramesFlagged: this.artifactFramesFlagged,
      checkpoint: this.getCheckpoint(),
    };
  }

  getCheckpoint(): VideoMattingCheckpoint {
    return {
      nextFrameIndex: this.nextFrameIndex,
      temporalState: this.engine.getCheckpoint(),
      sceneCutsDetected: this.sceneCutsDetected,
      artifactFramesFlagged: this.artifactFramesFlagged,
    };
  }
}
