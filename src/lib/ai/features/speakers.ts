import { AIError, throwIfAborted } from "../errors";
import { resampleMono, toMono } from "../media";
import { itemId, type AIProvider } from "../provider";
import { conf, type SpeakerTurnItem } from "../types";

/**
 * SPEAKER DETECTION — classical signal processing (unsupervised diarization baseline). There is NO neural
 * diarization/speaker-embedding model in this app; this is the textbook pre-neural pipeline, and its accuracy is
 * measured in the test report rather than assumed:
 *
 *   16 kHz mono -> 25 ms frames (10 ms hop), pre-emphasis, Hamming, FFT -> 26 mel bands -> log -> DCT -> MFCC 1..12
 *   -> energy voice-activity detection + autocorrelation pitch -> 2 s windows (0.5 s hop) described by their mean
 *   voiced MFCCs and median pitch -> average-linkage agglomerative clustering on a timbre+pitch distance (one octave
 *   = 16 MFCC-RMS units; stop at `threshold` 7, or at `speakers` clusters when the count is known; both calibrated
 *   on real recorded voices, see the test report) -> median smoothing -> turns, whose boundaries are refined to the
 *   nearest pause (or the best frame-level change point).
 *
 * Works when voices differ clearly (different pitch/timbre) and turns last a few seconds; overlapping speech, very
 * short interjections and similar voices (e.g. two men of similar pitch) are its weak spot. Confidence per turn = mean silhouette-style margin
 * ((b - a) / max(a, b): own cluster vs nearest other) of its windows.
 */

export interface SpeakerParams {
  /** Known speaker count (2..8); omit to estimate. */
  speakers?: number;
  /** Merge threshold for automatic counting (cosine distance). */
  threshold?: number;
  minTurn?: number;
}

const SR = 16000;
const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const NFFT = 512;
const NMEL = 26;
const NCEP = 12;

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

function melFilterbank(): Float64Array[] {
  const lo = hz2mel(80);
  const hi = hz2mel(7600);
  const pts = Array.from({ length: NMEL + 2 }, (_, i) => Math.floor(((NFFT + 1) * mel2hz(lo + ((hi - lo) * i) / (NMEL + 1))) / SR));
  return Array.from({ length: NMEL }, (_, m) => {
    const f = new Float64Array(NFFT / 2 + 1);
    for (let k = pts[m]; k < pts[m + 1]; k++) f[k] = (k - pts[m]) / Math.max(1, pts[m + 1] - pts[m]);
    for (let k = pts[m + 1]; k < pts[m + 2]; k++) f[k] = (pts[m + 2] - k) / Math.max(1, pts[m + 2] - pts[m + 1]);
    return f;
  });
}

/** MFCC 1..NCEP per frame plus log energy (dB). */
export function mfcc(x16k: Float32Array): { ceps: Float32Array[]; energyDb: Float32Array } {
  const bank = melFilterbank();
  const n = Math.max(0, Math.floor((x16k.length - FRAME) / HOP) + 1);
  const ceps: Float32Array[] = [];
  const energyDb = new Float32Array(n);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const logmel = new Float64Array(NMEL);
  for (let f = 0; f < n; f++) {
    re.fill(0);
    im.fill(0);
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = x16k[f * HOP + i] - 0.97 * (f * HOP + i > 0 ? x16k[f * HOP + i - 1] : 0);
      re[i] = s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
      e += x16k[f * HOP + i] ** 2;
    }
    energyDb[f] = 10 * Math.log10(e / FRAME + 1e-12);
    fft(re, im);
    for (let m = 0; m < NMEL; m++) {
      let s = 0;
      for (let k = 0; k <= NFFT / 2; k++) if (bank[m][k]) s += bank[m][k] * (re[k] * re[k] + im[k] * im[k]);
      logmel[m] = Math.log(s + 1e-10);
    }
    const c = new Float32Array(NCEP);
    for (let k = 1; k <= NCEP; k++) {
      let s = 0;
      for (let m = 0; m < NMEL; m++) s += logmel[m] * Math.cos((Math.PI * k * (m + 0.5)) / NMEL);
      c[k - 1] = s;
    }
    ceps.push(c);
  }
  return { ceps, energyDb };
}

