import type { Anchor } from "./overlay-position";

export interface OverlayLayer {
  id: string;
  kind: "image" | "video";
  file: File | Blob;
  previewUrl: string;
  label: string;
  anchor: Anchor;
  sizePercent: number;
  opacity: number;
  start: number;
  end: number;
}

let counter = 0;
export function nextOverlayId(): string {
  counter += 1;
  return `overlay-${counter}`;
}
