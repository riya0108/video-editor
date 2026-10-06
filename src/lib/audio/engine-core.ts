import { clipDurationFrames, isTrimmableContent, type Clip } from "../timeline/clip";
import { allTracks, type TimelineModel } from "../timeline/model";
import { isTrackAudible } from "../timeline/track";
import { valueAt } from "../animation/properties";
import { clipAudioOf, dbToLinear, fadeGainAt, isAudibleKind } from "./model";

/**
 * AUDIO ENGINE CORE (AUDIO_ENGINE_ARCHITECTURE.md §4) — pure, no Web Audio.
 * One evaluation of "what sounds when, at what gain" shared by live playback
 * (Web Audio scheduling) and export (the offline mixer below), so what you
 * hear while editing is what gets exported.
 */

/** Decoded PCM of one source, as the engine needs it. */
export interface PcmSource {
  sampleRate: number;
  /** One Float32Array per channel (1 = mono, 2 = stereo; more are down-mixed to the first two). */
  channels: Float32Array[];
}

/** Gain envelope resolution (points per second). Linear interpolation between points in both playback and export. */
export const ENVELOPE_RATE = 500;

/**
 * Total gain of a clip at clip-relative frame `local` (fractional allowed): volume automation (audio.volume
 * keyframes) x static gain + normalization (audio.gainDb, itself animatable) x fade in/out x mute.
 */
export function clipGainAt(clip: Clip, local: number, comp: { width: number; height: number }): number {
  const a = clipAudioOf(clip);
  if (a.muted) return 0;
  const volume = valueAt(clip, "audio.volume", local, comp);
  const gainDb = valueAt(clip, "audio.gainDb", local, comp);
  return volume * dbToLinear(gainDb + (a.normalize?.gainDb ?? 0)) * fadeGainAt(local, clipDurationFrames(clip), a);
}

/** True when the gain is the same at every instant (no automation, no fades) — playback can use a constant. */
export function isStaticGain(clip: Clip): boolean {
  const a = clipAudioOf(clip);
  return a.fadeInFrames === 0 && a.fadeOutFrames === 0 && !clip.animation?.tracks["audio.volume"]?.keyframes.length && !clip.animation?.tracks["audio.gainDb"]?.keyframes.length;
}

/**
 * Samples a clip's gain envelope at ENVELOPE_RATE from clip-relative time `fromSec` to `toSec` (inclusive ends) — the
 * curve playback hands to AudioParam.setValueCurveAtTime and export interpolates per sample.
 */
export function sampleEnvelope(clip: Clip, fps: number, fromSec: number, toSec: number, comp: { width: number; height: number }, rate = ENVELOPE_RATE): Float32Array {
  const n = Math.max(2, Math.ceil((toSec - fromSec) * rate) + 1);
  const out = new Float32Array(n);
  const step = (toSec - fromSec) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = clipGainAt(clip, (fromSec + i * step) * fps, comp);
  return out;
}

/** One clip's contribution to the mix, in seconds. */
export interface AudioSegment {
  clipId: string;
  trackId: string;
  sourceId: string;
  /** Timeline time the segment starts playing. */
  timelineStartSec: number;
  /** Offset into the source where it starts. */
  sourceOffsetSec: number;
  durationSec: number;
  /** Clip-relative time of the segment start (non-zero when playback starts mid-clip). */
  clipLocalStartSec: number;
  clip: Clip;
}

export interface ScheduleOptions {
  /** Only segments audible at or after this timeline time (playback start). */
  fromSec?: number;
  /** Exclusive end (export range). */
  toSec?: number;
  /** Whether a source has decoded audio. Clips whose source has none (missing / no audio track / failed) are skipped. */
  hasAudio: (sourceId: string) => boolean;
}

/**
 * Every audible clip segment in [fromSec, toSec): audio clips and the soundtrack of video/overlay clips, honoring
 * track mute/solo (solo is derived, never stored — isTrackAudible) and clip mute. Trimmed to the range, so a
 * playback started mid-clip enters the source at the right offset (sync).
 */
