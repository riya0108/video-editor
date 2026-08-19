/** Ready-made output sizes for common social platforms — used by the Resize
 * tool and by the video editor's "Resize & background" panel, which fits the
 * source into one of these by padding (blur/solid/gradient) rather than
 * stretching or cropping content away. */
export interface SocialPreset {
  id: string;
  platform: string;
  label: string;
  width: number;
  height: number;
  kind: "video" | "image";
}

export const SOCIAL_PRESETS: SocialPreset[] = [
  // ---- Instagram ----
  { id: "instagram-post", platform: "Instagram", label: "Post (1:1)", width: 1080, height: 1080, kind: "image" },
  { id: "instagram-reel", platform: "Instagram", label: "Reel (9:16)", width: 1080, height: 1920, kind: "video" },
  { id: "instagram-story", platform: "Instagram", label: "Story (9:16)", width: 1080, height: 1920, kind: "video" },

  // ---- Facebook ----
  { id: "facebook-post", platform: "Facebook", label: "Post (4:5)", width: 1080, height: 1350, kind: "image" },
  { id: "facebook-cover", platform: "Facebook", label: "Cover", width: 820, height: 312, kind: "image" },
  { id: "facebook-reel", platform: "Facebook", label: "Reel (9:16)", width: 1080, height: 1920, kind: "video" },
  { id: "facebook-story", platform: "Facebook", label: "Story (9:16)", width: 1080, height: 1920, kind: "video" },

  // ---- WhatsApp ----
  { id: "whatsapp-status", platform: "WhatsApp", label: "Status (9:16)", width: 1080, height: 1920, kind: "video" },

  // ---- General ----
  { id: "mobile-video", platform: "Mobile", label: "Mobile video (9:16)", width: 1080, height: 1920, kind: "video" },

  // ---- YouTube ----
  { id: "youtube-shorts", platform: "YouTube", label: "Shorts (9:16)", width: 1080, height: 1920, kind: "video" },
  { id: "youtube-long", platform: "YouTube", label: "Long-form (16:9)", width: 1920, height: 1080, kind: "video" },

  // ---- Print / profile ----
  { id: "banner-image", platform: "Web", label: "Banner image", width: 1500, height: 500, kind: "image" },
  { id: "profile-photo", platform: "Any", label: "Profile photo (1:1)", width: 1000, height: 1000, kind: "image" },
];

export const SOCIAL_PRESET_GROUPS: { platform: string; presets: SocialPreset[] }[] = Array.from(
  new Set(SOCIAL_PRESETS.map((p) => p.platform)),
).map((platform) => ({ platform, presets: SOCIAL_PRESETS.filter((p) => p.platform === platform) }));

export function getSocialPreset(id: string): SocialPreset | undefined {
  return SOCIAL_PRESETS.find((p) => p.id === id);
}

export function aspectLabel(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}
