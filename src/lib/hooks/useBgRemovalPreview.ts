import { useEffect, useMemo, useRef } from "react";
import {
  keyChromaForeground,
  compositeBgRemoval,
  type BgReplaceMode,
  type BgGradientDirection,
  type ChromaSettings,
} from "../media/bg-removal-canvas";
import { nearestCutoutFrame, type CutoutFrame } from "../captions/person-cutout";

export interface BgRemovalReplaceState {
  mode: BgReplaceMode;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: BgGradientDirection;
  imageFile: File | null;
  videoFile: File | null;
}

/**
 * Live preview for the standalone Remove Background tool: composites either
 * a chroma-keyed frame (green-screen mode) or the nearest sampled AI cutout
 * frame (no-green-screen mode) onto the chosen replacement background, as a
 * single onDrawFrame for FramedVideoStage's canvas mode. Mirrors the full
 * Video Editor's useChromaBgPreview, but standalone — no editor document
 * state, and adds "transparent" as a real replace mode instead of always
 * compositing onto something.
 */
export function useBgRemovalPreview({
  mode,
  chroma,
  replace,
  cutoutFrames,
}: {
  mode: "chroma" | "ai";
  chroma: ChromaSettings;
  replace: BgRemovalReplaceState;
  cutoutFrames: CutoutFrame[];
}) {
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!workCanvasRef.current && typeof document !== "undefined") {
    workCanvasRef.current = document.createElement("canvas");
  }

  const replacementImageRef = useRef<HTMLImageElement | null>(null);
  const replacementVideoRef = useRef<HTMLVideoElement | null>(null);
  const cutoutImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    const file = replace.imageFile;
    if (!file) {
      replacementImageRef.current = null;
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    replacementImageRef.current = img;
    return () => {
      URL.revokeObjectURL(url);
      replacementImageRef.current = null;
    };
  }, [replace.imageFile]);

  useEffect(() => {
    const file = replace.videoFile;
    if (!file) {
      replacementVideoRef.current = null;
      return;
    }
    const url = URL.createObjectURL(file);
    const vid = document.createElement("video");
    vid.src = url;
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.play().catch(() => {});
    replacementVideoRef.current = vid;
    return () => {
      vid.pause();
      URL.revokeObjectURL(url);
      replacementVideoRef.current = null;
    };
  }, [replace.videoFile]);

  // Keep a live <img> for each sampled cutout frame so the sync draw loop
  // never has to await a decode — frames are pre-warmed as soon as they land.
  useEffect(() => {
    const cache = cutoutImagesRef.current;
    const validUrls = new Set(cutoutFrames.map((f) => f.url));
    for (const url of Array.from(cache.keys())) {
      if (!validUrls.has(url)) cache.delete(url);
    }
    for (const f of cutoutFrames) {
      if (!cache.has(f.url)) {
        const img = new Image();
        img.src = f.url;
        cache.set(f.url, img);
      }
    }
  }, [cutoutFrames]);

  const canvasMode = mode === "chroma" || cutoutFrames.length > 0;

  const onDrawFrame = useMemo(() => {
    if (!canvasMode) return undefined;
    return (
      ctx: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      dims: { stage: { width: number; height: number }; box: { width: number; height: number } },
    ) => {
      let foreground: CanvasImageSource | null = null;

      if (mode === "chroma" && workCanvasRef.current) {
        foreground = keyChromaForeground(video, video.videoWidth, video.videoHeight, chroma, workCanvasRef.current);
      } else if (mode === "ai") {
        const frame = nearestCutoutFrame(cutoutFrames, video.currentTime);
        const el = frame ? cutoutImagesRef.current.get(frame.url) : null;
        if (el && el.complete && el.naturalWidth > 0) foreground = el;
      }

      if (!foreground) {
        ctx.clearRect(0, 0, dims.stage.width, dims.stage.height);
        return;
      }

      const blurPx = Math.max(2, Math.round(dims.stage.width * 0.06));
      compositeBgRemoval(
        ctx,
        video,
        video.videoWidth,
        video.videoHeight,
        foreground,
        dims.stage,
        dims.box,
        {
          mode: replace.mode,
          color: replace.color,
          gradientFrom: replace.gradientFrom,
          gradientTo: replace.gradientTo,
          gradientDirection: replace.gradientDirection,
          imageEl: replacementImageRef.current,
          videoEl: replacementVideoRef.current,
        },
        blurPx,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasMode, mode, chroma, cutoutFrames, replace]);

  return { canvasMode, checkerboard: replace.mode === "transparent", onDrawFrame };
}
