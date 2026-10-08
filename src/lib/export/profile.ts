import { timelineDurationFrames, type TimelineModel } from "../timeline/model";
import { checkRenderSettings, codecLabel, CONTAINER_CODECS, OUTPUT_FRAME_RATES, sameShape, type Framing, type OutputAudioCodec, type OutputContainer, type OutputVideoCodec, type RenderSettings } from "../render/settings";

/**
 * EXPORT PROFILE (EXPORT_ARCHITECTURE.md §2–§3) — what the user picks in the export panel: a preset's values, every
 * one of them editable. A profile is turned into the render engine's `RenderSettings` (src/lib/render/settings.ts)
 * only after `checkExportProfile` has accepted it; nothing is guessed or silently substituted later.
 */

export type QualityLevel = "draft" | "standard" | "high" | "max";

export interface ExportProfile {
  presetId: string;
  width: number;
  height: number;
  fps: number;
  framing: Framing;
  container: OutputContainer;
  videoCodec: OutputVideoCodec;
  /** "quality": bitrate derived from the quality level, size, rate and codec. "bitrate": `videoBitrate` exactly. */
  rateControl: "quality" | "bitrate";
  quality: QualityLevel;
  /** bits/s, used when rateControl is "bitrate". */
  videoBitrate: number;
  bitrateMode: "variable" | "constant";
  audioCodec: OutputAudioCodec | "none";
  /** bits/s. */
  audioBitrate: number;
  alpha: boolean;
}

/** Bits per pixel per frame for H.264 at each quality level. "high" equals the render engine's default (0.15). */
export const QUALITY_BPP: Record<QualityLevel, number> = { draft: 0.05, standard: 0.1, high: 0.15, max: 0.25 };
export const QUALITY_LABEL: Record<QualityLevel, string> = { draft: "Draft", standard: "Standard", high: "High", max: "Maximum" };
/** Bits a codec needs for the same visual quality, relative to H.264 (conservative ends of published comparisons). */
export const CODEC_EFFICIENCY: Record<OutputVideoCodec, number> = { avc: 1, hevc: 0.65, vp9: 0.7, av1: 0.55, vp8: 1.1 };
export const MIN_VIDEO_BITRATE = 1e6;
export const MAX_VIDEO_BITRATE = 120e6;

export function qualityBitrate(p: Pick<ExportProfile, "width" | "height" | "fps" | "quality" | "videoCodec">): number {
  const bps = p.width * p.height * p.fps * QUALITY_BPP[p.quality] * CODEC_EFFICIENCY[p.videoCodec];
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, bps)));
}

export function resolvedVideoBitrate(p: ExportProfile): number {
  return p.rateControl === "bitrate" ? p.videoBitrate : qualityBitrate(p);
}

export function toRenderSettings(p: ExportProfile): RenderSettings {
  return {
    width: p.width,
    height: p.height,
    fps: p.fps,
    framing: p.framing,
    container: p.container,
    videoCodec: p.videoCodec,
    videoBitrate: resolvedVideoBitrate(p),
    bitrateMode: p.bitrateMode,
    alpha: p.alpha,
    audio: p.audioCodec === "none" ? null : { sampleRate: 48000, channels: 2, codec: p.audioCodec, bitrate: p.audioBitrate },
  };
}

export const FILE_EXTENSION: Record<OutputContainer, string> = { mp4: "mp4", mov: "mov", webm: "webm" };

/** Platform guidance a preset carries: limits the platform publishes. Exceeding them is a warning, never a block. */
export interface PlatformGuidance {
  platform: string;
  maxDurationSec?: number;
  maxVideoBitrate?: number;
}

export interface ProfileCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  settings: RenderSettings;
}

/** Validates a profile against the project before it may be queued. */
export function checkExportProfile(timeline: TimelineModel, p: ExportProfile, guidance?: PlatformGuidance): ProfileCheck {
  const settings = toRenderSettings(p);
  const base = checkRenderSettings(timeline, settings);
  const errors = [...base.errors];
  const warnings: string[] = [];
  if (p.rateControl === "bitrate" && !(p.videoBitrate >= MIN_VIDEO_BITRATE && p.videoBitrate <= MAX_VIDEO_BITRATE)) {
    errors.push(`Video bitrate must be between ${MIN_VIDEO_BITRATE / 1e6} and ${MAX_VIDEO_BITRATE / 1e6} Mbit/s.`);
  }
  const { width: cw, height: ch } = timeline.composition;
  if (p.framing !== "match" && !sameShape(p.width, p.height, cw, ch)) {
    warnings.push(p.framing === "fit" ? `The ${cw}×${ch} composition will be letterboxed inside ${p.width}×${p.height}.` : `The ${cw}×${ch} composition will be cropped to fill ${p.width}×${p.height}.`);
  }
  if (!(OUTPUT_FRAME_RATES as readonly number[]).includes(p.fps)) warnings.push(`${p.fps} fps is not a standard delivery rate.`);
  if (Number.isInteger(timeline.frameRate) && p.fps !== timeline.frameRate && p.fps % timeline.frameRate !== 0 && timeline.frameRate % p.fps !== 0) {
    warnings.push(`The project runs at ${timeline.frameRate} fps; ${p.fps} fps isn't a whole multiple or divisor, so motion will show uneven frame cadence.`);
  }
  if (guidance) {
    const dur = timelineDurationFrames(timeline) / timeline.frameRate;
    if (guidance.maxDurationSec && dur > guidance.maxDurationSec) warnings.push(`${guidance.platform} accepts up to ${fmtDuration(guidance.maxDurationSec)}; this timeline is ${fmtDuration(dur)}.`);
    const vbr = resolvedVideoBitrate(p);
    if (guidance.maxVideoBitrate && vbr > guidance.maxVideoBitrate) warnings.push(`${guidance.platform} re-encodes uploads above ~${guidance.maxVideoBitrate / 1e6} Mbit/s; ${(vbr / 1e6).toFixed(1)} Mbit/s only makes the file bigger.`);
  }
  return { ok: errors.length === 0, errors, warnings, settings };
}

/** Keeps a profile internally consistent after one field changed: codecs the container can't carry are replaced by its first. */
export function normalizeProfile(p: ExportProfile): ExportProfile {
  const allowed = CONTAINER_CODECS[p.container];
  const videoCodec = allowed.video.includes(p.videoCodec) ? p.videoCodec : allowed.video[0];
  const audioCodec = p.audioCodec === "none" || allowed.audio.includes(p.audioCodec) ? p.audioCodec : allowed.audio[0];
  const alpha = p.alpha && allowed.alpha.includes(videoCodec);
  return { ...p, videoCodec, audioCodec, alpha };
}

export function describeProfile(p: ExportProfile): string {
  const audio = p.audioCodec === "none" ? "no audio" : `${codecLabel(p.audioCodec)} ${p.audioBitrate / 1000} kbit/s`;
  return `${p.width}×${p.height} · ${p.fps} fps · ${p.container.toUpperCase()} ${codecLabel(p.videoCodec)} ${(resolvedVideoBitrate(p) / 1e6).toFixed(1)} Mbit/s · ${audio}${p.alpha ? " · alpha" : ""}`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m > 0 ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
}
