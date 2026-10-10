import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from "mediabunny";

/**
 * WHERE AN EXPORT IS WRITTEN (RELEASE_CANDIDATE_REPORT.md, P1-2). The encoded file used to be built in memory
 * (BufferTarget), then copied into a Blob: a 10-minute 1080p export peaked at ~2.3 GB of JS heap (≈3.8× the file), so
 * ~30 minutes would exhaust a tab. Now the muxer streams into a file in the Origin Private File System — browser-private
 * disk storage, no permission prompt — and the result is that file (a disk-backed Blob): memory no longer grows with
 * the export's length. Validation reads it back from disk; Download hands the browser the same disk-backed Blob.
 *
 * Each sink's file lives until `release()` (the export list calls it when the job is removed). Files left by an earlier
 * page session can't be referenced by anything any more and are deleted at the next export.
 * Without OPFS (very old browsers, some private modes) it falls back to the in-memory target.
 */

export interface OutputSink {
  target: Target;
  /** "disk" = streamed to a private file; "memory" = in-memory fallback. */
  kind: "disk" | "memory";
  /** The finished file, after the Output has been finalized. */
  finish(mimeType: string): Promise<Blob>;
  /** Deletes the file (after a failed/cancelled export, or when the user removes the finished job). Idempotent. */
  release(): Promise<void>;
}

const DIR = "clipbench-exports";
/** Files this page session created — the only ones anything can still reference. */
const live = new Set<string>();
let swept = false;

async function exportsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

/** Deletes export files left by earlier page sessions (nothing can hold a reference to them any more). */
async function sweepStale(dir: FileSystemDirectoryHandle) {
  if (swept) return;
  swept = true;
  const names: string[] = [];
  for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (!live.has(name)) names.push(name);
  for (const n of names) await dir.removeEntry(n).catch(() => {});
}

export async function createOutputSink(extension: string): Promise<OutputSink> {
  const dir = await exportsDir();
  let writable: FileSystemWritableFileStream | null = null;
  let handle: FileSystemFileHandle | null = null;
  const name = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  if (dir) {
    try {
      await sweepStale(dir);
      handle = await dir.getFileHandle(name, { create: true });
      writable = await handle.createWritable();
      live.add(name);
    } catch {
      handle = null;
      writable = null;
    }
  }
  if (!dir || !handle || !writable) {
    const target = new BufferTarget();
    return {
      target,
      kind: "memory",
      finish: async (type) => new Blob(target.buffer ? [target.buffer] : [], { type }),
      release: async () => {},
    };
  }

  const file = writable;
  let released = false;
  const stream = new WritableStream<StreamTargetChunk>({
    // Positioned writes: MP4/MOV "reserve" fast start and WebM both go back to fill in sizes and the index.
    write: (chunk) => file.write({ type: "write", position: chunk.position, data: chunk.data }),
    close: () => file.close(),
    abort: () => file.abort(),
  });
  const release = async () => {
    if (released) return;
    released = true;
    live.delete(name);
    await file.abort().catch(() => {}); // no-op once closed
    await dir.removeEntry(name).catch(() => {});
  };
  return {
    target: new StreamTarget(stream, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
    kind: "disk",
    // A Blob wrapping the on-disk File is a reference, not a copy — it only adds the MIME type.
    finish: async (type) => new Blob([await handle!.getFile()], { type }),
    release,
  };
}

/**
 * Upper bounds on packet counts for MP4/MOV "reserve" fast start (the muxer reserves room for the index up front).
 * Video: one packet per frame. Audio: one per codec frame (AAC 1024 samples, Opus 20 ms), plus priming/padding packets,
 * with a third spare as Mediabunny recommends.
 */
export function maxPacketCounts(frameCount: number, durationSec: number, audio: { codec: "aac" | "opus"; sampleRate: number } | null) {
  const video = frameCount + 8;
  const audioPackets = audio ? Math.ceil(((durationSec * audio.sampleRate) / (audio.codec === "aac" ? 1024 : 960)) * 1.33) + 32 : 0;
  return { video, audio: audioPackets };
}
