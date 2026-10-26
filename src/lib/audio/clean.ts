import { fft, frameCount, hann, OverlapAdd, stftRange, yieldToUi } from "./dsp";

/**
 * CLEAN AUDIO — one-click voice cleanup, classical DSP (no model, nothing leaves the device):
 *
 *   1. high-pass at 80 Hz            removes rumble, handling and wind thumps
 *   2. spectral noise gate           learns the noise spectrum from the quietest 15 % of the recording and attenuates
 *                                    each frequency bin by how far it sits above that floor; the gain is smoothed
 *                                    across time and frequency to avoid "musical noise" artifacts
 *   3. level to ~-18 dBFS speech RMS raises quiet recordings / tames loud ones (gain capped at +18 dB)
 *   4. soft limiter at -1 dBFS       catches the peaks the level step created
 *
 * It removes STEADY noise (hiss, hum, fans, air-con, room tone) well. It does not remove non-stationary sounds
 * (a dog bark, music under speech) — that's what stem separation is for. Output is mono: the voice signal.
 */

export interface CleanOptions {
  /** 0..1 — how hard to suppress the noise floor (0.5 is a natural default). */
  strength: number;
  /** Level the voice to a consistent loudness. */
  normalize: boolean;
}

export interface CleanReport {
  noiseFloorDb: number;
  reductionDb: number;
  gainDb: number;
}

const N_FFT = 1024;
const HOP = 256;
const BLOCK = 512; // frames per processing block (bounded memory)

/** 2nd-order Butterworth high-pass (RBJ biquad), in place. */
export function highPass(x: Float32Array, sampleRate: number, cutoff = 80): void {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    x[i] = yi;
  }
}

/** RMS of each hop-sized frame. */
function frameRms(x: Float32Array, hop: number): Float32Array {
  const n = Math.ceil(x.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const end = Math.min(x.length, (f + 1) * hop);
    for (let i = f * hop; i < end; i++) s += x[i] * x[i];
    out[f] = Math.sqrt(s / Math.max(1, end - f * hop));
  }
  return out;
}

const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v));

/** Mean magnitude spectrum of the quietest frames — the noise profile. */
function noiseProfile(x: Float32Array): { profile: Float32Array; floorRms: number } {
  const rms = frameRms(x, HOP);
  const sorted = [...rms].sort((a, b) => a - b);
  const cut = sorted[Math.max(0, Math.floor(sorted.length * 0.15) - 1)] ?? 0;
  const quiet: number[] = [];
  for (let f = 0; f < rms.length; f++) if (rms[f] <= cut) quiet.push(f);
  // Up to 400 sample frames, spread across the recording.
  const pick = quiet.filter((_, i) => i % Math.max(1, Math.floor(quiet.length / 400)) === 0);
  const bins = N_FFT / 2 + 1;
  const profile = new Float32Array(bins);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  const win = hann(N_FFT);
  for (const f of pick) {
    const start = f * HOP - N_FFT / 2;
    for (let i = 0; i < N_FFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) profile[k] += Math.hypot(re[k], im[k]) / Math.max(1, pick.length);
  }
  return { profile, floorRms: cut };
}

export async function cleanVoice(input: Float32Array, sampleRate: number, opts: CleanOptions, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<{ audio: Float32Array; report: CleanReport }> {
  const strength = Math.min(1, Math.max(0, opts.strength));
  const x = new Float32Array(input);
  highPass(x, sampleRate);
  const { profile, floorRms } = noiseProfile(x);

  const reductionDb = 6 + 18 * strength;
  const floorGain = 10 ** (-reductionDb / 20);
  const overSubtract = 1.2 + 1.6 * strength;
  const bins = N_FFT / 2 + 1;
  const frames = frameCount(x.length, HOP);
  const ola = new OverlapAdd(x.length, N_FFT, HOP);
  const prevGain = new Float32Array(bins).fill(1);
  const gain = new Float32Array(bins);
  for (let t0 = 0; t0 < frames; t0 += BLOCK) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const s = stftRange(x, N_FFT, HOP, t0, Math.min(frames, t0 + BLOCK));
    for (let f = 0; f < s.frames; f++) {
      const o = f * bins;
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(s.re[o + k], s.im[o + k]);
        const g = Math.max(floorGain, 1 - (overSubtract * profile[k]) / (mag + 1e-9));
        // Fast attack (speech onsets survive), slower release (no pumping).
        gain[k] = g > prevGain[k] ? 0.5 * prevGain[k] + 0.5 * g : 0.8 * prevGain[k] + 0.2 * g;
      }
      for (let k = 0; k < bins; k++) {
        const sm = (gain[Math.max(0, k - 1)] + gain[k] + gain[Math.min(bins - 1, k + 1)]) / 3;
        prevGain[k] = gain[k];
        s.re[o + k] *= sm;
        s.im[o + k] *= sm;
      }
    }
    ola.add(s, t0);
    onProgress?.(Math.min(0.95, (t0 + BLOCK) / frames));
    await yieldToUi();
  }
  const y = ola.result();

  let gainDb = 0;
  if (opts.normalize) {
    // Speech level = RMS over frames clearly above the noise floor.
    const rms = frameRms(y, HOP);
    const gate = Math.max(floorRms * 4, 1e-4);
    let sum = 0;
    let n = 0;
    for (const r of rms)
      if (r > gate) {
        sum += r * r;
        n++;
      }
    if (n === 0) {
      // No pauses to learn the floor from (continuous sound): level on everything audible instead.
      for (const r of rms)
        if (r > 1e-3) {
          sum += r * r;
          n++;
        }
    }
    const speechRms = n ? Math.sqrt(sum / n) : 0;
    if (speechRms > 0) {
      gainDb = Math.min(18, Math.max(-12, -18 - db(speechRms)));
      const g = 10 ** (gainDb / 20);
      for (let i = 0; i < y.length; i++) y[i] *= g;
    }
  }
  // Soft limiter: transparent below -2 dBFS, saturates smoothly toward -1 dBFS.
  const knee = 0.794;
  const ceil = 0.891;
  for (let i = 0; i < y.length; i++) {
    const a = Math.abs(y[i]);
    if (a > knee) y[i] = Math.sign(y[i]) * (knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee)));
  }
  onProgress?.(1);
  return { audio: y, report: { noiseFloorDb: db(floorRms), reductionDb, gainDb } };
}
