import type { CaptionStyle } from "./types";

export type CaptionStyleCategory = "Basic" | "Big & Bold" | "Highlight" | "Fade" | "Content-aware";

export interface CaptionStylePreset {
  id: string;
  label: string;
  category: CaptionStyleCategory;
  style: CaptionStyle;
}

const BASE: CaptionStyle = {
  fontId: "geist",
  color: "#ffffff",
  fontSize: 44,
  x: 50,
  y: 90,
  uppercase: false,
  background: true,
  backgroundColor: "#000000",
  outline: false,
  outlineColor: "#000000",
  karaoke: false,
  highlightColor: "#facc15",
  fade: false,
  occludeByPerson: false,
};

// A spread of common caption looks (styled after what you'd find in tools
// like Veed/CapCut), grouped the same way a style gallery would group them:
// plain readable basics, oversized/bold attention-grabbers, word-by-word
// highlight styles, fading-in styles, and content-aware placement.
export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    category: "Basic",
    style: { ...BASE },
  },
  {
    id: "minimal",
    label: "Minimal White",
    category: "Basic",
    style: { ...BASE, fontSize: 40, background: false, outline: true, outlineColor: "#000000" },
  },
  {
    id: "clean-outline",
    label: "Clean Outline",
    category: "Basic",
    style: {
      ...BASE,
      fontSize: 42,
      y: 12,
      background: false,
      outline: true,
      outlineColor: "#1d4ed8",
    },
  },
  {
    id: "creator-block",
    label: "Creator Block",
    category: "Basic",
    style: {
      ...BASE,
      fontId: "anton",
      color: "#0f172a",
      fontSize: 46,
      y: 50,
      uppercase: true,
      background: true,
      backgroundColor: "#ffffff",
      karaoke: true,
      highlightColor: "#22c55e",
    },
  },

  {
    id: "big-caption",
    label: "Big Caption",
    category: "Big & Bold",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 84,
      uppercase: true,
      background: false,
      outline: true,
      outlineColor: "#000000",
    },
  },
  {
    id: "bold-impact",
    label: "Bold Impact",
    category: "Big & Bold",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 50,
      uppercase: true,
      background: false,
      outline: true,
      outlineColor: "#000000",
    },
  },
  {
    id: "bold-red",
    label: "Bold Red",
    category: "Big & Bold",
    style: {
      ...BASE,
      fontId: "anton",
      color: "#ffffff",
      fontSize: 60,
      uppercase: true,
      background: true,
      backgroundColor: "#dc2626",
    },
  },
  {
    id: "highlight",
    label: "Yellow Block",
    category: "Big & Bold",
    style: {
      ...BASE,
      fontId: "bebas",
      color: "#000000",
      fontSize: 48,
      uppercase: true,
      background: true,
      backgroundColor: "#facc15",
      highlightColor: "#ef4444",
    },
  },
  {
    id: "neon-pop",
    label: "Neon Pop",
    category: "Big & Bold",
    style: {
      ...BASE,
      fontId: "bebas",
      color: "#38bdf8",
      fontSize: 48,
      uppercase: true,
      background: false,
      outline: true,
      outlineColor: "#0f172a",
    },
  },

  {
    id: "karaoke-classic",
    label: "Word Highlight",
    category: "Highlight",
    style: { ...BASE, fontSize: 46, karaoke: true, highlightColor: "#facc15" },
  },
  {
    id: "karaoke-bold",
    label: "Bold Highlight",
    category: "Highlight",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 56,
      uppercase: true,
      background: false,
      outline: true,
      outlineColor: "#000000",
      karaoke: true,
      highlightColor: "#22c55e",
    },
  },
  {
    id: "karaoke-pink",
    label: "Pink Highlight",
    category: "Highlight",
    style: {
      ...BASE,
      fontId: "bebas",
      fontSize: 50,
      uppercase: true,
      background: true,
      backgroundColor: "#000000",
      karaoke: true,
      highlightColor: "#ec4899",
    },
  },

  {
    id: "fade-classic",
    label: "Soft Fade",
    category: "Fade",
    style: { ...BASE, fontSize: 42, background: false, outline: true, outlineColor: "#000000", fade: true },
  },
  {
    id: "fade-bold",
    label: "Fade & Bold",
    category: "Fade",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 52,
      uppercase: true,
      background: true,
      backgroundColor: "#000000",
      fade: true,
    },
  },

  {
    id: "behind-person",
    label: "Behind Person",
    category: "Content-aware",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 72,
      y: 50,
      uppercase: true,
      background: false,
      outline: false,
      occludeByPerson: true,
    },
  },
  {
    id: "behind-person-highlight",
    label: "Behind Person + Highlight",
    category: "Content-aware",
    style: {
      ...BASE,
      fontId: "anton",
      fontSize: 64,
      y: 50,
      uppercase: true,
      background: false,
      karaoke: true,
      highlightColor: "#facc15",
      occludeByPerson: true,
    },
  },
];

export const CAPTION_STYLE_CATEGORIES: CaptionStyleCategory[] = [
  "Basic",
  "Big & Bold",
  "Highlight",
  "Fade",
  "Content-aware",
];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_STYLE_PRESETS[0].style;

export const CAPTION_COLORS = [
  "#ffffff",
  "#000000",
  "#facc15",
  "#ef4444",
  "#22c55e",
  "#38bdf8",
  "#a855f7",
  "#ec4899",
  "#f97316",
  "#14b8a6",
];
