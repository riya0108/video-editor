import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export type EngineLoadListener = (fraction: number) => void;
export type RunProgressListener = (fraction: number) => void;

async function blobURLWithProgress(
  url: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.body) {
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(received / total);
  }

  const blob = new Blob(chunks as BlobPart[], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Lazily loads a single shared FFmpeg (wasm, multithreaded) instance.
 * The ~32MB core is only fetched the first time a tool actually needs it.
 */
class FfmpegEngine {
  private ffmpeg: FFmpeg | null = null;
  private loadingPromise: Promise<FFmpeg> | null = null;

  isReady() {
    return !!this.ffmpeg?.loaded;
  }

  async load(onProgress?: EngineLoadListener): Promise<FFmpeg> {
    if (this.ffmpeg?.loaded) return this.ffmpeg;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const baseURL = "/ffmpeg";

      const [coreURL, wasmURL, workerURL] = await Promise.all([
        blobURLWithProgress(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        blobURLWithProgress(`${baseURL}/ffmpeg-core.wasm`, "application/wasm", onProgress),
        blobURLWithProgress(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
      ]);

      await ffmpeg.load({ coreURL, wasmURL, workerURL });
      onProgress?.(1);
      this.ffmpeg = ffmpeg;
      return ffmpeg;
    })().catch((error) => {
      this.loadingPromise = null;
      throw error;
    });

    return this.loadingPromise;
  }
}

export const ffmpegEngine = new FfmpegEngine();

export interface RunOptions {
  /** Input files to stage into ffmpeg's virtual filesystem before running. */
  inputs: { name: string; data: File | Blob | string }[];
  /** Full ffmpeg CLI args, e.g. ["-i", "in.mp4", "-ss", "1", "out.mp4"]. */
  args: string[];
  /** Virtual FS filename ffmpeg will write the result to. */
  outputName: string;
  outputMimeType: string;
  onEngineLoad?: EngineLoadListener;
  onRunProgress?: RunProgressListener;
}

export interface RunResult {
  blob: Blob;
  url: string;
}

/** Thrown when an ffmpeg command fails — carries the tail of ffmpeg's own log for diagnosis. */
export class FfmpegRunError extends Error {
  logTail: string;
  constructor(message: string, logTail: string) {
    super(message);
    this.name = "FfmpegRunError";
    this.logTail = logTail;
  }
}

/**
 * Runs a single ffmpeg command end to end: loads the engine if needed,
 * stages inputs, executes, reads the output, and cleans up the virtual FS.
 */
export async function runFfmpeg({
  inputs,
  args,
  outputName,
  outputMimeType,
  onEngineLoad,
  onRunProgress,
}: RunOptions): Promise<RunResult> {
  const ffmpeg = await ffmpegEngine.load(onEngineLoad);

  const progressHandler = ({ progress }: { progress: number }) => {
    onRunProgress?.(Math.min(1, Math.max(0, progress)));
  };
  if (onRunProgress) ffmpeg.on("progress", progressHandler);

  const recentLogs: string[] = [];
  const logHandler = ({ message }: { message: string }) => {
    recentLogs.push(message);
    if (recentLogs.length > 40) recentLogs.shift();
  };
  ffmpeg.on("log", logHandler);

  const written: string[] = [];
  try {
    for (const input of inputs) {
      const data = typeof input.data === "string" ? input.data : await fetchFile(input.data);
      await ffmpeg.writeFile(input.name, data);
      written.push(input.name);
    }

    await ffmpeg.exec(args);

    let output: Awaited<ReturnType<typeof ffmpeg.readFile>>;
    try {
      output = await ffmpeg.readFile(outputName);
    } catch {
      throw new FfmpegRunError("ffmpeg did not produce an output file", recentLogs.join("\n"));
    }
    const bytes = output as Uint8Array;
    const blob = new Blob([bytes.slice().buffer], { type: outputMimeType });
    const url = URL.createObjectURL(blob);

    return { blob, url };
  } finally {
    if (onRunProgress) ffmpeg.off("progress", progressHandler);
    ffmpeg.off("log", logHandler);
    for (const name of written) {
      await ffmpeg.deleteFile(name).catch(() => {});
    }
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
