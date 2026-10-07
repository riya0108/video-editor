import { throwIfAborted, AIError } from "../errors";
import { toMono } from "../media";
import { itemId, type AIProvider } from "../provider";
import { marginConfidence, type SilenceItem } from "../types";

/**
 * SILENCE DETECTION — signal processing, no model. RMS level in 20 ms windows; a window is silent when it's below
 * the threshold. The threshold is ADAPTIVE by default: the noise floor (10th percentile of window levels) + 12 dB,
 * capped at -30 dBFS — so a quiet room tone and a noisy street both work — or a fixed dBFS value if given.
 * Silent runs shorter than `minDuration` are ignored; each kept range is shrunk by `padding` on both sides so cuts
 * don't clip word onsets/tails. Confidence = how far below the threshold the range sits (margin).
 */

export interface SilenceParams {
  thresholdDb?: number | "auto";
  minDuration?: number;
  padding?: number;
}

const WINDOW_SEC = 0.02;

export function windowLevelsDb(mono: Float32Array, sampleRate: number, windowSec = WINDOW_SEC): Float32Array {
  const w = Math.max(1, Math.round(sampleRate * windowSec));
  const n = Math.floor(mono.length / w);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * w; k < (i + 1) * w; k++) s += mono[k] * mono[k];
    const rms = Math.sqrt(s / w);
    out[i] = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
  }
  return out;
}

export function adaptiveSilenceThreshold(levels: Float32Array): number {
  if (levels.length === 0) return -40;
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  return Math.min(-30, floor + 12);
}

export function detectSilences(mono: Float32Array, sampleRate: number, params: SilenceParams = {}): { ranges: { start: number; end: number; levelDb: number }[]; thresholdDb: number } {
  const minDuration = params.minDuration ?? 0.5;
  const padding = params.padding ?? 0.05;
  const levels = windowLevelsDb(mono, sampleRate);
  const thresholdDb = params.thresholdDb === undefined || params.thresholdDb === "auto" ? adaptiveSilenceThreshold(levels) : params.thresholdDb;
  const ranges: { start: number; end: number; levelDb: number }[] = [];
  let runStart = -1;
  let sum = 0;
  const flush = (endIdx: number) => {
    const start = runStart * WINDOW_SEC + padding;
    const end = endIdx * WINDOW_SEC - padding;
    if (endIdx - runStart >= Math.round(minDuration / WINDOW_SEC) && end > start) ranges.push({ start: +start.toFixed(3), end: +end.toFixed(3), levelDb: sum / (endIdx - runStart) });
  };
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] < thresholdDb) {
      if (runStart < 0) {
        runStart = i;
        sum = 0;
      }
      sum += levels[i];
    } else if (runStart >= 0) {
      flush(i);
      runStart = -1;
    }
  }
  if (runStart >= 0) flush(levels.length);
  return { ranges, thresholdDb };
}

export const silenceProvider: AIProvider<SilenceParams> = {
  id: "silence.rms",
  feature: "silence-detection",
  label: "Silence detection",
  kind: "signal-processing",
  description: "Finds pauses by RMS level against an adaptive noise-floor threshold. No model.",
  needs: { audio: true },
  availability: () => ({ available: true }),
  async run(req, ctx) {
    if (!req.media.hasAudio) throw new AIError("media-unavailable", "This clip has no audio to analyse.");
    ctx.progress(0.1, "Reading audio");
    const audio = await req.media.audio();
    throwIfAborted(ctx.signal);
    const mono = toMono(audio);
    if (mono.length === 0) throw new AIError("media-unavailable", "The audio is empty.");
    ctx.progress(0.5, "Measuring levels");
    const { ranges, thresholdDb } = detectSilences(mono, audio.sampleRate, req.params);
    const items: SilenceItem[] = ranges.map((r) => ({
      kind: "silence",
      id: itemId("sil"),
      accepted: true,
      start: +(req.media.sourceStart + r.start).toFixed(3),
      end: +(req.media.sourceStart + r.end).toFixed(3),
      levelDb: +r.levelDb.toFixed(1),
      confidence: marginConfidence(thresholdDb - r.levelDb, 0, 12),
    }));
    return {
      items,
      warnings: items.length === 0 ? ["No silence longer than the minimum duration was found."] : [],
      metrics: { audioSeconds: mono.length / audio.sampleRate },
      params: { thresholdDb: +thresholdDb.toFixed(1), minDuration: req.params.minDuration ?? 0.5, padding: req.params.padding ?? 0.05 },
    };
  },
};
