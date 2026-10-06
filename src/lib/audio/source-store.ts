import { computePeaks, type PcmSource, type WaveformPeaks } from "./engine-core";
import { checkDecodeBudget, decodedBytes, describeAudioDecodeFailure, looksCorruptedDecode, wavTruncation } from "./safety";

/**
 * AUDIO SOURCE STORE (browser). Decodes each source once into PCM (Web Audio
 * AudioBuffer), computes its waveform peaks, and tracks a per-source status the
 * UI shows — so nothing downstream ever has to guess whether audio is there:
 *
 *   loading -> ready            (playable, waveform available)
 *           -> no-audio         (a video without a soundtrack — normal, silent)
 *           -> error            (unsupported codec / corrupted / too long / over budget; message for the user)
 *   missing                     (a loaded project references a source this session doesn't have)
 *
 * Safety: metadata (duration) is read first with a timeout; decoding only starts if the duration cap and the
 * decoded-memory budget allow it; the decode itself also has a timeout.
 */

export type AudioSourceStatus =
  | { state: "loading"; label: string }
  | { state: "ready"; label: string; durationSec: number; sampleRate: number; channels: number; /** Loaded, but the user should know something (e.g. a truncated file plays only the part that exists). */ warning?: string }
  | { state: "no-audio"; label: string }
  | { state: "error"; label: string; reason: string; message: string };

interface Entry {
  status: AudioSourceStatus;
  buffer?: AudioBuffer;
  pcm?: PcmSource;
  peaks?: WaveformPeaks;
}

const METADATA_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Duration from container metadata via a detached media element (no samples decoded). */
function readDuration(url: string, video: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(video ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    const done = () => {
      el.removeAttribute("src");
      el.load();
    };
    el.onloadedmetadata = () => {
      const d = el.duration;
      done();
      resolve(d);
    };
    el.onerror = () => {
      const code = el.error?.code;
      done();
      reject(new Error(code === 4 ? "format not supported (MEDIA_ERR_SRC_NOT_SUPPORTED)" : `media error ${code ?? "unknown"}`));
    };
    el.src = url;
  });
}

export class AudioSourceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private decodeCtx: OfflineAudioContext | null = null;
  /** Decode rate: everything is decoded to one rate so the mixer and playback context agree. */
  readonly sampleRate: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(id: string, e: Entry) {
    this.entries.set(id, e);
    for (const l of this.listeners) l();
  }

  status(sourceId: string): AudioSourceStatus | { state: "missing" } {
    return this.entries.get(sourceId)?.status ?? { state: "missing" };
  }

  buffer(sourceId: string): AudioBuffer | undefined {
    return this.entries.get(sourceId)?.buffer;
  }

  pcm(sourceId: string): PcmSource | undefined {
    return this.entries.get(sourceId)?.pcm;
  }

  peaks(sourceId: string): WaveformPeaks | undefined {
    return this.entries.get(sourceId)?.peaks;
  }

  has(sourceId: string): boolean {
    return this.entries.has(sourceId);
  }

  usedBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.buffer) n += decodedBytes(e.buffer.duration, e.buffer.sampleRate, e.buffer.numberOfChannels);
    return n;
  }

  remove(sourceId: string): void {
    this.entries.delete(sourceId);
    for (const l of this.listeners) l();
  }

  /**
   * Decodes a source. `video` = this is a video's soundtrack: a missing audio track is "no-audio" (silent, not an
   * error). Resolves with the final status; never throws.
   */
  async add(sourceId: string, blobOrUrl: Blob | string, label: string, opts: { video?: boolean } = {}): Promise<AudioSourceStatus> {
    this.set(sourceId, { status: { state: "loading", label } });
    const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    const fail = (reason: string, message: string): AudioSourceStatus => {
      const status: AudioSourceStatus = opts.video ? { state: "no-audio", label } : { state: "error", label, reason, message };
      this.set(sourceId, { status });
      return status;
    };
    try {
      let duration: number;
      try {
        duration = await withTimeout(readDuration(url, !!opts.video), METADATA_TIMEOUT_MS, "Reading metadata");
      } catch (e) {
        const d = describeAudioDecodeFailure(label, e);
        return fail(d.reason, d.message);
      }
      const budget = checkDecodeBudget(label, duration, this.sampleRate, this.usedBytes());
      if (!budget.ok) {
        // A video too long to decode its soundtrack still plays picture — report it either way, as an error.
        const status: AudioSourceStatus = { state: "error", label, reason: budget.reason, message: budget.message };
        this.set(sourceId, { status });
        return status;
      }
      let bytes: ArrayBuffer;
      try {
        bytes = typeof blobOrUrl === "string" ? await (await fetch(blobOrUrl)).arrayBuffer() : await blobOrUrl.arrayBuffer();
      } catch (e) {
        return fail("missing", `${label}: the file couldn't be read (${(e as Error).message}).`);
      }
      // decodeAudioData detaches `bytes`, so inspect the container first.
      const truncation = wavTruncation(bytes);
      this.decodeCtx ??= new OfflineAudioContext(2, 1, this.sampleRate);
      let buffer: AudioBuffer;
      try {
        buffer = await withTimeout(this.decodeCtx.decodeAudioData(bytes), DECODE_TIMEOUT_MS, "Decoding");
      } catch (e) {
        const d = describeAudioDecodeFailure(label, e);
        return fail(d.reason, d.message);
      }
      if (looksCorruptedDecode(buffer.length, buffer.sampleRate, duration)) {
        return fail("corrupted", `${label}: only part of the audio could be decoded — the file looks truncated or damaged.`);
      }
      const pcm: PcmSource = { sampleRate: buffer.sampleRate, channels: Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c)) };
      const status: AudioSourceStatus = { state: "ready", label, durationSec: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
      const cut = truncation;
      if (cut) status.warning = `${label}: the file is truncated — its header says ${cut.declaredSec.toFixed(1)} s but only ${cut.presentSec.toFixed(1)} s of audio is present. Only that part will play; re-export or re-download the file for the rest.`;
      // Peaks are computed in a later task so the "ready" status (and playback) doesn't wait on the waveform.
      this.set(sourceId, { status, buffer, pcm });
      await new Promise((r) => setTimeout(r, 0));
      const entry = this.entries.get(sourceId);
      if (entry?.buffer === buffer) this.set(sourceId, { ...entry, peaks: computePeaks(pcm) });
      return status;
    } finally {
      if (typeof blobOrUrl !== "string") URL.revokeObjectURL(url);
    }
  }
}