export function audioSegments(timeline: TimelineModel, opts: ScheduleOptions): AudioSegment[] {
  const fps = timeline.frameRate;
  const from = opts.fromSec ?? 0;
  const to = opts.toSec ?? Infinity;
  const tracks = allTracks(timeline);
  const soundTracks = tracks.filter((t) => isAudibleKind(t.kind));
  const out: AudioSegment[] = [];
  for (const track of soundTracks) {
    if (!isTrackAudible(track, soundTracks)) continue;
    for (const id of track.clipIds) {
      const clip = timeline.clips[id];
      if (!clip || !isTrimmableContent(clip.content) || clipAudioOf(clip).muted) continue;
      if (!opts.hasAudio(clip.content.source.sourceId)) continue;
      const start = clip.timelineStart / fps;
      const end = (clip.timelineStart + clipDurationFrames(clip)) / fps;
      const s = Math.max(start, from);
      const e = Math.min(end, to);
      if (e <= s) continue;
      out.push({
        clipId: clip.id,
        trackId: track.id,
        sourceId: clip.content.source.sourceId,
        timelineStartSec: s,
        sourceOffsetSec: clip.content.sourceInFrame / fps + (s - start),
        durationSec: e - s,
        clipLocalStartSec: s - start,
        clip,
      });
    }
  }
  return out;
}

export interface MixResult {
  sampleRate: number;
  /** Stereo output. */
  channels: [Float32Array, Float32Array];
  /** Absolute peak of the mix before any clamping (> 1 means the export would clip). */
  peak: number;
  /** Samples whose absolute value exceeded 1.0 (clipped in a 16-bit export). */
  clippedSamples: number;
}

/**
 * OFFLINE MIXER (export). Renders [startSec, endSec) of the timeline to stereo PCM at `sampleRate`: every segment is
 * resampled from its source rate (linear interpolation), multiplied by its gain envelope (ENVELOPE_RATE points,
 * linearly interpolated — the same curve playback schedules) and summed. Mono sources feed both channels. Pure and
 * deterministic, so it runs identically in Node tests and the browser.
 */
export function mixTimeline(timeline: TimelineModel, getSource: (sourceId: string) => PcmSource | undefined, opts: { sampleRate: number; startSec: number; endSec: number }): MixResult {
  const { sampleRate, startSec, endSec } = opts;
  const length = Math.max(0, Math.round((endSec - startSec) * sampleRate));
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  const segments = audioSegments(timeline, { fromSec: startSec, toSec: endSec, hasAudio: (id) => !!getSource(id) });
  for (const seg of segments) {
    const src = getSource(seg.sourceId)!;
    const s0 = Math.round((seg.timelineStartSec - startSec) * sampleRate);
    const n = Math.min(length - s0, Math.round(seg.durationSec * sampleRate));
    if (n <= 0) continue;
    const env = sampleEnvelope(seg.clip, timeline.frameRate, seg.clipLocalStartSec, seg.clipLocalStartSec + seg.durationSec, timeline.composition);
    const envStep = (env.length - 1) / Math.max(1, n);
    const ratio = src.sampleRate / sampleRate;
    const chL = src.channels[0];
    const chR = src.channels[1] ?? src.channels[0];
    const srcLen = chL.length;
    const srcStart = seg.sourceOffsetSec * src.sampleRate;
    for (let i = 0; i < n; i++) {
      const pos = srcStart + i * ratio;
      const i0 = Math.floor(pos);
      if (i0 >= srcLen) break; // source shorter than the clip claims (e.g. metadata rounding): silence, never garbage
      const frac = pos - i0;
      const i1 = i0 + 1 < srcLen ? i0 + 1 : i0;
      const ep = i * envStep;
      const e0 = Math.floor(ep);
      const g = env[e0] + (env[Math.min(e0 + 1, env.length - 1)] - env[e0]) * (ep - e0);
      L[s0 + i] += (chL[i0] + (chL[i1] - chL[i0]) * frac) * g;
      R[s0 + i] += (chR[i0] + (chR[i1] - chR[i0]) * frac) * g;
    }
  }
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    if (Math.abs(L[i]) > 1) clipped++;
    if (Math.abs(R[i]) > 1) clipped++;
  }
  return { sampleRate, channels: [L, R], peak, clippedSamples: clipped };
}

