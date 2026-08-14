import { evenRound } from "../geometry";
import type { QualityTarget } from "./editor-state";

const QUALITY_HEIGHTS: Record<Exclude<QualityTarget, "original">, number> = {
  "720p": 720,
  "1080p": 1080,
  "4k": 2160,
};

export const QUALITY_LABELS: Record<QualityTarget, string> = {
  original: "Original",
  "720p": "720p (HD)",
  "1080p": "1080p (Full HD)",
  "4k": "4K (Ultra HD)",
};

/** Resolves a quality target against the source size — only ever scales up (this picker is for upscaling on export, not resizing down; the Resize tool covers that). Returns null when the source already meets or exceeds the target. */
export function resolveQualityTarget(
  target: QualityTarget,
  currentW: number,
  currentH: number,
): { w: number; h: number } | null {
  if (target === "original" || currentW <= 0 || currentH <= 0) return null;
  const targetH = QUALITY_HEIGHTS[target];
  if (currentH >= targetH) return null;
  const scale = targetH / currentH;
  return { w: evenRound(currentW * scale), h: evenRound(targetH) };
}

/** Fast, fully client-side upscale: lanczos-resampled scaling plus an optional light unsharp pass to counter the softness scaling up introduces. Not AI super-resolution — a filter-based approximation that stays quick in ffmpeg.wasm. */
export function upscaleFilter(w: number, h: number, sharpen: boolean): string {
  const parts = [`scale=${w}:${h}:flags=lanczos`];
  if (sharpen) parts.push("unsharp=5:5:0.8:5:5:0.4");
  return parts.join(",");
}
