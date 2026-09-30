import type { FractionRect } from "../../components/tool/video/RectOverlay";
import type { OverlayLayer } from "./overlay-layer";
import type { Anchor } from "./overlay-position";
import type { ImageEntranceAnimation } from "./media-animation";
import type { LogoRemovalMode } from "./logo-removal";
import { getSocialPreset } from "../social-presets";

export type TextAnimation =
  | "none"
  | "fade"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "pop"
  | "bounce";
export type TextPosition = "top" | "center" | "bottom";
export type ChromaReplace = "color" | "image" | "video" | "transparent";
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
  uppercase: boolean;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  outline: boolean;
  outlineColor: string;
  shadow: boolean;
  shadowColor: string;
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

export interface EditorLogoRegion {
  id: string;
  rect: FractionRect;
}

export interface EditorLogoState {
  enabled: boolean;
  regions: EditorLogoRegion[];
  /** "reconstruct" clones/blends in surrounding texture; "blur" just heavily
   * blurs each box in place — cheaper and more honest on busy backgrounds. */
  mode: LogoRemovalMode;
}

let logoRegionCounter = 0;
export function nextLogoRegionId(): string {
  logoRegionCounter += 1;
  return `logo-region-${logoRegionCounter}`;
}

export interface EditorCropState {
  enabled: boolean;
  rect: FractionRect;
}

export type BgFillMode = "blur" | "solid" | "gradient";
export type GradientDirection = "vertical" | "horizontal" | "diagonal";

/** Fits the source onto a target canvas (chosen by social-media preset or a
 * custom size) and fills the empty space around it — with a blurred/zoomed
 * copy of the video itself, a solid color, or a two-color gradient. */
export interface EditorBackgroundState {
  enabled: boolean;
  /** Key into SOCIAL_PRESETS, or "custom" to use customWidth/customHeight. */
  presetId: string;
  customWidth: number;
  customHeight: number;
  fillMode: BgFillMode;
  solidColor: string;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: GradientDirection;
}

export function resolveBackgroundSize(bg: EditorBackgroundState): { w: number; h: number } {
  if (bg.presetId !== "custom") {
    const preset = getSocialPreset(bg.presetId);
    if (preset) return { w: preset.width, h: preset.height };
  }
  return { w: Math.max(2, Math.round(bg.customWidth)), h: Math.max(2, Math.round(bg.customHeight)) };
}

export interface EditorMusicState {
  enabled: boolean;
  file: File | null;
  mode: "mix" | "replace";
}

export type DubMode = "replace" | "mix" | "duck";

/** A replacement/overdub voice track — recorded in-tool or uploaded — mixed
 * against the original audio in one of three ways: fully replace it, mix at
 * equal volume, or "duck" (keep the original quiet underneath the dub). */
export interface EditorDubState {
  enabled: boolean;
  file: File | null;
  mode: DubMode;
  /** Volume the original audio is lowered to under the dub, 0-1. Only used in "duck" mode. */
  duckLevel: number;
}

export interface EditorExtraClipState {
  enabled: boolean;
  file: File | null;
  kind: "image" | "video";
  position: ExtraClipPosition;
  imageDuration: number;
  animation: ImageEntranceAnimation;
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

export type { OverlayLayer, Anchor, ImageEntranceAnimation };