/** Autocorrelation pitch (Hz) of a 40 ms frame starting at `start`; 0 when unvoiced/aperiodic. */
export function pitchAt(x: Float32Array, start: number): number {
  const N = 640;
  if (start + N + 266 > x.length) return 0;
  let e = 0;
  for (let i = 0; i < N; i++) e += x[start + i] ** 2;
  if (e < 1e-4) return 0;
  let best = 0;
  let bestLag = 0;
  for (let lag = 40; lag <= 266; lag++) {
    let c = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < N - lag; i++) {
      c += x[start + i] * x[start + i + lag];
      a += x[start + i] ** 2;
      b += x[start + i + lag] ** 2;
    }
    const r = c / Math.sqrt(a * b + 1e-12);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return best > 0.5 ? SR / bestLag : 0;
}

/** Window descriptor: 12 mean MFCCs + median pitch (Hz, 0 = unknown). */
export interface VoiceVec {
  m: Float64Array;
  pitch: number;
}

/** Weight of one octave of pitch difference, in MFCC-RMS units (calibrated on real voices — test report). */
const PITCH_WEIGHT = 16;

export function voiceDistance(a: VoiceVec, b: VoiceVec): number {
  let s = 0;
  for (let k = 0; k < NCEP; k++) s += (a.m[k] - b.m[k]) ** 2;
  s /= NCEP;
  if (a.pitch > 0 && b.pitch > 0) s += (PITCH_WEIGHT * Math.log2(a.pitch / b.pitch)) ** 2;
  return Math.sqrt(s);
}

/** Average-linkage agglomerative clustering over a distance function. Stops at `k` clusters, or when the closest pair is farther than `threshold`. */
export function agglomerate<T>(items: T[], dist: (a: T, b: T) => number, opts: { k?: number; threshold: number }): number[] {
  const n = items.length;
  let clusters: number[][] = items.map((_, i) => [i]);
  const D = items.map((a) => items.map((b) => dist(a, b)));
  const linkage = (A: number[], B: number[]) => {
    let s = 0;
    for (const i of A) for (const j of B) s += D[i][j];
    return s / (A.length * B.length);
  };
  while (clusters.length > 1) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i], clusters[j]);
        if (l < best) {
          best = l;
          bi = i;
          bj = j;
        }
      }
    if (opts.k !== undefined ? clusters.length <= opts.k : best > opts.threshold) break;
    clusters[bi] = [...clusters[bi], ...clusters[bj]];
    clusters = clusters.filter((_, idx) => idx !== bj);
  }
  const labels = new Array<number>(n).fill(0);
  clusters.forEach((c, ci) => c.forEach((i) => (labels[i] = ci)));
  return labels;
}

