import type { TimelineModel } from "../timeline/model";

/**
 * OUTPUT SETTINGS (RENDER_ENGINE_ARCHITECTURE.md §2). The final renderer produces exactly these sizes and frame rates;
 * anything else is rejected up front, so an export can never come out at a size or rate nobody asked for.
 */

export interface OutputResolution {
  id: string;
  width: number;
  height: number;
  label: string;
}

export const OUTPUT_RESOLUTIONS: readonly OutputResolution[] = [
  { id: "1080x1920", width: 1080, height: 1920, label: "1080×1920 (9:16)" },
  { id: "1920x1080", width: 1920, height: 1080, label: "1920×1080 (16:9)" },
  { id: "1080x1080", width: 1080, height: 1080, label: "1080×1080 (1:1)" },
  { id: "2160x3840", width: 2160, height: 3840, label: "2160×3840 (9:16 4K)" },
];

export const OUTPUT_FRAME_RATES = [24, 25, 30, 50, 60] as const;
export type OutputFrameRate = (typeof OUTPUT_FRAME_RATES)[number];

export interface AudioOutputSettings {
  sampleRate: 48000;
  channels: 2;
  /** AAC-LC. */
  codec: "aac";
  bitrate: number;
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: OutputFrameRate;
  /** Video bitrate, bits/s. Defaults to `defaultVideoBitrate`. */
  videoBitrate?: number;
  /** Seconds between keyframes (GOP length). */
  keyframeIntervalSec?: number;
  /** null = no audio track (also used automatically when the timeline has no audible clip). */
  audio?: AudioOutputSettings | null;
}

export const DEFAULT_AUDIO: AudioOutputSettings = { sampleRate: 48000, channels: 2, codec: "aac", bitrate: 192_000 };

/**
 * High-quality default: 0.15 bits per pixel per frame (1080p30 ≈ 9.3 Mbit/s, 4K60 ≈ 75 Mbit/s), clamped to
 * [4, 80] Mbit/s. Final quality is the priority — this is well above streaming-platform ingest recommendations.
 */
export function defaultVideoBitrate(width: number, height: number, fps: number): number {
  const bps = width * height * fps * 0.15;
  return Math.round(Math.min(80e6, Math.max(4e6, bps)));
}

export function isOutputFrameRate(fps: number): fps is OutputFrameRate {
  return (OUTPUT_FRAME_RATES as readonly number[]).includes(fps);
}

export interface SettingsCheck {
  ok: boolean;
  errors: string[];
  /** Output pixels per composition pixel (same aspect guaranteed when ok). */
  renderScale: number;
}

const ratio = (w: number, h: number) => `${w / gcd(w, h)}:${h / gcd(w, h)}`;
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Validates settings against the project. The output must have the COMPOSITION's aspect ratio: rendering a 16:9
 * composition into 9:16 would have to crop or letterbox — a creative decision the timeline didn't make — so it is
 * refused with what to change instead. Same aspect at a different size renders at `renderScale`, which re-rasterizes
 * text, shapes and SVG at the output resolution (never an upscaled bitmap).
 */
export function checkRenderSettings(timeline: TimelineModel, s: RenderSettings): SettingsCheck {
  const errors: string[] = [];
  const { width: cw, height: ch } = timeline.composition;
  if (!OUTPUT_RESOLUTIONS.some((r) => r.width === s.width && r.height === s.height)) {
    errors.push(`Unsupported output size ${s.width}×${s.height}. Supported: ${OUTPUT_RESOLUTIONS.map((r) => `${r.width}×${r.height}`).join(", ")}.`);
  }
  if (!isOutputFrameRate(s.fps)) errors.push(`Unsupported frame rate ${s.fps}. Supported: ${OUTPUT_FRAME_RATES.join(", ")} fps.`);
  if (!(timeline.frameRate > 0)) errors.push("The project has no valid frame rate.");
  const renderScale = s.width / cw;
  if (Math.abs(s.width / s.height / (cw / ch) - 1) > 0.002) {
    errors.push(`The output (${s.width}×${s.height}, ${ratio(s.width, s.height)}) doesn't match the composition (${cw}×${ch}, ${ratio(cw, ch)}). Change the composition size first, or pick an output with the same shape.`);
  }
  if (s.videoBitrate !== undefined && !(s.videoBitrate >= 500_000 && s.videoBitrate <= 200e6)) errors.push("Video bitrate must be between 0.5 and 200 Mbit/s.");
  if (s.keyframeIntervalSec !== undefined && !(s.keyframeIntervalSec > 0 && s.keyframeIntervalSec <= 10)) errors.push("Keyframe interval must be between 0 and 10 seconds.");
  return { ok: errors.length === 0, errors, renderScale };
}
