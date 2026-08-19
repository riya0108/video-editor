import type { OverlayAnimation } from "./media-animation";

export interface OverlayLayer {
  id: string;
  kind: "image" | "video";
  file: File | Blob;
  previewUrl: string;
  label: string;
  /** Center point, as a percent of the frame (0-100). */
  x: number;
  y: number;
  sizePercent: number;
  opacity: number;
  start: number;
  end: number;
  animation: OverlayAnimation;
}

let counter = 0;
export function nextOverlayId(): string {
  counter += 1;
  return `overlay-${counter}`;
}