// ---------------------------------------------------------------------------
// ANALYSIS: peaks (waveform), peak level (normalization)
// ---------------------------------------------------------------------------

export interface WaveformPeaks {
  /** Bins per second of source. */
  binRate: number;
  /** Per-bin min and max of the mono mix (-1..1). */
  min: Float32Array;
  max: Float32Array;
  durationSec: number;
}

export const WAVEFORM_BIN_RATE = 200;

/** Min/max peaks per bin (mono = average of the first two channels). Exact: every sample is visited. */
export function computePeaks(src: PcmSource, binRate = WAVEFORM_BIN_RATE): WaveformPeaks {
  const a = src.channels[0];
  const b = src.channels[1] ?? a;
  const perBin = src.sampleRate / binRate;
  const bins = Math.max(1, Math.ceil(a.length / perBin));
  const min = new Float32Array(bins).fill(0);
  const max = new Float32Array(bins).fill(0);
  for (let k = 0; k < bins; k++) {
    const s = Math.floor(k * perBin);
    const e = Math.min(a.length, Math.floor((k + 1) * perBin));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = s; i < e; i++) {
      const v = (a[i] + b[i]) / 2;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[k] = lo === Infinity ? 0 : lo;
    max[k] = hi === -Infinity ? 0 : hi;
  }
  return { binRate, min, max, durationSec: a.length / src.sampleRate };
}

/** Reduces peaks over source range [fromSec, toSec) to `columns` min/max pairs for drawing (a column covering several bins takes their extremes). */
export function waveformColumns(p: WaveformPeaks, fromSec: number, toSec: number, columns: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const span = (toSec - fromSec) / columns;
  for (let c = 0; c < columns; c++) {
    const b0 = Math.max(0, Math.floor((fromSec + c * span) * p.binRate));
    const b1 = Math.min(p.min.length, Math.max(b0 + 1, Math.ceil((fromSec + (c + 1) * span) * p.binRate)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      if (p.min[b] < lo) lo = p.min[b];
      if (p.max[b] > hi) hi = p.max[b];
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/** Absolute sample peak over a source time range, in dBFS (-Infinity for digital silence). */
export function peakDbOf(src: PcmSource, fromSec = 0, toSec = Infinity): number {
  const s = Math.max(0, Math.floor(fromSec * src.sampleRate));
  let peak = 0;
  for (const ch of src.channels.slice(0, 2)) {
    const e = Math.min(ch.length, Math.ceil(toSec * src.sampleRate));
    for (let i = s; i < e; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Peak of a clip's trimmed source range — the input normalization needs. */
export function clipPeakDb(clip: Clip, src: PcmSource, fps: number): number {
  if (!isTrimmableContent(clip.content)) return -Infinity;
  return peakDbOf(src, clip.content.sourceInFrame / fps, clip.content.sourceOutFrame / fps);
}

// ---------------------------------------------------------------------------
// WAV ENCODING (export)
// ---------------------------------------------------------------------------

/** 16-bit PCM WAV (interleaved). Out-of-range samples are clamped (MixResult reports how many). */
export function encodeWav16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataSize = frames * nch * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Minimal 16-bit PCM WAV reader (tests / verifying exports). */
export function decodeWav16(bytes: Uint8Array): PcmSource {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nch = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const dataSize = v.getUint32(40, true);
  const frames = dataSize / (nch * 2);
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const s = v.getInt16(o, true);
      channels[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff;
      o += 2;
    }
  }
  return { sampleRate, channels };
}
