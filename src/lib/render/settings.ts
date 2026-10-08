import type { TimelineModel } from "../timeline/model";

/**
 * OUTPUT SETTINGS (RENDER_ENGINE_ARCHITECTURE.md §2, extended by EXPORT_ARCHITECTURE.md §3). Everything the final
 * renderer can produce is described here and checked up front, so an export can never come out at a size, rate,
 * codec or container nobody asked for.
 */

export interface OutputResolution {
  id: string;
  width: number;
  height: number;
  label: string;
}

/** Standard sizes offered first in the UI. Any even size within the limits below is accepted too. */
export const OUTPUT_RESOLUTIONS: readonly OutputResolution[] = [
  { id: "1080x1920", width: 1080, height: 1920, label: "1080×1920 (9:16)" },
  { id: "1920x1080", width: 1920, height: 1080, label: "1920×1080 (16:9)" },
  { id: "1080x1080", width: 1080, height: 1080, label: "1080×1080 (1:1)" },
  { id: "2160x3840", width: 2160, height: 3840, label: "2160×3840 (9:16 4K)" },
];

/** Frame rates offered in the UI. The renderer accepts any whole rate from 1 to 120 (the time mapping is exact for integers). */
export const OUTPUT_FRAME_RATES = [24, 25, 30, 48, 50, 60] as const;
export type OutputFrameRate = number;

/** H.264 level 5.1/5.2 maximum frame size (36 864 macroblocks), the largest frame every target encoder accepts. */
export const MAX_OUTPUT_PIXELS = 36_864 * 256;
export const MAX_OUTPUT_SIDE = 4096;
export const MIN_OUTPUT_SIDE = 16;

export type OutputContainer = "mp4" | "mov" | "webm";
export type OutputVideoCodec = "avc" | "hevc" | "vp9" | "av1" | "vp8";
export type OutputAudioCodec = "aac" | "opus";
/**
 * How a composition is placed in an output of a DIFFERENT shape. "match" (default) refuses a different shape;
 * "fit" scales the whole composition into the frame and fills the rest (black, or transparent with alpha);
 * "fill" scales it to cover the frame and crops the overflow equally on both sides.
 */
export type Framing = "match" | "fit" | "fill";

/**
 * Which codecs each container can carry (as written by Mediabunny and read back by common players). Opus is WebM-only:
 * Mediabunny writes no edit list for Opus in MP4, so its last frame can't be trimmed there and the audio plays
 * 13.5 ms past the video (found by a real export, EXPORT_TEST_REPORT.md).
 */
export const CONTAINER_CODECS: Record<OutputContainer, { video: readonly OutputVideoCodec[]; audio: readonly OutputAudioCodec[]; alpha: readonly OutputVideoCodec[] }> = {
  mp4: { video: ["avc", "hevc", "av1", "vp9"], audio: ["aac"], alpha: [] },
  mov: { video: ["avc", "hevc"], audio: ["aac"], alpha: [] },
  webm: { video: ["vp9", "av1", "vp8"], audio: ["opus"], alpha: ["vp9", "vp8"] },
};

export const AUDIO_BITRATES = [96_000, 128_000, 160_000, 192_000, 256_000, 320_000] as const;

