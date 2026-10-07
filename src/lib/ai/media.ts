/**
 * MEDIA ACCESS FOR AI (AI_EDITING_ARCHITECTURE.md §6). Providers never touch <video>, files or the timeline: they ask
 * an AIMediaSource for decoded frames (small RGBA buffers at analysis resolution) and PCM audio. The browser
 * implementation (media-browser.ts) reads through the compositor's FrameProvider and the audio engine's source store
 * — read-only, so analysis can never alter the original media. Tests pass synthetic sources.
 */

/** RGBA, row-major, 4 bytes per pixel (ImageData-compatible). */
export interface AIFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface AIAudio {
  sampleRate: number;
  /** Planar, per channel. Covers the analysed span only (t = 0 is `sourceStart`). */
  channels: Float32Array[];
}

export interface AIMediaSource {
  /** Analysed span of the source, seconds (the clip's in/out). */
  sourceStart: number;
  sourceEnd: number;
  /** Source frame rate (frames per second). */
  fps: number;
  /** Full source resolution (frames are delivered downscaled, same aspect). */
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** A still image (every frame identical): visual analysis samples it once. */
  still?: boolean;
  /** Decodes the frame shown at source time `t`, scaled so its longer side is at most `maxSide` px. */
  frameAt(t: number, maxSide: number): Promise<AIFrame>;
  /** Full-resolution frame canvas-able image (object removal needs real pixels); optional. */
  imageAt?(t: number): Promise<CanvasImageSource>;
  /** Mono-or-more PCM of the analysed span. */
  audio(): Promise<AIAudio>;
}

/** Evenly spaced sample times over [start, end), `perSecond` per second, always including `start`. */
export function sampleTimes(start: number, end: number, perSecond: number, max = Infinity): number[] {
  const dur = Math.max(0, end - start);
  if (dur === 0) return [start];
  let n = Math.max(1, Math.floor(dur * perSecond));
  if (n > max) n = max;
  const step = dur / n;
  return Array.from({ length: n }, (_, i) => +(start + i * step + step / 2).toFixed(6));
}

/** Rec.709 luma plane (0..255) of a frame. */
export function lumaPlane(f: AIFrame): Float32Array {
  const out = new Float32Array(f.width * f.height);
  const d = f.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  return out;
}

/** Downmix planar channels to mono. */
export function toMono(a: AIAudio): Float32Array {
  if (a.channels.length === 1) return a.channels[0];
  const n = a.channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of a.channels) for (let i = 0; i < n; i++) out[i] += ch[i] / a.channels.length;
  return out;
}

/** Linear resample of mono PCM (adequate for analysis features, not for playback). */
export function resampleMono(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const s = i * k;
    const i0 = Math.floor(s);
    const f = s - i0;
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? x[i0] ?? 0) * f;
  }
  return out;
}
