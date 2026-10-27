/**
 * DSP CORE — the spectral building blocks shared by Clean Audio, beat detection and stem separation. Pure and
 * allocation-conscious (twiddles and windows are cached per size), so it runs in the browser and in unit tests alike.
 */

const twiddleCache = new Map<number, { cos: Float32Array; sin: Float32Array; rev: Uint32Array }>();

function plan(n: number) {
  let p = twiddleCache.get(n);
  if (p) return p;
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two (got ${n}).`);
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  p = { cos, sin, rev };
  twiddleCache.set(n, p);
  return p;
}

/** In-place iterative radix-2 FFT. `inverse` computes the unscaled inverse (divide by n yourself). */
export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sgn = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sgn * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const windowCache = new Map<number, Float32Array>();
/** Periodic Hann window (the STFT convention, perfect overlap-add at 75 % overlap). */
export function hann(n: number): Float32Array {
  let w = windowCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windowCache.set(n, w);
  }
  return w;
}

/** Complex STFT frames: re/im of bins 0..nFft/2, frame-major. Frame t is centred on sample t*hop (signal zero-padded by nFft/2). */
export interface Stft {
  nFft: number;
  hop: number;
  frames: number;
  bins: number;
  re: Float32Array;
  im: Float32Array;
}

/** Frames an `x.length`-sample signal has at this hop (centred framing). */
export function frameCount(length: number, hop: number): number {
  return Math.max(1, Math.ceil(length / hop) + 1);
}

/** STFT of frames [t0, t1) only — long signals are processed range by range so memory stays bounded. */
export function stftRange(x: Float32Array, nFft: number, hop: number, t0: number, t1: number): Stft {
  const bins = nFft / 2 + 1;
  const pad = nFft / 2;
  const frames = Math.max(0, t1 - t0);
  const win = hann(nFft);
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const fr = new Float32Array(nFft);
  const fi = new Float32Array(nFft);
  for (let f = 0; f < frames; f++) {
    const start = (t0 + f) * hop - pad;
    for (let i = 0; i < nFft; i++) {
      const s = start + i;
      fr[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0;
      fi[i] = 0;
    }
    fft(fr, fi);
    re.set(fr.subarray(0, bins), f * bins);
    im.set(fi.subarray(0, bins), f * bins);
  }
  return { nFft, hop, frames, bins, re, im };
}

export function stft(x: Float32Array, nFft: number, hop: number): Stft {
  return stftRange(x, nFft, hop, 0, frameCount(x.length, hop));
}

/** Weighted overlap-add synthesis, fed range by range (the inverse of `stftRange`). */
export class OverlapAdd {
  private out: Float32Array;
  private norm: Float32Array;
  private fr: Float32Array;
  private fi: Float32Array;
  constructor(
    private length: number,
    private nFft: number,
    private hop: number,
  ) {
    this.out = new Float32Array(length + nFft + hop);
    this.norm = new Float32Array(length + nFft + hop);
    this.fr = new Float32Array(nFft);
    this.fi = new Float32Array(nFft);
  }

  /** Adds frames whose first frame index is `t0`. */
  add(s: Stft, t0: number): void {
    const { nFft, hop, fr, fi } = this;
    const win = hann(nFft);
    const bins = s.bins;
    for (let f = 0; f < s.frames; f++) {
      const o = f * bins;
      for (let k = 0; k < bins; k++) {
        fr[k] = s.re[o + k];
        fi[k] = s.im[o + k];
      }
      for (let k = 1; k < nFft / 2; k++) {
        fr[nFft - k] = fr[k];
        fi[nFft - k] = -fi[k];
      }
      fft(fr, fi, true);
      const start = (t0 + f) * hop;
      if (start >= this.out.length) break;
      const n = Math.min(nFft, this.out.length - start);
      for (let i = 0; i < n; i++) {
        this.out[start + i] += (fr[i] / nFft) * win[i];
        this.norm[start + i] += win[i] * win[i];
      }
    }
  }

  result(): Float32Array {
    const pad = this.nFft / 2;
    const y = new Float32Array(this.length);
    for (let i = 0; i < this.length; i++) {
      const n = this.norm[i + pad];
      y[i] = n > 1e-8 ? this.out[i + pad] / n : 0;
    }
    return y;
  }
}

/** Inverse of `stft`, trimmed to `length` samples. */
export function istft(s: Stft, length: number): Float32Array {
  const ola = new OverlapAdd(length, s.nFft, s.hop);
  ola.add(s, 0);
  return ola.result();
}

/** Linear-interpolation resampler (adequate for analysis; playback-quality paths resample with Web Audio). */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    y[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return y;
}

export function toMonoChannels(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const y = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) y[i] += c[i] / channels.length;
  return y;
}

/** Lets the browser paint (progress bars) between chunks of heavy work. */
export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
