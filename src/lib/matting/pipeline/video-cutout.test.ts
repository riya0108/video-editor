import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSubjectCutoutsViaMatting } from "./video-cutout";
import { sampleTrimmedFrames } from "../../captions/person-cutout";
import { removeBackgroundFromImage } from "./remove-background";

/**
 * PRODUCTION READINESS (H3): the shipped video AI-cutout path had zero
 * dedicated test coverage before this file — unlike the image path
 * (remove-background.adversarial.test.ts), which mocks exactly its DOM
 * boundary. Same approach here: `sampleTrimmedFrames` (the real DOM/video
 * frame-sampling loop) and `removeBackgroundFromImage` (the real matting
 * pipeline) are mocked at the module boundary, so this file tests
 * `generateSubjectCutoutsViaMatting`'s OWN orchestration logic — the part
 * that's actually unique to the video path — for real.
 */

vi.mock("../../captions/person-cutout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../captions/person-cutout")>();
  return { ...actual, sampleTrimmedFrames: vi.fn() };
});

vi.mock("./remove-background", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remove-background")>();
  return { ...actual, removeBackgroundFromImage: vi.fn() };
});

type ProduceBlob = (canvas: HTMLCanvasElement, index: number) => Promise<Blob | null>;

function fakeCanvasWithBlob(blob: Blob | null): HTMLCanvasElement {
  return {
    width: 320,
    height: 180,
    toBlob: (cb: (b: Blob | null) => void) => cb(blob),
  } as unknown as HTMLCanvasElement;
}

const sampleTrimmedFramesMock = vi.mocked(sampleTrimmedFrames);
const removeBackgroundFromImageMock = vi.mocked(removeBackgroundFromImage);

beforeEach(() => {
  sampleTrimmedFramesMock.mockReset();
  removeBackgroundFromImageMock.mockReset();
});

describe("generateSubjectCutoutsViaMatting", () => {
  it("forwards start/end/onProgress/signal straight through to sampleTrimmedFrames", async () => {
    sampleTrimmedFramesMock.mockResolvedValue([]);
    const onProgress = vi.fn();
    const controller = new AbortController();
    const video = {} as HTMLVideoElement;

    await generateSubjectCutoutsViaMatting(video, { start: 1, end: 5, onProgress, signal: controller.signal });

    expect(sampleTrimmedFramesMock).toHaveBeenCalledTimes(1);
    const call = sampleTrimmedFramesMock.mock.calls[0][1];
    expect(call.start).toBe(1);
    expect(call.end).toBe(5);
    expect(call.onProgress).toBe(onProgress);
    expect(call.signal).toBe(controller.signal);
  });

  it("produceBlob runs the real matting pipeline on the sampled frame and converts its foreground canvas to a PNG blob", async () => {
    sampleTrimmedFramesMock.mockImplementation(async (_video, opts) => {
      const produceBlob = opts.produceBlob as ProduceBlob;
      await produceBlob(fakeCanvasWithBlob(new Blob(["frame"])), 0);
      return [];
    });
    const expectedBlob = new Blob(["png-bytes"], { type: "image/png" });
    removeBackgroundFromImageMock.mockResolvedValue({
      foreground: fakeCanvasWithBlob(expectedBlob),
    } as Awaited<ReturnType<typeof removeBackgroundFromImage>>);

    await generateSubjectCutoutsViaMatting({} as HTMLVideoElement, { start: 0, end: 1 });

    expect(removeBackgroundFromImageMock).toHaveBeenCalledTimes(1);
    const [source, width, height] = removeBackgroundFromImageMock.mock.calls[0];
    expect(width).toBe(320);
    expect(height).toBe(180);
    expect(source).toBeTruthy();
  });

  it("a single frame's matting failure is swallowed (returns null) instead of throwing and aborting the whole batch", async () => {
    sampleTrimmedFramesMock.mockImplementation(async (_video, opts) => {
      const produceBlob = opts.produceBlob as ProduceBlob;
      const result = await produceBlob(fakeCanvasWithBlob(new Blob(["frame"])), 0);
      expect(result).toBeNull();
      return [];
    });
    removeBackgroundFromImageMock.mockRejectedValue(new Error("NO_SUBJECT"));

    await expect(generateSubjectCutoutsViaMatting({} as HTMLVideoElement, { start: 0, end: 1 })).resolves.toEqual([]);
  });

  it("forwards model-load progress through onProgress as a 'downloading' phase", async () => {
    const onProgress = vi.fn();
    sampleTrimmedFramesMock.mockImplementation(async (_video, opts) => {
      const produceBlob = opts.produceBlob as ProduceBlob;
      await produceBlob(fakeCanvasWithBlob(new Blob(["frame"])), 0);
      return [];
    });
    removeBackgroundFromImageMock.mockImplementation(async (_source, _w, _h, options) => {
      options?.onModelLoadProgress?.(0.5);
      return { foreground: fakeCanvasWithBlob(new Blob(["png"])) } as Awaited<ReturnType<typeof removeBackgroundFromImage>>;
    });

    await generateSubjectCutoutsViaMatting({} as HTMLVideoElement, { start: 0, end: 1, onProgress });

    expect(onProgress).toHaveBeenCalledWith({ phase: "downloading", fraction: 0.5 });
  });
});
