import { clipTimelineEnd, isTrimmableContent } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { moveClip, splitClip, trimClip } from "../timeline/operations";
import { frameCount, resampleLinear, stftRange, yieldToUi } from "./dsp";

/**
 * BEAT DETECTION + BEAT SYNC — classical signal processing (no model):
 *
 *   onset envelope   log-magnitude spectral flux (22.05 kHz, 1024-point FFT, ~23 ms hop)
 *   tempo            autocorrelation of the envelope over 60–180 BPM, weighted toward ~120 BPM (resolves the usual
 *                    double/half-tempo ambiguity the way listeners do)
 *   beats            dynamic-programming beat tracker (Ellis 2007): beats land on strong onsets while keeping the
 *                    found period
 *
 * Beat-sync edits are ordinary splits/trims/moves (one undo step).
 */

const SR = 22050;
const N_FFT = 1024;
const HOP = 512;
const FRAME_SEC = HOP / SR;

export interface BeatAnalysis {
  bpm: number;
  /** Beat times, seconds from the start of the analysed audio. */
  beats: number[];
  /** 0..1 — how periodic the onsets are (low for speech or rubato). */
  confidence: number;
}

export async function onsetEnvelope(mono: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<Float32Array> {
  const x = resampleLinear(mono, sampleRate, SR);
  const frames = frameCount(x.length, HOP);
  const bins = N_FFT / 2 + 1;
  const env = new Float32Array(frames);
  let prev = new Float32Array(bins);
  for (let t0 = 0; t0 < frames; t0 += 1024) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const s = stftRange(x, N_FFT, HOP, t0, Math.min(frames, t0 + 1024));
    for (let f = 0; f < s.frames; f++) {
      const cur = new Float32Array(bins);
      let flux = 0;
      for (let k = 1; k < bins; k++) {
        cur[k] = Math.log1p(100 * Math.hypot(s.re[f * bins + k], s.im[f * bins + k]));
        const d = cur[k] - prev[k];
        if (d > 0) flux += d;
      }
      env[t0 + f] = flux;
      prev = cur;
    }
    await yieldToUi();
  }
  // Remove the slow trend (local mean over ~1 s) and half-wave rectify.
  const w = Math.round(1 / FRAME_SEC);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    out[i] = Math.max(0, env[i] - acc / Math.min(i + 1, w));
  }
  let max = 0;
  for (const v of out) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < frames; i++) out[i] /= max;
  return out;
}

export function estimateTempo(env: Float32Array): { period: number; bpm: number; confidence: number } {
  const minLag = Math.round(60 / 180 / FRAME_SEC);
  const maxLag = Math.round(60 / 60 / FRAME_SEC);
  let best = minLag;
  let bestScore = -Infinity;
  let mean = 0;
  for (const v of env) mean += v / env.length;
  let energy = 0;
  for (const v of env) energy += (v - mean) ** 2;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += (env[i] - mean) * (env[i - lag] - mean);
    const bpm = 60 / (lag * FRAME_SEC);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (s / Math.max(1e-9, energy)) * prior;
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement of the peak lag.
  const i = best - minLag;
  const a = scores[i - 1] ?? scores[i];
  const c = scores[i + 1] ?? scores[i];
  const denom = a - 2 * scores[i] + c;
  const period = denom !== 0 ? best + (0.5 * (a - c)) / denom : best;
  return { period, bpm: 60 / (period * FRAME_SEC), confidence: Math.max(0, Math.min(1, bestScore * 3)) };
}

/** Ellis-style DP beat tracking on the onset envelope; returns beat frame indices. */
export function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (n === 0) return [];
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = 0;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (bestPrev < 0 || v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = env[t] + (bestPrev >= 0 ? bestVal : 0);
    back[t] = bestPrev;
  }
  // Start the backtrace at the best-scoring frame within the last period.
  let t = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t];
  }
  return beats.reverse();
}

export async function detectBeats(mono: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<BeatAnalysis> {
  const env = await onsetEnvelope(mono, sampleRate, signal);
  const { period, bpm, confidence } = estimateTempo(env);
  const beats = trackBeats(env, period).map((f) => +(f * FRAME_SEC).toFixed(3));
  return { bpm: Math.round(bpm * 10) / 10, beats, confidence };
}

// ---------------------------------------------------------------------------
// Beat-sync timeline edits
// ---------------------------------------------------------------------------

/** Beat times (seconds of a clip's SOURCE) -> timeline frames inside that clip's current span. */
export function beatsOnTimeline(timeline: TimelineModel, clipId: string, beatsSourceSec: number[]): number[] {
  const clip = timeline.clips[clipId];
  if (!clip || !isTrimmableContent(clip.content)) return [];
  const fps = timeline.frameRate;
  const inF = clip.content.sourceInFrame;
  const end = clipTimelineEnd(clip);
  return beatsSourceSec.map((s) => clip.timelineStart + Math.round(s * fps) - inF).filter((f) => f > clip.timelineStart && f < end);
}

/** Splits every clip on `trackId` at every `every`-th beat it spans. Returns how many cuts were made. */
export function splitOnBeats(timeline: TimelineModel, trackId: string, beatFrames: number[], every = 1): { timeline: TimelineModel; cuts: number } {
  let tl = timeline;
  let cuts = 0;
  const frames = beatFrames.filter((_, i) => i % Math.max(1, every) === 0);
  for (const f of frames) {
    const piece = tl.tracks[trackId]?.clipIds.map((id) => tl.clips[id]).find((c) => c.timelineStart < f && clipTimelineEnd(c) > f);
    if (!piece) continue;
    tl = splitClip(tl, piece.id, f).timeline;
    cuts++;
  }
  return { timeline: tl, cuts };
}

/**
 * Makes every cut between consecutive clips on `trackId` land on a beat: each clip is shortened to end on the last
 * beat at or before its current end (never below `minFrames`), and everything after it on the track moves up so
 * the sequence stays gapless. Returns how many cuts moved.
 */
export function snapCutsToBeats(timeline: TimelineModel, trackId: string, beatFrames: number[], minFrames: number): { timeline: TimelineModel; snapped: number } {
  let tl = timeline;
  let snapped = 0;
  const ids = () => tl.tracks[trackId].clipIds.map((id) => tl.clips[id]).sort((a, b) => a.timelineStart - b.timelineStart);
  const sortedBeats = [...beatFrames].sort((a, b) => a - b);
  for (let i = 0; i < ids().length - 1; i++) {
    const list = ids();
    const clip = list[i];
    const next = list[i + 1];
    const end = clipTimelineEnd(clip);
    if (next.timelineStart !== end) continue; // only cuts (adjacent clips), not gaps
    let target = -1;
    for (const b of sortedBeats) if (b <= end && b - clip.timelineStart >= minFrames) target = b;
    if (target < 0 || target === end) continue;
    const delta = end - target;
    tl = trimClip(tl, clip.id, "end", target);
    for (const c of ids().slice(i + 1)) tl = moveClip(tl, c.id, c.timelineStart - delta);
    snapped++;
  }
  return { timeline: tl, snapped };
}
