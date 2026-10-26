import type { FractionRect } from "../../components/tool/video/RectOverlay";
import type { LogoKeyframe } from "./logo-removal";
import { waitForSeek } from "../captions/person-cutout";
import { getSharedModelRegistry } from "../matting/models/registry";
import { supportsImage } from "../matting/types";

export interface PersonTrackProgress {
  phase: "downloading" | "processing";
  /** 0-1 */
  fraction: number;
}

export interface PersonTrackResult {
  /** Fixed size for the tracked region — big enough to cover the person at every sampled frame. */
  rect: FractionRect;
  /** One position per sampled frame; feeds straight into a Region's `keyframes`. */
  keyframes: LogoKeyframe[];
}

// Foreground segmentation (unlike detecting "a watermark") is a real,
// pre-trained capability already in this app — U²-Net (Apache-2.0, bundled in
// /public/models, shared with Remove Background) — so unlike Smart watermark
// detection, this one genuinely is a small model inference pass, not a CV
// heuristic. (It used RMBG-1.4 until 2026-10; that model is non-commercial —
// see MODEL_LICENSES.md.)
const MAX_SAMPLES = 10;
const MASK_THRESHOLD = 0.35;
const MAX_ANALYSIS_WIDTH = 480;

/** Bounding box of the foreground (alpha 0..1 above the threshold), as fractions of the frame. */
function boundingBoxFraction(mask: { data: Float32Array; width: number; height: number }): FractionRect | null {
  const { data, width, height } = mask;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > MASK_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height };
}

/**
 * Samples a handful of frames across [start, end], runs the U²-Net
 * foreground-segmentation model (the one Remove Background uses) on each one,
 * and turns the detected person's bounding box per frame into a fixed-size
 * region plus one keyframe per sample — ready to hand straight to a Region's
 * `keyframes` so the delogo patch tracks the person's movement.
 */
export async function detectPersonTrack(
  video: HTMLVideoElement,
  { start, end, onProgress }: { start: number; end: number; onProgress?: (p: PersonTrackProgress) => void },
): Promise<PersonTrackResult | null> {
  const duration = Math.max(0, end - start);
  if (duration <= 0 || video.videoWidth === 0) return null;

  const u2net = getSharedModelRegistry().find((m) => m.capabilities.modelId === "u2net");
  if (!u2net || !supportsImage(u2net)) throw new Error("The foreground model isn't available.");
  await u2net.load((fraction) => onProgress?.({ phase: "downloading", fraction }));

  const naturalW = video.videoWidth;
  const naturalH = video.videoHeight;
  const scale = Math.min(1, MAX_ANALYSIS_WIDTH / naturalW);
  const w = Math.max(2, Math.round((naturalW * scale) / 2) * 2);
  const h = Math.max(2, Math.round((naturalH * scale) / 2) * 2);

  const sampleCount = Math.max(2, Math.min(MAX_SAMPLES, Math.round(duration * 2)));
  const times: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    times.push(start + (duration * i) / (sampleCount - 1));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  video.pause();

  const samples: { t: number; rect: FractionRect }[] = [];
  try {
    for (let i = 0; i < times.length; i++) {
      video.currentTime = times[i];
      await waitForSeek(video);
      ctx.drawImage(video, 0, 0, w, h);

      // The box is a FRACTION of the frame, so the model's native output resolution is fine as is.
      const out = await u2net.inferImage({ source: canvas, width: w, height: h });
      const rect = boundingBoxFraction({ data: out.alpha, width: out.alphaWidth, height: out.alphaHeight });
      if (rect) samples.push({ t: times[i], rect });
      onProgress?.({ phase: "processing", fraction: (i + 1) / times.length });
    }
  } finally {
    video.currentTime = originalTime;
    if (!wasPaused) video.play().catch(() => {});
  }

  if (samples.length === 0) return null;

  const maxW = Math.min(1, Math.max(...samples.map((s) => s.rect.w)) * 1.15);
  const maxH = Math.min(1, Math.max(...samples.map((s) => s.rect.h)) * 1.15);

  const keyframes: LogoKeyframe[] = samples.map((s) => {
    const cx = s.rect.x + s.rect.w / 2;
    const cy = s.rect.y + s.rect.h / 2;
    return {
      t: s.t,
      x: Math.min(Math.max(0, cx - maxW / 2), 1 - maxW),
      y: Math.min(Math.max(0, cy - maxH / 2), 1 - maxH),
    };
  });

  return { rect: { x: keyframes[0].x, y: keyframes[0].y, w: maxW, h: maxH }, keyframes };
}
