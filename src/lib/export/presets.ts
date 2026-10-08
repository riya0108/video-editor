import type { TimelineModel } from "../timeline/model";
import { OUTPUT_FRAME_RATES } from "../render/settings";
import { normalizeProfile, type ExportProfile, type PlatformGuidance } from "./profile";

/**
 * EXPORT PRESETS (EXPORT_ARCHITECTURE.md §2). Values follow what each platform publishes for uploads (checked 2025):
 *  - YouTube: H.264 High, AAC-LC 48 kHz stereo (YouTube recommends 384 kbit/s); SDR 1080p at 8 Mbit/s (24–30 fps) /
 *    12 Mbit/s (48–60 fps). Audio is 320 kbit/s: Chrome's macOS AAC encoder reports 384 kbit/s as supported but fails
 *    every encode at it (found by a real export); 320 is the highest rate that encodes, and YouTube re-encodes anyway.
 *  - Shorts: vertical 9:16, up to 3 minutes, same encoding recommendations as YouTube.
 *  - Instagram Reels: 9:16 1080×1920, H.264 + AAC in MP4, up to 3 minutes. Instagram publishes no bitrate; the
 *    "high" quality level is used and Instagram re-encodes on upload anyway.
 * Frame rate follows the project when it is a standard delivery rate (never resampling motion without need),
 * otherwise 30.
 */

export type PresetId = "instagram-reel" | "youtube" | "youtube-shorts" | "square" | "custom";

export interface ExportPreset {
  id: PresetId;
  label: string;
  description: string;
  guidance?: PlatformGuidance;
  /** Builds the preset's profile for a project. */
  profile: (timeline: TimelineModel) => ExportProfile;
}

/** The project's rate when it's a standard delivery rate, else 30. */
export function deliveryFps(timeline: TimelineModel): number {
  return (OUTPUT_FRAME_RATES as readonly number[]).includes(timeline.frameRate) ? timeline.frameRate : 30;
}

const YOUTUBE_AUDIO_BITRATE = 320_000;
const youtubeBitrate = (fps: number) => (fps > 30 ? 12e6 : 8e6);

const base = (timeline: TimelineModel): Omit<ExportProfile, "presetId" | "width" | "height"> => ({
  fps: deliveryFps(timeline),
  framing: "fit",
  container: "mp4",
  videoCodec: "avc",
  rateControl: "quality",
  quality: "high",
  videoBitrate: 8e6,
  bitrateMode: "variable",
  audioCodec: "aac",
  audioBitrate: 192_000,
  alpha: false,
});

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: "instagram-reel",
    label: "Instagram Reel",
    description: "1080×1920 9:16 · H.264 + AAC · MP4",
    guidance: { platform: "Instagram Reels", maxDurationSec: 180 },
    profile: (tl) => ({ ...base(tl), presetId: "instagram-reel", width: 1080, height: 1920, audioBitrate: 128_000 }),
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "1920×1080 16:9 · H.264 8–12 Mbit/s + AAC 320 kbit/s · MP4",
    guidance: { platform: "YouTube", maxVideoBitrate: 50e6 },
    profile: (tl) => {
      const b = base(tl);
      return { ...b, presetId: "youtube", width: 1920, height: 1080, rateControl: "bitrate", videoBitrate: youtubeBitrate(b.fps), audioBitrate: YOUTUBE_AUDIO_BITRATE };
    },
  },
  {
    id: "youtube-shorts",
    label: "YouTube Shorts",
    description: "1080×1920 9:16 · H.264 8–12 Mbit/s + AAC 320 kbit/s · MP4",
    guidance: { platform: "YouTube Shorts", maxDurationSec: 180, maxVideoBitrate: 50e6 },
    profile: (tl) => {
      const b = base(tl);
      return { ...b, presetId: "youtube-shorts", width: 1080, height: 1920, rateControl: "bitrate", videoBitrate: youtubeBitrate(b.fps), audioBitrate: YOUTUBE_AUDIO_BITRATE };
    },
  },
  {
    id: "square",
    label: "Square",
    description: "1080×1080 1:1 · H.264 + AAC · MP4",
    profile: (tl) => ({ ...base(tl), presetId: "square", width: 1080, height: 1080 }),
  },
  {
    id: "custom",
    label: "Custom",
    description: "Every setting yours — starts at the composition's size",
    profile: (tl) => ({ ...base(tl), presetId: "custom", width: even(tl.composition.width), height: even(tl.composition.height), framing: "match" }),
  },
];

const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

export function presetById(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}

export function presetProfile(id: PresetId, timeline: TimelineModel): ExportProfile {
  const p = presetById(id);
  if (!p) throw new Error(`Unknown export preset "${id}".`);
  return normalizeProfile(p.profile(timeline));
}
