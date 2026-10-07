import { audioSegments, mixTimeline, type PcmSource } from "../audio/engine-core";
import type { TimelineModel } from "../timeline/model";
import type { RenderPlan } from "./plan";

/**
 * AUDIO STAGE (RENDER_ENGINE_ARCHITECTURE.md §6). The existing offline mixer (`mixTimeline`: the same segments,
 * gain envelopes, fades, mute/solo as playback) rendered to EXACTLY the video's duration — frameCount / fps — so the
 * audio track can't run long or short. Strict like the video path: an audible clip whose audio isn't decoded yet is an
 * error, never silently dropped.
 */

export type AudioSourceState = "ready" | "loading" | "no-audio" | "error" | "missing";

export interface RenderedAudio {
  sampleRate: number;
  channels: [Float32Array, Float32Array];
  peak: number;
  /** Samples that were over full scale before the encoder's clamp. */
  clippedSamples: number;
}

/** Problems that must stop a final render (audio still decoding / failed for a clip that should be heard). */
export function audioBlockers(timeline: TimelineModel, plan: Pick<RenderPlan, "durationSec">, state: (sourceId: string) => AudioSourceState): string[] {
  const out = new Set<string>();
  for (const seg of audioSegments(timeline, { fromSec: 0, toSec: plan.durationSec, hasAudio: () => true })) {
    const s = state(seg.sourceId);
    const isAudioClip = seg.clip.content.kind === "audio";
    if (s === "loading") out.add(`Audio for "${label(seg.clip)}" is still decoding — wait for it to finish.`);
    else if (s === "missing" || (s === "error" && isAudioClip)) out.add(`Audio for "${label(seg.clip)}" isn't available (${s}).`);
  }
  return [...out];
}

function label(clip: { id: string; content: { source?: { label?: string } } }): string {
  return clip.content.source?.label ?? clip.id;
}

export function renderAudio(timeline: TimelineModel, getSource: (sourceId: string) => PcmSource | undefined, plan: Pick<RenderPlan, "durationSec" | "audioSamples" | "settings">): RenderedAudio {
  const a = plan.settings.audio;
  if (!a) throw new Error("This render has no audio track.");
  const mix = mixTimeline(timeline, getSource, { sampleRate: a.sampleRate, startSec: 0, endSec: plan.durationSec });
  const [L, R] = mix.channels;
  if (L.length !== plan.audioSamples) throw new Error(`Audio mix is ${L.length} samples, expected ${plan.audioSamples}.`);
  // The encoder takes float PCM; anything over full scale would wrap or distort — clamp, and report it.
  for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i] > 1 ? 1 : ch[i] < -1 ? -1 : ch[i];
  return { sampleRate: a.sampleRate, channels: [L, R], peak: mix.peak, clippedSamples: mix.clippedSamples };
}

/** Planar f32 chunks (L then R) of at most `chunkFrames` samples, with their timestamps in seconds. */
export function* audioChunks(audio: RenderedAudio, chunkFrames = 4800): Generator<{ data: Float32Array; frames: number; timestamp: number }> {
  const [L, R] = audio.channels;
  for (let i = 0; i < L.length; i += chunkFrames) {
    const n = Math.min(chunkFrames, L.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    yield { data, frames: n, timestamp: i / audio.sampleRate };
  }
}