export interface AudioOutputSettings {
  sampleRate: 48000;
  channels: 2;
  codec: OutputAudioCodec;
  bitrate: number;
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: OutputFrameRate;
  /** Video bitrate, bits/s. Defaults to `defaultVideoBitrate`. */
  videoBitrate?: number;
  /** Default "variable". */
  bitrateMode?: "variable" | "constant";
  /** Seconds between keyframes (GOP length). */
  keyframeIntervalSec?: number;
  /** null = no audio track (also used automatically when the timeline has no audible clip). */
  audio?: AudioOutputSettings | null;
  /** Default "mp4". */
  container?: OutputContainer;
  /** Explicit codec: used exactly, or the render fails. Omitted: H.264, falling back to another codec with a warning. */
  videoCodec?: OutputVideoCodec;
  /** Encode the alpha channel (WebM + VP9/VP8 only). */
  alpha?: boolean;
  /** Default "match". */
  framing?: Framing;
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

export function isOutputFrameRate(fps: number): boolean {
  return Number.isInteger(fps) && fps >= 1 && fps <= 120;
}

export interface Placement {
  /** Output pixels per composition pixel. */
  scale: number;
  /** Where the rendered composition (width × height px) lands in the output frame; may be negative ("fill"). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsCheck {
  ok: boolean;
  errors: string[];
  /** Output pixels per composition pixel. */
  renderScale: number;
  placement: Placement;
}

const ratio = (w: number, h: number) => `${w / gcd(w, h)}:${h / gcd(w, h)}`;
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function sameShape(w: number, h: number, cw: number, ch: number): boolean {
  return Math.abs(w / h / (cw / ch) - 1) <= 0.002;
}

/** Where the composition goes in a W×H output under a framing mode. */
export function placementFor(cw: number, ch: number, W: number, H: number, framing: Framing): Placement {
  if (framing === "match" || sameShape(W, H, cw, ch)) return { scale: W / cw, x: 0, y: 0, width: W, height: H };
  const scale = framing === "fit" ? Math.min(W / cw, H / ch) : Math.max(W / cw, H / ch);
  const width = Math.round(cw * scale);
  const height = Math.round(ch * scale);
  return { scale, x: Math.round((W - width) / 2), y: Math.round((H - height) / 2), width, height };
}

/**
 * Validates settings against the project. Unless a framing mode is chosen, the output must have the COMPOSITION's
 * aspect ratio: putting a 16:9 composition into 9:16 means letterboxing or cropping — a creative decision, so it has
 * to be asked for ("fit" / "fill"). Same aspect at a different size renders at `renderScale`, which re-rasterizes
 * text, shapes and SVG at the output resolution (never an upscaled bitmap).
 */
export function checkRenderSettings(timeline: TimelineModel, s: RenderSettings): SettingsCheck {
  const errors: string[] = [];
  const { width: cw, height: ch } = timeline.composition;
  const sizeOk = (n: number) => Number.isInteger(n) && n >= MIN_OUTPUT_SIDE && n <= MAX_OUTPUT_SIDE && n % 2 === 0;
  if (!sizeOk(s.width) || !sizeOk(s.height)) {
    errors.push(`Unsupported output size ${s.width}×${s.height}: width and height must be even whole numbers from ${MIN_OUTPUT_SIDE} to ${MAX_OUTPUT_SIDE}.`);
  } else if (s.width * s.height > MAX_OUTPUT_PIXELS) {
    errors.push(`Output size ${s.width}×${s.height} is too large: at most ${MAX_OUTPUT_PIXELS.toLocaleString("en-US")} pixels per frame (e.g. 4096×2304).`);
  }
  if (!isOutputFrameRate(s.fps)) errors.push(`Unsupported frame rate ${s.fps}: use a whole number of frames per second from 1 to 120.`);
  if (!(timeline.frameRate > 0)) errors.push("The project has no valid frame rate.");
  const framing = s.framing ?? "match";
  if (framing === "match" && !sameShape(s.width, s.height, cw, ch)) {
    errors.push(`The output (${s.width}×${s.height}, ${ratio(s.width, s.height)}) doesn't match the composition (${cw}×${ch}, ${ratio(cw, ch)}). Choose "fit" (letterbox) or "fill" (crop), change the composition size, or pick an output with the same shape.`);
  }
  const container = s.container ?? "mp4";
  const allowed = CONTAINER_CODECS[container];
  if (!allowed) errors.push(`Unsupported container "${container}".`);
  else {
    if (s.videoCodec && !allowed.video.includes(s.videoCodec)) errors.push(`${codecLabel(s.videoCodec)} can't go in ${container.toUpperCase()}. ${container.toUpperCase()} takes ${allowed.video.map(codecLabel).join(", ")}.`);
    if (s.audio && !allowed.audio.includes(s.audio.codec)) errors.push(`${codecLabel(s.audio.codec)} audio can't go in ${container.toUpperCase()}. ${container.toUpperCase()} takes ${allowed.audio.map(codecLabel).join(", ")}.`);
    if (s.alpha) {
      const codec = s.videoCodec ?? (container === "webm" ? "vp9" : "avc");
      if (!allowed.alpha.includes(codec)) errors.push(`Transparency needs WebM with VP9 or VP8; ${container.toUpperCase()} + ${codecLabel(codec)} has no alpha channel.`);
    }
  }
  if (s.audio && !(s.audio.bitrate >= 32_000 && s.audio.bitrate <= 512_000)) errors.push("Audio bitrate must be between 32 and 512 kbit/s.");
  if (s.videoBitrate !== undefined && !(s.videoBitrate >= 500_000 && s.videoBitrate <= 200e6)) errors.push("Video bitrate must be between 0.5 and 200 Mbit/s.");
  if (s.keyframeIntervalSec !== undefined && !(s.keyframeIntervalSec > 0 && s.keyframeIntervalSec <= 10)) errors.push("Keyframe interval must be between 0 and 10 seconds.");
  const placement = placementFor(cw, ch, s.width, s.height, framing);
  return { ok: errors.length === 0, errors, renderScale: placement.scale, placement };
}

export function codecLabel(c: OutputVideoCodec | OutputAudioCodec): string {
  return { avc: "H.264", hevc: "HEVC (H.265)", vp9: "VP9", av1: "AV1", vp8: "VP8", aac: "AAC", opus: "Opus" }[c];
}
