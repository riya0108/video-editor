import type { FractionRect } from "../../components/tool/video/RectOverlay";
import type { OverlayLayer } from "./overlay-layer";
import type { Anchor } from "./overlay-position";

export type TextAnimation = "none" | "fade" | "slide-up" | "slide-down" | "pop";
export type TextPosition = "top" | "center" | "bottom";
export type BgAspect = "9:16" | "1:1" | "4:5" | "16:9";
export type ChromaReplace = "color" | "image" | "video";
export type ExtraClipPosition = "before" | "after";

export interface EditorTextState {
  enabled: boolean;
  content: string;
  color: string;
  fontSize: number;
  /** Anchor point of the text block, as a percent (0-100) of the frame — freely draggable, not limited to top/center/bottom. */
  x: number;
  y: number;
  fontId: string;
  animation: TextAnimation;
}

export interface EditorChromaKeyState {
  enabled: boolean;
  colorHex: string;
  similarity: number;
  blend: number;
  replace: ChromaReplace;
  replaceColorHex: string;
  replaceImageFile: File | null;
  replaceVideoFile: File | null;
}

export interface EditorNoiseState {
  enabled: boolean;
  strength: number;
}

export interface EditorLogoState {
  enabled: boolean;
  rect: FractionRect;
}

export interface EditorCropState {
  enabled: boolean;
  rect: FractionRect;
}

export interface EditorBgBlurState {
  enabled: boolean;
  aspect: BgAspect;
}

export interface EditorMusicState {
  enabled: boolean;
  file: File | null;
  mode: "mix" | "replace";
}

export interface EditorExtraClipState {
  enabled: boolean;
  file: File | null;
  kind: "image" | "video";
  position: ExtraClipPosition;
  imageDuration: number;
}

export interface EditorFadeState {
  in: number;
  out: number;
}

export type QualityTarget = "original" | "720p" | "1080p" | "4k";

export interface EditorQualityState {
  target: QualityTarget;
  /** Light unsharp pass — mainly useful when upscaling to a larger target. */
  sharpen: boolean;
}

export type { OverlayLayer, Anchor };
