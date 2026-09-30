import {
  drawHumanoidMask,
  drawHandMask,
  addHairStrands,
  applyMotionTrail,
  applyOccluderBand,
  paintOccluderBand,
  paintBackground,
  composeScene,
  type SyntheticScene,
  type RgbColor,
} from "./scene-builder";

/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. The permanent VIDEO benchmark
 * dataset — every subcategory named in the phase brief, each a short
 * deterministic sequence of synthetic frames (with exact per-frame ground
 * truth — see scene-builder.ts's doc comment on why synthetic). Frame count
 * is deliberately small (matches this app's own real sparse-sampling
 * architecture for video AI matting, not a dense per-frame pipeline).
 */

export type VideoSubcategory =
  | "talking person"
  | "walking person"
  | "hand movement"
  | "hair movement"
  | "fast movement"
  | "occlusion"
  | "camera movement"
  | "changing background"
  | "scene cut";

export interface VideoDatasetCase {
  id: string;
  category: "video";
  subcategory: VideoSubcategory;
  description: string;
  width: number;
  height: number;
  fps: number;
  build: () => SyntheticScene[];
}

const W = 384;
const H = 384;
const FRAMES = 8;
const FPS = 4;

const SHIRT: RgbColor = { r: 40, g: 70, b: 110 };
const PLAIN_BG: RgbColor = { r: 235, g: 235, b: 235 };

function frameRange(): number[] {
  return Array.from({ length: FRAMES }, (_, i) => i);
}

export const VIDEO_CASES: VideoDatasetCase[] = [
  {
    id: "video-talking-person",
    category: "video",
    subcategory: "talking person",
    description: "Person silhouette in a fixed position with a small mouth region that opens and closes across frames — a proxy for a talking head.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const mask = drawHumanoidMask(W, H);
        const open = i % 2 === 0;
        if (open) {
          const cx = W / 2;
          const cy = H * 0.27;
          const mw = W * 0.03;
          const mh = H * 0.012;
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              if (Math.abs(x - cx) < mw && Math.abs(y - cy) < mh) mask[y * W + x] *= 0.5;
            }
          }
        }
        return composeScene(W, H, SHIRT, PLAIN_BG, mask);
      }),
  },
  {
    id: "video-walking-person",
    category: "video",
    subcategory: "walking person",
    description: "Person silhouette translating horizontally across the frame over time.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const cx = 0.3 + 0.4 * t;
        return composeScene(W, H, SHIRT, PLAIN_BG, drawHumanoidMask(W, H, { cx }));
      }),
  },
  {
    id: "video-hand-movement",
    category: "video",
    subcategory: "hand movement",
    description: "Person silhouette stationary while an independent hand-like appendage moves across frames (a gesture).",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const body = drawHumanoidMask(W, H);
        const hand = drawHandMask(W, H, 0.65 + 0.15 * Math.sin(t * Math.PI * 2), 0.5 - 0.1 * t);
        const merged = new Float32Array(body.length);
        for (let p = 0; p < merged.length; p++) merged[p] = Math.max(body[p], hand[p]);
        return composeScene(W, H, SHIRT, PLAIN_BG, merged);
      }),
  },
  {
    id: "video-hair-movement",
    category: "video",
    subcategory: "hair movement",
    description: "Person silhouette with a hair-strand fringe whose phase shifts each frame — a proxy for hair waving/swaying.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const phase = Math.sin(t * Math.PI * 2) * 0.3;
        const mask = addHairStrands(drawHumanoidMask(W, H), W, H, { density: 40, phase });
        return composeScene(W, H, SHIRT, PLAIN_BG, mask);
      }),
  },
  {
    id: "video-fast-movement",
    category: "video",
    subcategory: "fast movement",
    description: "Person silhouette with a large frame-to-frame position jump plus motion-trail blur — a proxy for fast subject motion.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const cx = 0.2 + 0.6 * t;
        const mask = applyMotionTrail(drawHumanoidMask(W, H, { cx, blurPx: 0 }), W, H, 30);
        return composeScene(W, H, SHIRT, PLAIN_BG, mask);
      }),
  },
  {
    id: "video-occlusion",
    category: "video",
    subcategory: "occlusion",
    description: "An opaque bar passes in front of the (stationary) subject partway through the sequence, hiding part of it — ground truth alpha in the hidden region is legitimately 0 while occluded.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const occluding = i >= 2 && i <= 5;
        const bandX = 0.35 + ((i - 2) / 3) * 0.3;
        let mask = drawHumanoidMask(W, H);
        if (occluding) mask = applyOccluderBand(mask, W, H, bandX);
        return composeScene(W, H, SHIRT, PLAIN_BG, mask, {
          paintOver: occluding ? (ctx) => paintOccluderBand(ctx, W, H, bandX) : undefined,
        });
      }),
  },
  {
    id: "video-camera-movement",
    category: "video",
    subcategory: "camera movement",
    description: "The whole scene (background pattern and subject position together) pans across frames — a proxy for camera movement rather than subject movement.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const pan = t * W * 0.6;
        const cx = 0.5 + (t - 0.5) * 0.15;
        return composeScene(W, H, SHIRT, { r: 190, g: 185, b: 170 }, drawHumanoidMask(W, H, { cx }), {
          paintBg: (ctx) => paintBackground(ctx, W, H, { r: 190, g: 185, b: 170 }, { textured: true, offsetX: pan }),
        });
      }),
  },
  {
    id: "video-changing-background",
    category: "video",
    subcategory: "changing background",
    description: "The background color shifts gradually partway through the sequence (a lighting/scene change) while the subject stays put — not an abrupt cut.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        const t = i / (FRAMES - 1);
        const bg: RgbColor = {
          r: Math.round(PLAIN_BG.r + (60 - PLAIN_BG.r) * t),
          g: Math.round(PLAIN_BG.g + (60 - PLAIN_BG.g) * t),
          b: Math.round(PLAIN_BG.b + (90 - PLAIN_BG.b) * t),
        };
        return composeScene(W, H, SHIRT, bg, drawHumanoidMask(W, H));
      }),
  },
  {
    id: "video-scene-cut",
    category: "video",
    subcategory: "scene cut",
    description:
      "An abrupt hard cut to a completely different composition halfway through the sequence — a real edit cut. " +
      "For today's frame-independent model (no temporal memory), the measured temporal-consistency error at the " +
      "cut is actually LOW — verified live: its own prediction jumps right along with the real content change, " +
      "since it has no state to smooth with. This case earns its keep for a FUTURE temporal/recurrent model: if " +
      "one is added and wrongly tries to smooth across a real cut instead of a genuine motion transition, its " +
      "prediction's delta would undershoot ground truth's, and THIS case is what would catch that as a real error.",
    width: W,
    height: H,
    fps: FPS,
    build: () =>
      frameRange().map((i) => {
        if (i < FRAMES / 2) {
          return composeScene(W, H, SHIRT, PLAIN_BG, drawHumanoidMask(W, H, { cx: 0.35 }));
        }
        return composeScene(W, H, { r: 150, g: 40, b: 40 }, { r: 30, g: 30, b: 35 }, drawHumanoidMask(W, H, { cx: 0.65, scale: 1.15 }));
      }),
  },
];

export function getVideoCase(id: string): VideoDatasetCase | undefined {
  return VIDEO_CASES.find((c) => c.id === id);
}
