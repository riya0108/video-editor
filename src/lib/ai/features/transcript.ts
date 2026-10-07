import { AIError, throwIfAborted } from "../errors";
import { resampleMono, toMono } from "../media";
import type { AIRequest, AIRunContext, TranscriptWord } from "../provider";

/**
 * Shared transcript for transcript-driven features (fillers, B-roll). Runs the injected speech-to-text service (the
 * app's in-browser Whisper) once per clip span and caches it, so asking for fillers and then B-roll on the same
 * clip transcribes once. Word times come back in SOURCE seconds.
 */
const cache = new Map<string, TranscriptWord[]>();

export function clearTranscriptCache(): void {
  cache.clear();
}

export async function clipTranscript(req: AIRequest<unknown>, ctx: AIRunContext, from = 0, to = 0.8): Promise<TranscriptWord[]> {
  const key = `${req.sourceId}@${req.media.sourceStart.toFixed(3)}-${req.media.sourceEnd.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!ctx.services.transcribe) throw new AIError("provider-unavailable", "No speech-to-text service is connected.");
  if (!req.media.hasAudio) throw new AIError("media-unavailable", "This clip has no audio.");
  ctx.progress(from, "Reading audio");
  const audio = await req.media.audio();
  throwIfAborted(ctx.signal);
  const pcm = resampleMono(toMono(audio), audio.sampleRate, 16000);
  if (pcm.length < 16000 * 0.5) throw new AIError("invalid-input", "The clip's audio is too short to transcribe.");
  ctx.progress(from + 0.05, "Transcribing speech");
  let words: TranscriptWord[];
  try {
    words = await ctx.services.transcribe(pcm, (f) => ctx.progress(from + 0.05 + (to - from - 0.05) * f, "Transcribing speech"));
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new AIError("model-load-failed", `Speech-to-text failed: ${(e as Error).message}`, e);
  }
  throwIfAborted(ctx.signal);
  const shifted = words.map((w) => ({ text: w.text, start: +(req.media.sourceStart + w.start).toFixed(3), end: +(req.media.sourceStart + w.end).toFixed(3) }));
  cache.set(key, shifted);
  return shifted;
}

/** Lowercase word without surrounding punctuation. */
export function bare(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .trim();
}