export interface Turn {
  start: number;
  end: number;
  speaker: number;
  margin: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** Pure diarization over 16 kHz mono PCM (seconds from the start of the buffer). */
export function diarize(x16k: Float32Array, params: SpeakerParams = {}): { turns: Turn[]; speakers: number; windows: number } {
  const { ceps, energyDb } = mfcc(x16k);
  if (ceps.length === 0) return { turns: [], speakers: 0, windows: 0 };
  const sorted = Float32Array.from(energyDb).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.floor(sorted.length * 0.98)];
  const vadTh = Math.max(floor + 10, peak - 35);
  const voiced = Array.from(energyDb, (e) => e > vadTh);
  // Pitch on every 3rd voiced frame (enough for a robust per-window median).
  const pitch = new Float32Array(ceps.length);
  for (let f = 0; f < ceps.length; f += 3) if (voiced[f]) pitch[f] = pitchAt(x16k, f * HOP);
  const winFrames = 200; // 2 s
  const hopFrames = 50; // 0.5 s
  const windows: { center: number; start: number; end: number; vec: VoiceVec }[] = [];
  const describe = (s: number, e: number): VoiceVec | null => {
    const idx: number[] = [];
    for (let f = s; f < e; f++) if (voiced[f]) idx.push(f);
    if (idx.length < (e - s) * 0.3 || idx.length < 10) return null;
    const m = new Float64Array(NCEP);
    for (const f of idx) for (let k = 0; k < NCEP; k++) m[k] += ceps[f][k] / idx.length;
    return { m, pitch: median(idx.map((f) => pitch[f]).filter((p) => p > 0)) };
  };
  for (let s = 0; ; s += hopFrames) {
    const e = Math.min(ceps.length, s + winFrames);
    const vec = describe(s, e);
    if (vec) windows.push({ center: ((s + e) / 2) * (HOP / SR), start: (s * HOP) / SR, end: (e * HOP) / SR, vec });
    if (e >= ceps.length) break;
  }
  if (windows.length === 0) return { turns: [], speakers: 0, windows: 0 };
  let labels = agglomerate(
    windows.map((w) => w.vec),
    voiceDistance,
    { k: params.speakers, threshold: params.threshold ?? 7 },
  );
  // Median smoothing (window of 3) removes single-window flips.
  labels = labels.map((l, i) => (i > 0 && i < labels.length - 1 && labels[i - 1] === labels[i + 1] ? labels[i - 1] : l));
  const order = new Map<number, number>();
  labels = labels.map((l) => {
    if (!order.has(l)) order.set(l, order.size);
    return order.get(l)!;
  });
  const k = order.size;
  // Speaker profiles (mean vectors) for margins and boundary refinement.
  const profiles: VoiceVec[] = Array.from({ length: k }, (_, c) => {
    const members = windows.filter((_, i) => labels[i] === c).map((w) => w.vec);
    const m = new Float64Array(NCEP);
    for (const v of members) for (let d = 0; d < NCEP; d++) m[d] += v.m[d] / members.length;
    return { m, pitch: median(members.map((v) => v.pitch).filter((p) => p > 0)) };
  });
  const margins = windows.map((w, i) => {
    if (k < 2) return 0.5;
    const a = voiceDistance(w.vec, profiles[labels[i]]);
    const b = Math.min(...profiles.filter((_, j) => j !== labels[i]).map((p) => voiceDistance(w.vec, p)));
    return Math.max(0, (b - a) / Math.max(a, b, 1e-9));
  });
  // Windows -> coarse turns.
  const turns: Turn[] = [];
  windows.forEach((w, i) => {
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === labels[i]) {
      prev.end = w.end;
      prev.margin = (prev.margin + margins[i]) / 2;
    } else {
      const start = prev ? (windows[i - 1].center + w.center) / 2 : w.start;
      if (prev) prev.end = start;
      turns.push({ start, end: w.end, speaker: labels[i], margin: margins[i] });
    }
  });
  // Absorb turns shorter than minTurn.
  const minTurn = params.minTurn ?? 1;
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && (t.end - t.start < minTurn || last.speaker === t.speaker)) last.end = t.end;
    else merged.push({ ...t });
  }
  // Boundary refinement: within ±1 s, (1) prefer the middle of a pause (>= 0.15 s unvoiced) — people rarely switch
  // mid-word; (2) otherwise the frame split that best separates the two speakers' profiles (change point).
  const frameSec = HOP / SR;
  for (let i = 1; i < merged.length; i++) {
    const b = merged[i].start;
    const f0 = Math.max(0, Math.floor((b - 1) / frameSec));
    const f1 = Math.min(ceps.length - 1, Math.ceil((b + 1) / frameSec));
    let bestGap: { mid: number; len: number } | null = null;
    let run = -1;
    for (let f = f0; f <= f1 + 1; f++) {
      const unv = f <= f1 && !voiced[f];
      if (unv && run < 0) run = f;
      if (!unv && run >= 0) {
        const len = f - run;
        const mid = ((run + f) / 2) * frameSec;
        if (len * frameSec >= 0.15 && (!bestGap || Math.abs(mid - b) < Math.abs(bestGap.mid - b))) bestGap = { mid, len };
        run = -1;
      }
    }
    let nb = b;
    if (bestGap) nb = bestGap.mid;
    else {
      const A = profiles[merged[i - 1].speaker];
      const B = profiles[merged[i].speaker];
      const frameVec = (f: number): VoiceVec => ({ m: Float64Array.from(ceps[f]), pitch: pitch[f] });
      const cost: number[] = [];
      for (let f = f0; f <= f1; f++) cost.push(voiced[f] ? voiceDistance(frameVec(f), A) - voiceDistance(frameVec(f), B) : 0);
      // split s minimises sum_{<s} dA + sum_{>=s} dB  <=>  maximises the prefix sum of (dA - dB) ... computed directly:
      let best = -Infinity;
      let acc = 0;
      let split = 0;
      const total = cost.reduce((x, y) => x + y, 0);
      for (let s2 = 0; s2 <= cost.length; s2++) {
        const score = total - acc - acc; // (sum after) - (sum before) of (dA - dB)
        if (score > best) {
          best = score;
          split = s2;
        }
        acc += cost[s2] ?? 0;
      }
      nb = (f0 + split) * frameSec;
    }
    if (nb > merged[i - 1].start + 0.2 && nb < merged[i].end - 0.2) {
      merged[i - 1].end = nb;
      merged[i].start = nb;
    }
  }
  return { turns: merged, speakers: new Set(merged.map((t) => t.speaker)).size, windows: windows.length };
}

