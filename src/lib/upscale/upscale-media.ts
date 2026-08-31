import { fetchFile } from "@ffmpeg/util";
import { ffmpegEngine, FfmpegRunError, runFfmpeg } from "../ffmpeg/engine";
import { guessVideoExtension } from "../ffmpeg/format";
import { waitForSeek } from "../captions/person-cutout";
import { preloadSuperResolutionModel, upscaleImageSource, SR_SCALE, type UpscaleProgress } from "./real-esrgan";

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))), "image/png");
  });
}

/**
 * The SR model always quadruples its input. Requesting anything short of a
 * full 4x (the common case — 1.5x/2x/3x factors, or a resolution target that
 * isn't a 4x jump) by feeding it the full-resolution source anyway means
 * generating detail at 4x scale just to immediately throw most of it away in
 * the final downsample. Pre-shrinking the source so the model's fixed 4x
 * lands close to the actual target instead means the model only ever does
 * (target/4)^2 as much work as an unscaled source would need — e.g. a 2x
 * request runs the model at a quarter of the pixel count.
 */
function planSrInput(srcW: number, srcH: number, targetW: number, targetH: number): { w: number; h: number } {
  const scale = Math.max(targetW / srcW, targetH / srcH);
  if (scale >= SR_SCALE) return { w: srcW, h: srcH };
  return {
    w: Math.max(1, Math.round((srcW * scale) / SR_SCALE)),
    h: Math.max(1, Math.round((srcH * scale) / SR_SCALE)),
  };
}

/** Resizes `source` onto a new canvas at exactly `w`x`h`, using the browser's highest-quality resampling. */
function resizeToCanvas(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/**
 * AI-upscales a single image, then (if the requested target isn't exactly
 * the model's fixed 4x) lanczos-downsamples the AI output to the exact
 * target size — downscaling from a sharper 4x result beats interpolating
 * straight to a non-4x target.
 */
export async function upscaleImageFile(
  file: File,
  targetW: number,
  targetH: number,
  onProgress?: (p: UpscaleProgress) => void,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let canvas: HTMLCanvasElement;
  try {
    const srInput = planSrInput(bitmap.width, bitmap.height, targetW, targetH);
    const source =
      srInput.w === bitmap.width && srInput.h === bitmap.height ? bitmap : resizeToCanvas(bitmap, srInput.w, srInput.h);
    canvas = await upscaleImageSource(source, srInput.w, srInput.h, onProgress);
  } finally {
    bitmap.close();
  }

  if (canvas.width === targetW && canvas.height === targetH) {
    return canvasToPngBlob(canvas);
  }

  const aiBlob = await canvasToPngBlob(canvas);
  const { blob } = await runFfmpeg({
    inputs: [{ name: "ai.png", data: aiBlob }],
    args: ["-i", "ai.png", "-threads", "1", "-vf", `scale=${targetW}:${targetH}:flags=lanczos`, "output.png"],
    outputName: "output.png",
    outputMimeType: "image/png",
  });
  return blob;
}

export interface VideoUpscaleProgress {
  phase: "engine" | "extracting" | "upscaling" | "encoding";
  fraction: number;
  frameIndex?: number;
  frameCount?: number;
}

export type VideoUpscaleQuality = "fast" | "full";

/**
 * AI super-resolution has no shortcut around running the model once per
 * frame produced — unlike a filter-based resize, there's no way to make a
 * single inference call cheaper without changing what it computes. The only
 * lever left for video is computing (and outputting) fewer frames per
 * second in the first place. 15fps keeps motion legible while roughly
 * halving frame count for typical 24-30fps source footage.
 */
const FAST_MODE_MAX_FPS = 15;

const pad6 = (n: number) => String(n).padStart(6, "0");

/** Parses ffprobe's "num/den" (or plain) r_frame_rate string into a number, falling back to 30 for anything unparseable. */
function parseFps(raw: string): number {
  const [numStr, denStr] = raw.split("/");
  const num = Number(numStr);
  const den = denStr ? Number(denStr) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) return 30;
  return num / den;
}

/** Probes the source frame rate via ffmpeg's own demuxer, so the reassembled video matches pacing. Falls back to 30fps if probing fails. */
async function probeFps(ffmpeg: Awaited<ReturnType<typeof ffmpegEngine.load>>, inputName: string): Promise<number> {
  try {
    const code = await ffmpeg.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputName,
      "-o",
      "fps.txt",
    ]);
    if (code !== 0) return 30;
    const raw = new TextDecoder().decode((await ffmpeg.readFile("fps.txt")) as Uint8Array).trim();
    await ffmpeg.deleteFile("fps.txt").catch(() => {});
    return raw ? parseFps(raw) : 30;
  } catch {
    return 30;
  }
}

/**
 * Opens a video for frame-by-frame seek-and-draw sampling via the browser's
 * own `<video>` element and a canvas (rather than ffmpeg's PNG/image2 muxer —
 * ffmpeg.wasm's own PNG output was found to reliably hang mid-command in this
 * app's ffmpeg build, while this reuses the browser's own, typically
 * hardware-accelerated, video decoder instead). Returns metadata plus a
 * `grabFrame` callback rather than decoding every frame up front: holding an
 * entire video's worth of full-resolution canvases in memory at once (a
 * multi-second/high-fps clip easily means hundreds of them) was found to
 * reliably crash the tab — Chrome discards an over-budget renderer and
 * reloads it, which silently wipes all in-page state back to the empty
 * upload screen, with no error ever surfacing to the user. Callers must
 * `close()` when done.
 */
