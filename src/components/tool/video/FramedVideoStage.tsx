import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const DEFAULT_STAGE_MAX_HEIGHT = 480; // taller default so wide-screen tool pages fill more of the workspace
const ZERO_OFFSET = { x: 0, y: 0 };

/**
 * Fits a video (object-fit: contain, without relying on CSS which can't
 * report the letterboxed content box) inside a fixed-height stage, and
 * renders `children` in an absolutely-positioned layer sized to exactly
 * match the visible video content — so overlays (crop box, logo box) line
 * up with real pixels instead of any letterbox bars.
 */
export default function FramedVideoStage({
  videoRef,
  sourceUrl,
  naturalWidth,
  naturalHeight,
  onLoadedMetadata,
  onError,
  onTimeUpdate,
  onPlay,
  onPause,
  controls = false,
  overlayInteractive = true,
  /** Reshape the stage itself to this w:h ratio (e.g. {w:9,h:16}) instead of following the source video's own shape. */
  aspect = null,
  /** Caps the stage's height in pixels — draggable in the full Video Editor so the preview can trade space with the timeline. */
  maxHeight = DEFAULT_STAGE_MAX_HEIGHT,
  /** Multiplies the normal "contain" fit scale — 1 = fit, >1 = zoomed in. Grows `box` in real layout pixels (not a CSS transform), so overlay children's boxWidth/boxHeight-based pixel math stays correct. */
  zoom = 1,
  /** Pixel offset applied on top of the centered position, for panning a zoomed-in stage. */
  panOffset = ZERO_OFFSET,
  /** Render a live-processed <canvas> (fed by onDrawFrame) over the stage instead of the plain video — for effects (chroma key, background blur) that need real pixel access. The <video> stays mounted (hidden) as the frame/audio/playback source. */
  canvasMode = false,
  onDrawFrame,
  /** Swaps the stage's solid black backdrop for a checkerboard pattern — for canvasMode previews whose canvas can be genuinely transparent (e.g. a "transparent background" chroma-key/cutout preview), so unfilled pixels read as transparency instead of black. */
  checkerboard = false,
  /** Rendered as a stage-sized (not box-sized) absolutely-positioned top layer — for content with its own unrelated natural dimensions, like an intro/outro clip, that needs to cover the full frame rather than align to the main video's letterboxed content box. */
  stageOverlay,
  /**
   * Like `children`, but rendered OUTSIDE the stage's clipping boundary
   * instead of inside it — for chrome that floats near the frame (e.g. a
   * quick-style toolbar) rather than content that must be clipped to exactly
   * what the video shows. A toolbar wider than a narrow portrait-aspect
   * frame would otherwise get silently cut off by the frame's own edges.
   * Positioned to cover the same rect as the stage, so left/right/top/bottom
   * CSS inside it lines up the same way `children` would.
   */
  floatingOverlay,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourceUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  onLoadedMetadata?: () => void;
  onError?: () => void;
  onTimeUpdate?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  controls?: boolean;
  /** Set false for purely-visual overlays (e.g. caption preview) so clicks reach native video controls underneath. */
  overlayInteractive?: boolean;
  aspect?: { w: number; h: number } | null;
  maxHeight?: number;
  zoom?: number;
  panOffset?: { x: number; y: number };
  canvasMode?: boolean;
  checkerboard?: boolean;
  onDrawFrame?: (
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    dims: { stage: { width: number; height: number }; box: { width: number; height: number } },
  ) => void;
  children?: (box: { width: number; height: number }, stage: { width: number; height: number }) => ReactNode;
  stageOverlay?: ReactNode;
  floatingOverlay?: (box: { width: number; height: number }, stage: { width: number; height: number }) => ReactNode;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const update = () => setAvailableWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  let stage = { width: availableWidth, height: maxHeight };
  if (aspect && aspect.w > 0 && aspect.h > 0) {
    const ratio = aspect.w / aspect.h;
    let height = maxHeight;
    let width = height * ratio;
    if (availableWidth > 0 && width > availableWidth) {
      width = availableWidth;
      height = width / ratio;
    }
    stage = { width, height };
  }

  let box = stage;
  if (naturalWidth > 0 && naturalHeight > 0 && stage.width > 0) {
    const fitScale = Math.min(stage.width / naturalWidth, stage.height / naturalHeight);
    const scale = fitScale * zoom;
    box = { width: naturalWidth * scale, height: naturalHeight * scale };
  }
  const boxLeft = (stage.width - box.width) / 2 + panOffset.x;
  const boxTop = (stage.height - box.height) / 2 + panOffset.y;

  // Keep the draw loop reading fresh values without re-subscribing every render.
  const latest = useRef({ stage, box, onDrawFrame });
  latest.current = { stage, box, onDrawFrame };

  useEffect(() => {
    if (!canvasMode) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let stopped = false;
    let rafHandle: number | null = null;
    let vfcHandle: number | null = null;

    const draw = () => {
      if (stopped) return;
      const { stage: s, box: b, onDrawFrame: draw } = latest.current;
      if (s.width > 0 && s.height > 0 && draw) {
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(s.width * dpr);
        const targetH = Math.round(s.height * dpr);
        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          draw(ctx, video, { stage: s, box: b });
        }
      }
      schedule();
    };

    const schedule = () => {
      if (stopped) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        vfcHandle = video.requestVideoFrameCallback(draw);
      } else {
        rafHandle = requestAnimationFrame(draw);
      }
    };

    schedule();
    video.addEventListener("seeked", draw);
    return () => {
      stopped = true;
      video.removeEventListener("seeked", draw);
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      if (vfcHandle !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(vfcHandle);
      }
    };
  }, [canvasMode, videoRef]);

  // The loop above only redraws when a *new video frame* arrives —
  // `requestVideoFrameCallback` simply never fires again once the video is
  // paused. Without this, tweaking a live-effect control (chroma color,
  // background choice, etc.) on a paused source wouldn't touch the canvas
  // until playback resumed. This effect repaints once, immediately, whenever
  // the draw callback itself changes (i.e. whenever the caller's settings
  // change), independent of whether a new frame is available.
  useEffect(() => {
    if (!canvasMode || !onDrawFrame) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const { stage: s, box: b } = latest.current;
    if (s.width <= 0 || s.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(s.width * dpr);
    const targetH = Math.round(s.height * dpr);
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      onDrawFrame(ctx, video, { stage: s, box: b });
    }
  }, [canvasMode, onDrawFrame, videoRef, stage.width, stage.height, box.width, box.height]);

  return (
    <div ref={measureRef} className="relative w-full">
      <div
        className={`relative mx-auto flex items-center justify-center overflow-hidden rounded-lg ${checkerboard ? "bg-checkerboard" : "bg-black"}`}
        style={{ width: aspect ? stage.width || "100%" : "100%", height: stage.height }}
      >
        <video
          ref={videoRef}
          src={sourceUrl}
          onLoadedMetadata={onLoadedMetadata}
          onError={onError}
          onTimeUpdate={onTimeUpdate}
          onPlay={onPlay}
          onPause={onPause}
          controls={controls && !canvasMode}
          style={{
            width: box.width || undefined,
            height: box.height || undefined,
            visibility: canvasMode ? "hidden" : "visible",
            transform: panOffset.x || panOffset.y ? `translate(${panOffset.x}px, ${panOffset.y}px)` : undefined,
          }}
        />
        {canvasMode && (
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute"
            style={{ width: stage.width || undefined, height: stage.height || undefined, left: 0, top: 0 }}
          />
        )}
        {box.width > 0 && (
          <div
            className="pointer-events-none absolute"
            style={{
              width: box.width,
              height: box.height,
              left: boxLeft,
              top: boxTop,
            }}
          >
            <div className={`absolute inset-0 ${overlayInteractive ? "pointer-events-auto" : "pointer-events-none"}`}>
              {children?.(box, stage)}
            </div>
          </div>
        )}
        {stageOverlay && (
          <div className="pointer-events-none absolute inset-0" style={{ width: stage.width, height: stage.height }}>
            {stageOverlay}
          </div>
        )}
      </div>
      {floatingOverlay && stage.width > 0 && (
        <div
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2"
          style={{ width: stage.width, height: stage.height }}
        >
          {floatingOverlay(box, stage)}
        </div>
      )}
    </div>
  );
}