export const speakerProvider: AIProvider<SpeakerParams> = {
  id: "speakers.mfcc-clustering",
  feature: "speaker-detection",
  label: "Speaker detection",
  kind: "signal-processing",
  description: "Groups speech into speakers by voice timbre (MFCC features + clustering). Classical baseline, not a neural diarizer: best with clearly different voices and turns of a few seconds.",
  needs: { audio: true },
  availability: () => ({ available: true }),
  async run(req, ctx) {
    if (!req.media.hasAudio) throw new AIError("media-unavailable", "This clip has no audio.");
    ctx.progress(0.05, "Reading audio");
    const audio = await req.media.audio();
    throwIfAborted(ctx.signal);
    const x = resampleMono(toMono(audio), audio.sampleRate, SR);
    if (x.length < SR * 2) throw new AIError("invalid-input", "At least 2 seconds of audio are needed.");
    ctx.progress(0.3, "Extracting voice features");
    const { turns, speakers, windows } = diarize(x, req.params);
    throwIfAborted(ctx.signal);
    if (turns.length === 0) throw new AIError("no-result", "No speech was found.");
    const items: SpeakerTurnItem[] = turns.map((t) => ({
      kind: "speaker-turn",
      id: itemId("spk"),
      accepted: true,
      start: +(req.media.sourceStart + t.start).toFixed(3),
      end: +(req.media.sourceStart + t.end).toFixed(3),
      speaker: `Speaker ${t.speaker + 1}`,
      confidence: conf(speakers < 2 ? 0.5 : Math.min(1, 0.4 + t.margin), "margin"),
    }));
    const warnings = speakers < 2 ? ["Only one voice was distinguished."] : [];
    return { items, warnings, metrics: { audioSeconds: x.length / SR, windows, speakers }, params: { speakers: req.params.speakers ?? "auto", threshold: req.params.threshold ?? 7, minTurn: req.params.minTurn ?? 1 } };
  },
};