async function openVideoFrameSource(file: File): Promise<{
  width: number;
  height: number;
  duration: number;
  grabFrame: (t: number) => Promise<HTMLCanvasElement>;
  close: () => void;
}> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Couldn't read this video"));
  });

  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration || 0;
  if (width <= 0 || height <= 0 || duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error("Couldn't read this video's dimensions");
  }

  const grabFrame = async (t: number): Promise<HTMLCanvasElement> => {
    video.currentTime = Math.min(duration - 1e-3, t);
    await waitForSeek(video);
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameCanvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
    return frameCanvas;
  };

  return { width, height, duration, grabFrame, close: () => URL.revokeObjectURL(url) };
}

/**
 * AI-upscales a video: decodes frames via the browser's video element (at a
 * capped rate in "fast" quality, the source's native rate in "full"), runs
 * each one through the neural super-resolution model, then hands the
 * upscaled frame sequence to ffmpeg to re-mux into a video — at whatever
 * rate was processed — with the original audio track. Client-side and
 * frame-by-frame, so it's meaningfully slower than the old filter-based
 * resize; there's no way to make a single inference call cheaper, only fewer
 * of them.
 */
export async function upscaleVideoFile(
  file: File,
  targetW: number,
  targetH: number,
  quality: VideoUpscaleQuality,
  onProgress?: (p: VideoUpscaleProgress) => void,
): Promise<Blob> {
  // The model and the ffmpeg engine download in parallel; report one blended
  // "engine" fraction rather than two independent phases racing each other
  // and making the progress bar jump around.
  let modelFraction = 0;
  let engineFraction = 0;
  const reportCombined = () => onProgress?.({ phase: "engine", fraction: (modelFraction + engineFraction) / 2 });

  await Promise.all([
    preloadSuperResolutionModel((p) => {
      modelFraction = p.fraction;
      reportCombined();
    }),
    ffmpegEngine.load((f) => {
      engineFraction = f;
      reportCombined();
    }),
  ]);

  return ffmpegEngine.exclusive(async (ffmpeg) => {
    const ext = guessVideoExtension(file);
    const inputName = `input.${ext}`;
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    const sourceFps = await probeFps(ffmpeg, inputName);
    const fps = quality === "fast" ? Math.min(sourceFps, FAST_MODE_MAX_FPS) : sourceFps;

    onProgress?.({ phase: "extracting", fraction: 0 });
    const videoSource = await openVideoFrameSource(file);
    const frameCount = Math.max(1, Math.round(videoSource.duration * fps));

    // Same reasoning as the image path: don't pay for 4x-worth of AI detail
    // on every frame when the requested scale is smaller than that.
    const srInput = planSrInput(videoSource.width, videoSource.height, targetW, targetH);
    const shrink = srInput.w !== videoSource.width || srInput.h !== videoSource.height;

    await ffmpeg.createDir("out").catch(() => {});

    try {
      // Decode, shrink, and AI-upscale one frame at a time rather than
      // decoding the whole clip up front — see openVideoFrameSource's doc
      // comment for why holding every frame in memory at once isn't safe.
      for (let i = 0; i < frameCount; i++) {
        const frame = await videoSource.grabFrame(i / fps);
        const source = shrink ? resizeToCanvas(frame, srInput.w, srInput.h) : frame;
        const canvas = await upscaleImageSource(source, srInput.w, srInput.h);
        const outBytes = new Uint8Array(await (await canvasToPngBlob(canvas)).arrayBuffer());
        await ffmpeg.writeFile(`out/f_${pad6(i + 1)}.png`, outBytes);

        onProgress?.({
          phase: "upscaling",
          fraction: (i + 1) / frameCount,
          frameIndex: i + 1,
          frameCount,
        });
      }
    } finally {
      videoSource.close();
    }

    onProgress?.({ phase: "encoding", fraction: 0 });
    const exitCode = await ffmpeg.exec([
      "-framerate",
      String(fps),
      "-i",
      "out/f_%06d.png",
      "-i",
      inputName,
      "-map",
      "0:v",
      "-map",
      "1:a?",
      "-vf",
      `scale=${targetW}:${targetH}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-shortest",
      "output.mp4",
    ]);
    if (exitCode !== 0) {
      throw new FfmpegRunError(`ffmpeg exited with code ${exitCode}`, "");
    }

    const output = (await ffmpeg.readFile("output.mp4")) as Uint8Array;
    const blob = new Blob([output.slice().buffer], { type: "video/mp4" });

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile("output.mp4").catch(() => {});
    for (let i = 0; i < frameCount; i++) {
      await ffmpeg.deleteFile(`out/f_${pad6(i + 1)}.png`).catch(() => {});
    }
    await ffmpeg.deleteDir("out").catch(() => {});

    onProgress?.({ phase: "encoding", fraction: 1 });
    return blob;
  });
}
