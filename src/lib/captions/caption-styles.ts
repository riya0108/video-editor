import type { CaptionStyle } from "./types";

export interface CaptionStylePreset {
  id: string;
  label: string;
  style: CaptionStyle;
}

// A handful of common caption looks (styled after what you'd find in
// tools like Veed/CapCut): a clean boxed classic, a bold all-caps impact
// style, a plain minimal style, a solid highlight block, and a colorful
// outlined pop style.
export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
  {
    id: "classic",
    label: "Classic",
    style: {
      fontId: "geist",
      color: "#ffffff",
      fontSize: 44,
      position: "bottom",
      uppercase: false,
      background: true,
      backgroundColor: "#000000",
      outline: false,
      outlineColor: "#000000",
      karaoke: false,
      highlightColor: "#facc15",
    },
  },
  {
    id: "bold-impact",
    label: "Bold Impact",
    style: {
      fontId: "anton",
      color: "#ffffff",
      fontSize: 50,
      position: "bottom",
      uppercase: true,
      background: false,
      backgroundColor: "#000000",
      outline: true,
      outlineColor: "#000000",
      karaoke: false,
      highlightColor: "#facc15",
    },
  },
  {
    id: "minimal",
    label: "Minimal White",
    style: {
      fontId: "geist",
      color: "#ffffff",
      fontSize: 40,
      position: "bottom",
      uppercase: false,
      background: false,
      backgroundColor: "#000000",
      outline: true,
      outlineColor: "#000000",
      karaoke: false,
      highlightColor: "#facc15",
    },
  },
  {
    id: "highlight",
    label: "Highlight",
    style: {
      fontId: "bebas",
      color: "#000000",
      fontSize: 48,
      position: "bottom",
      uppercase: true,
      background: true,
      backgroundColor: "#facc15",
      outline: false,
      outlineColor: "#000000",
      karaoke: false,
      highlightColor: "#ef4444",
    },
  },
  {
    id: "neon-pop",
    label: "Neon Pop",
    style: {
      fontId: "bebas",
      color: "#38bdf8",
      fontSize: 48,
      position: "bottom",
      uppercase: true,
      background: false,
      backgroundColor: "#000000",
      outline: true,
      outlineColor: "#0f172a",
      karaoke: false,
      highlightColor: "#facc15",
    },
  },
  {
    id: "karaoke-classic",
    label: "Karaoke",
    style: {
      fontId: "geist",
      color: "#ffffff",
      fontSize: 46,
      position: "bottom",
      uppercase: false,
      background: true,
      backgroundColor: "#000000",
      outline: false,
      outlineColor: "#000000",
      karaoke: true,
      highlightColor: "#facc15",
    },
  },
  {
    id: "creator-block",
    label: "Creator Block",
    style: {
      fontId: "anton",
      color: "#0f172a",
      fontSize: 46,
      position: "center",
      uppercase: true,
      background: true,
      backgroundColor: "#ffffff",
      outline: false,
      outlineColor: "#000000",
      karaoke: true,
      highlightColor: "#22c55e",
    },
  },
  {
    id: "clean-outline",
    label: "Clean Outline",
    style: {
      fontId: "geist",
      color: "#ffffff",
      fontSize: 42,
      position: "top",
      uppercase: false,
      background: false,
      backgroundColor: "#000000",
      outline: true,
      outlineColor: "#1d4ed8",
      karaoke: false,
      highlightColor: "#facc15",
    },
  },
];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_STYLE_PRESETS[0].style;

export const CAPTION_COLORS = [
  "#ffffff",
  "#000000",
  "#facc15",
  "#ef4444",
  "#22c55e",
  "#38bdf8",
];
