import { useEffect, useMemo, useRef } from "react";
import type { EditorBgBlurState, EditorChromaKeyState } from "../ffmpeg/editor-state";
import { drawChromaKeyed } from "../media/chroma-key-canvas";
import { drawBgBlurFrame } from "../media/bg-blur-canvas";

const BG_ASPECT_RATIOS: Record<EditorBgBlurState["aspect"], { w: number; h: number }> = {
  "9:16": { w: 9, h: 16 },
  "1:1": { w: 1, h: 1 },
  "4:5": { w: 4, h: 5 },
  "16:9": { w: 16, h: 9 },
};

/**
 * Live preview for chroma key + background blur, which both need real pixel
 * access a plain <video> can't give. Owns the replacement image/video
 * lifecycle for chroma key, and produces a single `onDrawFrame` callback for
 * FramedVideoStage's canvas mode that chains the two effects in the same
 * order build-editor-command.ts uses (colorkey, then bgBlur).
 */
export function useChromaBgPreview({
  chromaKey,
  bgBlur,
}: {
  chromaKey: EditorChromaKeyState;
  bgBlur: EditorBgBlurState;
}) {
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!workCanvasRef.current && typeof document !== "undefined") {
    workCanvasRef.current = document.createElement("canvas");
  }

  const replacementImageRef = useRef<HTMLImageElement | null>(null);
  const replacementVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const file = chromaKey.replaceImageFile;
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
  }, [chromaKey.replaceImageFile]);

  useEffect(() => {
    const file = chromaKey.replaceVideoFile;
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
  }, [chromaKey.replaceVideoFile]);

  const canvasMode = chromaKey.enabled || bgBlur.enabled;
  const effectiveAspect = bgBlur.enabled ? BG_ASPECT_RATIOS[bgBlur.aspect] : null;

  const onDrawFrame = useMemo(() => {
    if (!canvasMode) return undefined;
    return (
      ctx: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      dims: { stage: { width: number; height: number }; box: { width: number; height: number } },
    ) => {
      let source: CanvasImageSource = video;
      let sourceW = video.videoWidth;
      let sourceH = video.videoHeight;

      if (chromaKey.enabled && workCanvasRef.current) {
        const replacementEl =
          chromaKey.replace === "image"
            ? replacementImageRef.current
            : chromaKey.replace === "video"
              ? replacementVideoRef.current
              : null;
        const keyed = drawChromaKeyed(video, chromaKey, replacementEl, workCanvasRef.current);
        source = keyed;
        sourceW = keyed.width;
        sourceH = keyed.height;
      }

      ctx.clearRect(0, 0, dims.stage.width, dims.stage.height);

      if (bgBlur.enabled) {
        const blurPx = Math.max(2, Math.round(dims.stage.width * 0.06));
        drawBgBlurFrame(ctx, source, sourceW, sourceH, dims.stage, dims.box, blurPx);
      } else {
        const left = (dims.stage.width - dims.box.width) / 2;
        const top = (dims.stage.height - dims.box.height) / 2;
        ctx.drawImage(source, left, top, dims.box.width, dims.box.height);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasMode, chromaKey, bgBlur]);

  return { canvasMode, effectiveAspect, onDrawFrame };
}
