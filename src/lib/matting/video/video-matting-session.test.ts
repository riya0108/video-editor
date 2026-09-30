import { describe, it, expect } from "vitest";
import { VideoMattingSession, type DecodedFrame, type EncodableFrame } from "./video-matting-session";

const W = 2;
const H = 2;

function makeFrame(index: number, gray = 100): DecodedFrame {
  return { rgba: new Uint8ClampedArray(W * H * 4).fill(gray), width: W, height: H, timestampMs: index * (1000 / 30) };
}

describe("VideoMattingSession — processes every frame exactly once, in order", () => {
  it("calls decodeFrame with every index from 0 to totalFrames-1, in order, exactly once", async () => {
    const totalFrames = 10;
    const decodedIndexes: number[] = [];
    const session = new VideoMattingSession({
      totalFrames,
      chunkSizeFrames: 4,
      decodeFrame: async (i) => {
        decodedIndexes.push(i);
        return makeFrame(i);
      },
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async () => {},
    });

    const summary = await session.run();

    expect(decodedIndexes).toEqual(Array.from({ length: totalFrames }, (_, i) => i));
    expect(summary.framesProcessed).toBe(totalFrames);
    expect(summary.cancelled).toBe(false);
  });

  it("chunks encodeChunk calls to chunkSizeFrames per call, with a smaller final chunk", async () => {
    const chunkSizes: number[] = [];
    const session = new VideoMattingSession({
      totalFrames: 10,
      chunkSizeFrames: 4,
      decodeFrame: async (i) => (i < 10 ? makeFrame(i) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async (frames: EncodableFrame[]) => {
        chunkSizes.push(frames.length);
      },
    });

    await session.run();
    expect(chunkSizes).toEqual([4, 4, 2]);
  });

  it("calls finalizeEncode exactly once, only after a clean (non-cancelled) completion", async () => {
    let finalizeCalls = 0;
    const session = new VideoMattingSession({
      totalFrames: 5,
      chunkSizeFrames: 5,
      decodeFrame: async (i) => (i < 5 ? makeFrame(i) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async () => {},
      finalizeEncode: async () => {
        finalizeCalls++;
      },
    });
    await session.run();
    expect(finalizeCalls).toBe(1);
  });
});

describe("VideoMattingSession — progress reporting", () => {
  it("reports monotonically increasing progress ending at fraction 1", async () => {
    const fractions: number[] = [];
    const session = new VideoMattingSession({
      totalFrames: 6,
      chunkSizeFrames: 3,
      decodeFrame: async (i) => (i < 6 ? makeFrame(i) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async () => {},
      onProgress: (p) => fractions.push(p.fraction),
    });
    await session.run();

    expect(fractions).toHaveLength(6);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

describe("VideoMattingSession — cancellation", () => {
  it("stops before totalFrames when cancel() is called mid-run, and never calls finalizeEncode", async () => {
    let finalizeCalls = 0;
    let framesSeen = 0;
    const session = new VideoMattingSession({
      totalFrames: 20,
      chunkSizeFrames: 5,
      decodeFrame: async (i) => (i < 20 ? makeFrame(i) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async () => {},
      finalizeEncode: async () => {
        finalizeCalls++;
      },
      onProgress: (p) => {
        framesSeen = p.framesProcessed;
        if (p.framesProcessed === 7) session.cancel();
      },
    });

    const summary = await session.run();

    expect(summary.cancelled).toBe(true);
    expect(summary.framesProcessed).toBeLessThan(20);
    expect(summary.framesProcessed).toBeGreaterThanOrEqual(7);
    expect(finalizeCalls).toBe(0);
    expect(framesSeen).toBe(summary.framesProcessed);
  });

  it("a clean end-of-stream (decodeFrame returns null) is never reported as cancelled", async () => {
    const session = new VideoMattingSession({
      totalFrames: 100, // an overestimate — the real stream ends early
      chunkSizeFrames: 10,
      decodeFrame: async (i) => (i < 6 ? makeFrame(i) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.5),
      encodeChunk: async () => {},
    });
    const summary = await session.run();
    expect(summary.cancelled).toBe(false);
    expect(summary.framesProcessed).toBe(6);
  });
});

describe("VideoMattingSession — resumability", () => {
  it("resuming from a cancelled run's checkpoint continues from the right frame and reaches the same end state as an uninterrupted run", async () => {
    const decodeUpTo = (n: number) => async (i: number) => (i < n ? makeFrame(i) : null);
    const infer = async () => new Float32Array(W * H).fill(0.5);

    const full = new VideoMattingSession({ totalFrames: 12, chunkSizeFrames: 4, decodeFrame: decodeUpTo(12), inferFrame: infer, encodeChunk: async () => {} });
    const fullSummary = await full.run();

    const decodedInResumedRun: number[] = [];
    const first = new VideoMattingSession({
      totalFrames: 12,
      chunkSizeFrames: 4,
      decodeFrame: decodeUpTo(12),
      inferFrame: infer,
      encodeChunk: async () => {},
      onProgress: (p) => {
        if (p.framesProcessed === 5) first.cancel();
      },
    });
    const firstSummary = await first.run();
    expect(firstSummary.cancelled).toBe(true);

    const second = new VideoMattingSession({
      totalFrames: 12,
      chunkSizeFrames: 4,
      decodeFrame: async (i) => {
        decodedInResumedRun.push(i);
        return decodeUpTo(12)(i);
      },
      inferFrame: infer,
      encodeChunk: async () => {},
      resumeFrom: firstSummary.checkpoint,
    });
    const secondSummary = await second.run();

    expect(decodedInResumedRun[0]).toBe(firstSummary.framesProcessed); // continues exactly where it left off, no re-decode of already-processed frames
    expect(secondSummary.framesProcessed).toBe(12);
    expect(secondSummary.cancelled).toBe(false);
    expect(secondSummary.framesProcessed).toBe(fullSummary.framesProcessed);
  });
});

describe("VideoMattingSession — temporal engine integration", () => {
  it("aggregates scene-cut and artifact counts from the real TemporalMattingEngine across the run", async () => {
    // Frame 0-2: one static shot. Frame 3: a hard cut to a very different scene.
    const grays = [100, 100, 100, 250, 250];
    const session = new VideoMattingSession({
      totalFrames: grays.length,
      chunkSizeFrames: 10,
      decodeFrame: async (i) => (i < grays.length ? makeFrame(i, grays[i]) : null),
      inferFrame: async () => new Float32Array(W * H).fill(0.8),
      encodeChunk: async () => {},
    });
    const summary = await session.run();
    expect(summary.sceneCutsDetected).toBeGreaterThanOrEqual(1);
  });
});
