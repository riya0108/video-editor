import { useEffect, useMemo, useRef } from "react";
import type { EditorBackgroundState, EditorChromaKeyState } from "../ffmpeg/editor-state";
import { resolveBackgroundSize } from "../ffmpeg/editor-state";
import { drawChromaKeyed } from "../media/chroma-key-canvas";
import { drawBgFillFrame } from "../media/bg-blur-canvas";

/**
 * Live preview for chroma key + background reframe, which both need real
 * pixel access a plain <video> can't give. Owns the replacement image/video
 * lifecycle for chroma key, and produces a single `onDrawFrame` callback for
 * FramedVideoStage's canvas mode that chains the two effects in the same
 * order build-editor-command.ts uses (colorkey, then background fill).
 */
export function useChromaBgPreview({
  chromaKey,
  background,
}: {
  chromaKey: EditorChromaKeyState;
  background: EditorBackgroundState;
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

  const canvasMode = chromaKey.enabled || background.enabled;
  const effectiveAspect = background.enabled ? resolveBackgroundSize(background) : null;
  // Real transparency preview only makes sense standing alone — same rule
  // build-editor-command.ts uses for whether the export actually carries alpha.
  const checkerboard = chromaKey.enabled && chromaKey.replace === "transparent" && !background.enabled;

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

      if (background.enabled) {
        const blurPx = Math.max(2, Math.round(dims.stage.width * 0.06));
        drawBgFillFrame(ctx, source, sourceW, sourceH, dims.stage, dims.box, {
          mode: background.fillMode,
          blurPx,
          solidColor: background.solidColor,
          gradientFrom: background.gradientFrom,
          gradientTo: background.gradientTo,
          gradientDirection: background.gradientDirection,
        });
      } else {
        const left = (dims.stage.width - dims.box.width) / 2;
        const top = (dims.stage.height - dims.box.height) / 2;
        ctx.drawImage(source, left, top, dims.box.width, dims.box.height);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasMode, chromaKey, background]);

  return { canvasMode, effectiveAspect, checkerboard, onDrawFrame };
}
