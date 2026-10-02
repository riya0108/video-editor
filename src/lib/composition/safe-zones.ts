import type { Rect } from "./matrix";

/**
 * SAFE ZONES — display/snap aids only, never rendered into output.
 *
 *  - "broadcast": action-safe 93% and title-safe 90% of the frame (the
 *    current EBU R 95 / SMPTE ST 2046-1 values for 16:9 HD/UHD).
 *  - "social": the area typically left uncovered by TikTok / Reels / Shorts
 *    UI (top bar, bottom caption/CTA stack, right-side action rail),
 *    expressed as fractions so it scales with any vertical composition.
 *    These are approximate and differ per platform — a guide, not a spec.
 */
export type SafeZonePreset = "off" | "broadcast" | "social";

export interface SafeZone {
  label: string;
  rect: Rect;
}

function inset(width: number, height: number, fraction: number): Rect {
  const mx = (width * (1 - fraction)) / 2;
  const my = (height * (1 - fraction)) / 2;
  return { x: mx, y: my, width: width - mx * 2, height: height - my * 2 };
}

export function safeZones(preset: SafeZonePreset, width: number, height: number): SafeZone[] {
  switch (preset) {
    case "broadcast":
      return [
        { label: "Action safe", rect: inset(width, height, 0.93) },
        { label: "Title safe", rect: inset(width, height, 0.9) },
      ];
    case "social": {
      const top = height * 0.14;
      const bottom = height * 0.2;
      const left = width * 0.06;
      const right = width * 0.16;
      return [{ label: "Social UI safe", rect: { x: left, y: top, width: width - left - right, height: height - top - bottom } }];
    }
    default:
      return [];
  }
}
