/**
 * SAFE AUDIO INTAKE (AUDIO_ENGINE_ARCHITECTURE.md §6). Pure checks, run
 * before and after decoding, that turn every failure mode into a specific,
 * actionable message instead of a crash, a frozen tab or a silent clip:
 *   - unsupported formats/codecs (allowlist + the decoder's own verdict)
 *   - corrupted files (decode fails / decodes to nothing)
 *   - very long files (duration cap + decoded-memory budget, checked from
 *     metadata BEFORE the full decode allocates anything)
 *   - missing audio (a project references a source this session can't resolve)
 */

/** Decoded PCM is Float32 per channel; a 30-minute stereo 48 kHz file is ~690 MB, so this caps a single source. */
export const MAX_AUDIO_DURATION_SEC = 30 * 60;
/** Compressed file size ceiling (before any decode). */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
/** Total decoded audio the session will hold. */
export const DECODED_MEMORY_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|ogg|oga|opus|flac|webm|aif|aiff|caf)$/i;
/** Formats browsers can't decode (rejected up front with a conversion hint). */
const UNSUPPORTED_EXT = /\.(wma|ra|ram|ape|amr|ac3|dts|mid|midi|mka)$/i;

export type AudioFileCheck = { ok: true } | { ok: false; reason: "unsupported" | "too-large" | "empty"; message: string };

export function isAudioFileName(name: string, type = ""): boolean {
  return type.startsWith("audio/") || AUDIO_EXT.test(name) || UNSUPPORTED_EXT.test(name);
}

/** Checks a picked/dropped audio file before reading it. */
export function checkAudioFile(file: { name: string; type: string; size: number }): AudioFileCheck {
  if (UNSUPPORTED_EXT.test(file.name)) {
    return { ok: false, reason: "unsupported", message: `${file.name}: this audio format can't be decoded in a browser. Convert it to MP3, WAV, M4A (AAC), OGG or FLAC and add that instead.` };
  }
  if (!file.type.startsWith("audio/") && !AUDIO_EXT.test(file.name)) {
    return { ok: false, reason: "unsupported", message: `${file.name}: not a recognized audio file. Supported: MP3, WAV, M4A/AAC, OGG/Opus, FLAC, AIFF.` };
  }
  if (file.size === 0) return { ok: false, reason: "empty", message: `${file.name}: the file is empty.` };
  if (file.size > MAX_AUDIO_BYTES) {
    return { ok: false, reason: "too-large", message: `${file.name}: the file is over ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB. Split or compress it first.` };
  }
  return { ok: true };
}

/** Bytes a decode will allocate (Float32 per channel per sample). */
export function decodedBytes(durationSec: number, sampleRate: number, channels: number): number {
  return Math.ceil(durationSec * sampleRate) * channels * 4;
}

export type DurationCheck = { ok: true } | { ok: false; reason: "too-long" | "over-budget" | "no-duration"; message: string };

/**
 * Decides from METADATA (cheap, no samples decoded) whether decoding is safe: known finite duration, under the cap,
 * and the decoded size fits what's left of the session's memory budget (stereo at the decode rate assumed).
 */
export function checkDecodeBudget(name: string, durationSec: number, decodeSampleRate: number, usedBytes: number): DurationCheck {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, reason: "no-duration", message: `${name}: the file reports no playable duration — it's probably corrupted or truncated.` };
  }
  if (durationSec > MAX_AUDIO_DURATION_SEC) {
    const mins = Math.round(durationSec / 60);
    return { ok: false, reason: "too-long", message: `${name}: ${mins} minutes is longer than the ${MAX_AUDIO_DURATION_SEC / 60}-minute limit for one audio file. Split it into shorter parts (or trim it) and add those.` };
  }
  const need = decodedBytes(durationSec, decodeSampleRate, 2);
  if (usedBytes + need > DECODED_MEMORY_BUDGET_BYTES) {
    return { ok: false, reason: "over-budget", message: `${name}: not enough memory left to load it alongside the audio already in this project (${Math.round(need / 1024 / 1024)} MB needed). Remove unused audio or use shorter files.` };
  }
  return { ok: true };
}

/** The decoder's error, phrased for the user. `kind` distinguishes a video's soundtrack (where "no audio" is normal). */
export function describeAudioDecodeFailure(name: string, error: unknown): { reason: "unsupported-codec" | "corrupted" | "timeout"; message: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed? ?out/i.test(detail)) return { reason: "timeout", message: `${name}: decoding took too long and was stopped. The file may be damaged or extremely large.` };
  if (/EncodingError|Unable to decode|unsupported|codec|not supported/i.test(detail) || (error as { name?: string })?.name === "EncodingError" || (error as { name?: string })?.name === "NotSupportedError") {
    return {
      reason: "unsupported-codec",
      message: `${name}: this browser couldn't decode the audio (${detail}). It may be corrupted, or use a codec your browser lacks (e.g. ALAC, AC-3, WMA) — convert it to MP3, AAC (M4A), WAV or FLAC.`,
    };
  }
  return { reason: "corrupted", message: `${name}: the audio couldn't be read (${detail}). The file looks damaged — re-export or re-download it.` };
}

/** A decoded result that is effectively empty (some corrupt files "decode" to a few silent samples). */
export function looksCorruptedDecode(lengthSamples: number, sampleRate: number, metadataDurationSec: number): boolean {
  const decodedSec = lengthSamples / sampleRate;
  if (lengthSamples === 0) return true;
  // Decoded far shorter than the container claims -> truncated / damaged stream.
  return Number.isFinite(metadataDurationSec) && metadataDurationSec > 1 && decodedSec < metadataDurationSec * 0.5;
}

/**
 * WAV container check: the header's declared data size vs. the bytes actually present. Browsers quietly play a
 * truncated WAV as a shorter file (metadata reports the shorter length too), so this is the only place truncation is
 * visible. Returns null for non-WAV / intact files.
 */
export function wavTruncation(bytes: ArrayBuffer): { declaredSec: number; presentSec: number } | null {
  if (bytes.byteLength < 44) return null;
  const v = new DataView(bytes);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 20 <= bytes.byteLength) byteRate = v.getUint32(o + 16, true);
    if (id === "data") {
      const present = bytes.byteLength - (o + 8);
      // 0 / 0xFFFFFFFF = "unknown length" (streamed WAV), not truncation.
      if (!byteRate || size === 0 || size === 0xffffffff || present >= size) return null;
      return { declaredSec: size / byteRate, presentSec: present / byteRate };
    }
    o += 8 + size + (size % 2);
  }
  return null;
}
