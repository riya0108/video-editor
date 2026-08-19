import type { RawImage } from "@huggingface/transformers";

/** Portrait/human matting model — outputs a single alpha mask isolating the person from the background. */
export const PERSON_SEGMENTATION_MODEL = "briaai/RMBG-1.4";

export interface CutoutFrame {
  /** Seconds from the start of the video (not the trim). */
  time: number;
  blob: Blob;
  url: string;
}

export interface CutoutProgress {
  phase: "downloading" | "processing";
  /** 0–1 */
  fraction: number;
}

export type Segmenter = (
  image: unknown,
) => Promise<{ mask: RawImage; label: string | null; score: number | null }[]>;

let cachedSegmenter: Promise<Segmenter> | null = null;

/** Shared with other tools (e.g. passerby-track.ts) so the ~44MB RMBG-1.4 model is only ever downloaded once. */
export async function loadSegmenter(onProgress?: (p: CutoutProgress) => void): Promise<Segmenter> {
  if (cachedSegmenter) return cachedSegmenter;
  const { pipeline } = await import("@huggingface/transformers");
  const promise = pipeline("image-segmentation", PERSON_SEGMENTATION_MODEL, {
    dtype: "fp32",
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === "progress_total" && typeof info.progress === "number") {
        onProgress?.({ phase: "downloading", fraction: info.progress / 100 });
      }
    },
  }) as unknown as Promise<Segmenter>;
  promise.catch(() => {
    if (cachedSegmenter === promise) cachedSegmenter = null;
  });
  cachedSegmenter = promise;
  return promise;
}

// Running a segmentation model on every frame of a real video, in-browser,
// would take minutes even for short clips — these bounds keep total inference
// calls (and therefore processing time) reasonable at the cost of some motion
// smoothness in the cutout layer, which ffmpeg later samples on/off with
// `enable=between(...)` the same way the rest of this app chains drawtext.
const MAX_FRAMES = 90;
const MIN_SAMPLE_FPS = 2;
const MAX_SAMPLE_FPS = 8;
const MAX_CUTOUT_WIDTH = 640;

export function pickCutoutSampleFps(durationSeconds: number): number {
  if (durationSeconds <= 0) return MAX_SAMPLE_FPS;
  const fps = MAX_FRAMES / durationSeconds;
  return Math.min(MAX_SAMPLE_FPS, Math.max(MIN_SAMPLE_FPS, fps));
}

export function waitForSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
  });
}

/**
 * Samples the trimmed range of `video` at a reduced fps, and for each sample
 * runs an in-browser person-segmentation model to cut the person out onto a
 * transparent background. Used both for the live "behind a person" caption
 * preview (nearest-sample lookup) and, at export time, as a chain of overlay
 * images ffmpeg composites on top of the drawn caption text so it reads as
 * sitting behind the person.
 */
export async function generatePersonCutouts(
  video: HTMLVideoElement,
  { start, end, onProgress }: { start: number; end: number; onProgress?: (p: CutoutProgress) => void },
): Promise<CutoutFrame[]> {
  const duration = Math.max(0, end - start);
  if (duration <= 0 || video.videoWidth === 0) return [];

  const [segmenter, { RawImage }] = await Promise.all([
    loadSegmenter(onProgress),
    import("@huggingface/transformers"),
  ]);

  const naturalW = video.videoWidth;
  const naturalH = video.videoHeight;
  const scale = Math.min(1, MAX_CUTOUT_WIDTH / naturalW);
  const outW = Math.max(2, Math.round((naturalW * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((naturalH * scale) / 2) * 2);

  const fps = pickCutoutSampleFps(duration);
  const step = 1 / fps;
  const times: number[] = [];
  for (let t = start; t < end; t += step) times.push(t);
  if (times.length === 0) times.push(start);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();

  const frames: CutoutFrame[] = [];
  try {
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      video.currentTime = t;
      await waitForSeek(video);
      ctx.drawImage(video, 0, 0, outW, outH);

      const output = await segmenter(canvas);
      let mask = output[0]?.mask;
      if (!mask) {
        onProgress?.({ phase: "processing", fraction: (i + 1) / times.length });
        continue;
      }
      if (mask.width !== outW || mask.height !== outH) {
        mask = await mask.resize(outW, outH);
      }
      mask.grayscale();

      const cutout = RawImage.fromCanvas(canvas).clone().rgba();
      cutout.putAlpha(mask);
      const blob = (await cutout.toBlob("image/png")) as Blob;
      frames.push({ time: t, blob, url: URL.createObjectURL(blob) });

      onProgress?.({ phase: "processing", fraction: (i + 1) / times.length });
    }
  } finally {
    video.currentTime = originalTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  return frames;
}

export function revokeCutoutFrames(frames: CutoutFrame[]) {
  for (const f of frames) URL.revokeObjectURL(f.url);
}

/** Picks the sampled cutout frame closest in time — used for the live preview, which can't afford one inference per rendered frame. */
export function nearestCutoutFrame(frames: CutoutFrame[], time: number): CutoutFrame | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDist = Math.abs(frames[0].time - time);
  for (const f of frames) {
    const dist = Math.abs(f.time - time);
    if (dist < bestDist) {
      best = f;
      bestDist = dist;
    }
  }
  return best;
}
