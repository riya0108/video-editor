import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SplitSquareHorizontal, Columns2, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import ToolUploadScreen from "../ToolUploadScreen";
import Dropzone from "../Dropzone";
import ComparisonCanvas from "./comparison/ComparisonCanvas";
import BeforeAfterSlider from "./comparison/BeforeAfterSlider";
import Scrubber from "./comparison/Scrubber";
import { validateUploadedMediaFile } from "../../../lib/media/upload-validation";
import { useAiImageMatte } from "../../../lib/hooks/useAiImageMatte";
import { useVideoClock } from "../../../lib/hooks/useVideoClock";
import { drawSourceToRgba, removeBackgroundFromImage, type MattingResult } from "../../../lib/matting/pipeline";
import { waitForSeek } from "../../../lib/captions/person-cutout";
import { sampleVideoMatte, nearestSampleAtOrBefore, type ViewerSample } from "../../../lib/matting/viewer/video-sampling";
import { computeViewBuffer, IMAGE_VIEW_MODES, type ImageViewMode } from "../../../lib/matting/viewer/visualize";
import { DEFAULT_VIEWPORT_STATE, type ViewportState } from "../../../lib/matting/pipeline/refine/viewport";

/**
 * MATTE COMPARISON VIEWER — internal diagnostic tool. Runs the real,
 * unmodified production matting pipeline (`removeBackgroundFromImage`)
 * against a real user upload and shows it across several visualizations.
 * Nothing here changes anything under `src/lib/matting/pipeline/**` — see
 * `visualize.ts`/`video-sampling.ts` for the (also diagnostic-only, reuse-
 * first) supporting logic.
 *
 * "Background selector" and "checkerboard toggle" (two separately-named
 * features in the brief) are implemented as ONE unified backdrop control
 * for the "AI Result" view — checkerboard is one of its options, so
 * selecting it IS the checkerboard toggle; the other options (black/white/
 * custom) are the background selector. This avoids two controls that would
 * otherwise just duplicate each other in practice; the three fixed preset
 * views (Black/White/Checkerboard Composite) remain separate, always-
 * available reference views regardless of this selector's current setting.
 */

type Backdrop = "checkerboard" | "black" | "white" | "custom";
type LayoutMode = "side-by-side" | "slider";
const ASSUMED_FPS_DEFAULT = 30;

/**
 * `Uint8ClampedArray` values sourced from `getImageData().data` (or plain
 * `Uint8ClampedArray` return-type annotations without an explicit buffer
 * generic) type as `Uint8ClampedArray<ArrayBufferLike>` in this TS lib
 * version, which `new ImageData(...)`'s stricter `ArrayBuffer`-only overload
 * rejects — a real type-narrowing issue, not a runtime one (browsers never
 * actually hand back a `SharedArrayBuffer`-backed pixel buffer here).
 * Copy-constructing always yields a concretely `ArrayBuffer`-backed array.
 */
function toImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  return new ImageData(new Uint8ClampedArray(data), width, height);
}

function fillRect(ctx: CanvasRenderingContext2D, width: number, height: number, color: string) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
}

function drawAiResult(ctx: CanvasRenderingContext2D, foreground: HTMLCanvasElement, width: number, height: number, backdrop: Backdrop, customColor: string) {
  ctx.clearRect(0, 0, width, height);
  if (backdrop === "black") fillRect(ctx, width, height, "#000000");
  else if (backdrop === "white") fillRect(ctx, width, height, "#ffffff");
  else if (backdrop === "custom") fillRect(ctx, width, height, customColor);
  // "checkerboard": leave the canvas itself transparent — ComparisonCanvas's
  // own `checkerboardBackdrop` prop shows the real CSS checkerboard through it.
  ctx.drawImage(foreground, 0, 0, width, height);
}

function BackdropControl({ backdrop, onChange, customColor, onCustomColor }: { backdrop: Backdrop; onChange: (b: Backdrop) => void; customColor: string; onCustomColor: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-caption text-(--color-text-muted)">Backdrop</span>
      {(["checkerboard", "black", "white", "custom"] as const).map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onChange(b)}
          className={`rounded-md border px-2 py-1 text-caption font-medium capitalize transition-colors ${
            backdrop === b ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300" : "border-(--color-border) hover:border-(--color-border-strong)"
          }`}
        >
          {b}
        </button>
      ))}
      {backdrop === "custom" && (
        <input type="color" value={customColor} onChange={(e) => onCustomColor(e.target.value)} className="h-6 w-8 cursor-pointer rounded border border-(--color-border)" />
      )}
    </div>
  );
}

function ViewModeControl({ mode, onChange }: { mode: ImageViewMode; onChange: (m: ImageViewMode) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {IMAGE_VIEW_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(m.id)}
          className={`rounded-md border px-2.5 py-1 text-caption font-medium transition-colors ${
            mode === m.id ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300" : "border-(--color-border) hover:border-(--color-border-strong)"
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function ViewportControls({ viewport, onFit, onHundred }: { viewport: ViewportState; onFit: () => void; onHundred: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-caption text-(--color-text-muted)">Zoom {(viewport.zoom * 100).toFixed(0)}%</span>
      <button type="button" onClick={onHundred} className="rounded-md border border-(--color-border) px-2 py-1 text-caption font-medium hover:border-(--color-border-strong)">
        100%
      </button>
      <button type="button" onClick={onFit} className="rounded-md border border-(--color-border) px-2 py-1 text-caption font-medium hover:border-(--color-border-strong)">
        Fit
      </button>
    </div>
  );
}

function LayoutToggle({ layout, onChange }: { layout: LayoutMode; onChange: (l: LayoutMode) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-0.5">
      <button
        type="button"
        onClick={() => onChange("side-by-side")}
        title="Side-by-side"
        className={`grid h-7 w-7 place-items-center rounded ${layout === "side-by-side" ? "bg-primary-100 text-primary-700 dark:bg-primary-950/40" : ""}`}
      >
        <Columns2 size={15} />
      </button>
      <button
        type="button"
        onClick={() => onChange("slider")}
        title="Before/after slider"
        className={`grid h-7 w-7 place-items-center rounded ${layout === "slider" ? "bg-primary-100 text-primary-700 dark:bg-primary-950/40" : ""}`}
      >
        <SplitSquareHorizontal size={15} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IMAGE MODE
// ---------------------------------------------------------------------------

function ImageComparisonView({ sourceUrl }: { sourceUrl: string }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sourceRgba, setSourceRgba] = useState<Uint8ClampedArray | null>(null);
  const matte = useAiImageMatte();

  const [viewMode, setViewMode] = useState<ImageViewMode>("ai-result");
  const [backdrop, setBackdrop] = useState<Backdrop>("checkerboard");
  const [customColor, setCustomColor] = useState("#22c55e");
  const [layout, setLayout] = useState<LayoutMode>("side-by-side");
  const [viewport, setViewport] = useState<ViewportState>(DEFAULT_VIEWPORT_STATE);
  const stageRef = useRef<HTMLDivElement>(null);

  const handleImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setWidth(img.naturalWidth);
    setHeight(img.naturalHeight);
    setSourceRgba(drawSourceToRgba(img, img.naturalWidth, img.naturalHeight));
  };

  useEffect(() => {
    if (width > 0 && height > 0 && !matte.result && !matte.isProcessing && imgRef.current) {
      matte.generate(imgRef.current, width, height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const viewBuffer = useMemo(() => {
    if (!matte.result || !sourceRgba || viewMode === "original" || viewMode === "ai-result") return null;
    return computeViewBuffer(viewMode, sourceRgba, matte.result.alpha, width, height);
  }, [matte.result, sourceRgba, viewMode, width, height]);

  const drawOriginal = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!sourceRgba) return;
      ctx.putImageData(toImageData(sourceRgba, width, height), 0, 0);
    },
    [sourceRgba, width, height],
  );

  const drawAfter = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!matte.result) return;
      if (viewMode === "original") return drawOriginal(ctx);
      if (viewMode === "ai-result") return drawAiResult(ctx, matte.result.foreground, width, height, backdrop, customColor);
      if (viewBuffer) ctx.putImageData(toImageData(viewBuffer, width, height), 0, 0);
    },
    [matte.result, viewMode, viewBuffer, width, height, backdrop, customColor, drawOriginal],
  );

  const handleFit = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || width === 0 || height === 0) return;
    // Side-by-side shows each pane at half the stage's width (a
    // `grid-cols-2` split) — fitting against the full stage width would
    // leave each pane's content only half-visible.
    const paneWidth = layout === "side-by-side" ? rect.width / 2 : rect.width;
    const zoom = Math.min(paneWidth / width, rect.height / height) * 0.95;
    setViewport({ zoom, panX: (paneWidth - width * zoom) / 2, panY: (rect.height - height * zoom) / 2 });
  };
  const handleHundred = () => setViewport((v) => ({ ...v, zoom: 1 }));

  // Side-by-side and slider mode fit against different pane widths (half
  // the stage vs. the full stage) — without this, switching layout reuses
  // whichever mode's zoom/pan was last computed, which can park the image
  // entirely outside the "after" pane's clip region in slider mode (it
  // looks blank, not just mis-fit). Re-fit whenever layout changes so the
  // two modes never hand off a geometrically incompatible viewport.
  useEffect(() => {
    handleFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return (
    <div className="flex flex-col gap-4">
      {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
      <img ref={imgRef} src={sourceUrl} alt="Uploaded source" onLoad={handleImageLoad} onError={() => setError("Your browser couldn't read this image.")} className="hidden" />

      {error && <p className="text-body-sm text-danger-600">{error}</p>}

      {matte.isProcessing && (
        <div className="flex items-center gap-2 rounded-md bg-(--color-bg-subtle) px-3 py-2 text-caption text-(--color-text-muted)">
          <Loader2 size={14} className="animate-spin" /> Running the AI matting pipeline…
        </div>
      )}
      {matte.error && <p className="text-body-sm text-danger-600">{matte.error}</p>}

      {matte.result && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <ViewModeControl mode={viewMode} onChange={setViewMode} />
            <div className="flex items-center gap-3">
              {viewMode === "ai-result" && <BackdropControl backdrop={backdrop} onChange={setBackdrop} customColor={customColor} onCustomColor={setCustomColor} />}
              <LayoutToggle layout={layout} onChange={setLayout} />
              <ViewportControls viewport={viewport} onFit={handleFit} onHundred={handleHundred} />
            </div>
          </div>

          <div ref={stageRef} style={{ height: 520 }} className="overflow-hidden rounded-xl border border-(--color-border)">
            {layout === "side-by-side" ? (
              <div className="grid h-full grid-cols-2 divide-x divide-(--color-border)">
                <ComparisonCanvas width={width} height={height} draw={drawOriginal} viewport={viewport} onViewportChange={setViewport} label="Original" />
                <ComparisonCanvas
                  width={width}
                  height={height}
                  draw={drawAfter}
                  viewport={viewport}
                  onViewportChange={setViewport}
                  checkerboardBackdrop={viewMode === "ai-result" && backdrop === "checkerboard"}
                  label={IMAGE_VIEW_MODES.find((m) => m.id === viewMode)?.label}
                />
              </div>
            ) : (
              <BeforeAfterSlider
                viewport={viewport}
                onViewportChange={setViewport}
                beforeLabel="Original"
                afterLabel={IMAGE_VIEW_MODES.find((m) => m.id === viewMode)?.label}
                before={<ComparisonCanvas width={width} height={height} draw={drawOriginal} viewport={viewport} onViewportChange={setViewport} interactive={false} />}
                after={
                  <ComparisonCanvas
                    width={width}
                    height={height}
                    draw={drawAfter}
                    viewport={viewport}
                    onViewportChange={setViewport}
                    interactive={false}
                    checkerboardBackdrop={viewMode === "ai-result" && backdrop === "checkerboard"}
                  />
                }
              />
            )}
          </div>

          {matte.result.warnings.length > 0 && (
            <p className="text-caption text-(--color-text-muted)">Pipeline warnings: {matte.result.warnings.join("; ")}</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIDEO MODE
// ---------------------------------------------------------------------------

function VideoComparisonView({ sourceUrl }: { sourceUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [samples, setSamples] = useState<ViewerSample[]>([]);
  const [isSampling, setIsSampling] = useState(false);
  const [sampleProgress, setSampleProgress] = useState(0);
  const [exactFrame, setExactFrame] = useState<{ time: number; result: MattingResult; sourceRgba: Uint8ClampedArray } | null>(null);
  const [isComputingExact, setIsComputingExact] = useState(false);
  const [fps, setFps] = useState(ASSUMED_FPS_DEFAULT);

  const [viewMode, setViewMode] = useState<ImageViewMode>("ai-result");
  const [backdrop, setBackdrop] = useState<Backdrop>("checkerboard");
  const [customColor, setCustomColor] = useState("#22c55e");
  const [layout, setLayout] = useState<LayoutMode>("side-by-side");
  const [viewport, setViewport] = useState<ViewportState>(DEFAULT_VIEWPORT_STATE);

  const currentTime = useVideoClock(videoRef);

  const handleLoadedMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    setWidth(el.videoWidth);
    setHeight(el.videoHeight);
    setDuration(el.duration || 0);
    setTrimStart(0);
    setTrimEnd(el.duration || 0);
  };

  const runSampling = async () => {
    const video = videoRef.current;
    if (!video) return;
    setIsSampling(true);
    setSampleProgress(0);
    setExactFrame(null);
    try {
      const result = await sampleVideoMatte(video, {
        start: trimStart,
        end: trimEnd,
        onProgress: (p) => setSampleProgress(p.fraction),
      });
      setSamples(result);
    } finally {
      setIsSampling(false);
    }
  };

  const currentSample = useMemo(() => nearestSampleAtOrBefore(samples, currentTime), [samples, currentTime]);
  // The on-demand exact-frame result only takes precedence while playback
  // is still sitting at (or very near) the exact timestamp it was computed
  // for — scrubbing away from it falls straight back to sample-and-hold,
  // rather than incorrectly pinning every later frame to that one old result.
  const useExactFrame = exactFrame !== null && Math.abs(exactFrame.time - currentTime) < 1 / fps;

  const activeAlpha = useExactFrame ? exactFrame.result.alpha : currentSample?.alpha ?? null;
  const activeForeground = useExactFrame ? exactFrame.result.foreground : currentSample?.foreground ?? null;
  const activeSourceRgba = useExactFrame ? exactFrame.sourceRgba : currentSample?.sourceRgba ?? null;
  // `sampleVideoMatte` reuses `sampleTrimmedFrames`, which downscales frames
  // above MAX_CUTOUT_WIDTH (640px) — a batch-sampled frame's real pixel
  // dimensions can be smaller than the video's native width/height, so every
  // draw call below must size against the ACTIVE sample's own dimensions,
  // not the outer `width`/`height` state (which is the native resolution
  // "Compute this exact frame" draws at). Using the wrong one throws
  // (`ImageData` requires `data.length === 4 * width * height` exactly).
  const activeWidth = useExactFrame ? width : currentSample?.width ?? width;
  const activeHeight = useExactFrame ? height : currentSample?.height ?? height;

  const drawOriginal = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!activeSourceRgba || activeWidth === 0 || activeHeight === 0) return;
      ctx.putImageData(toImageData(activeSourceRgba, activeWidth, activeHeight), 0, 0);
    },
    [activeSourceRgba, activeWidth, activeHeight],
  );

  const drawAfter = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      if (!activeAlpha || !activeForeground || !activeSourceRgba || activeWidth === 0 || activeHeight === 0) return;
      if (viewMode === "original") return drawOriginal(ctx);
      if (viewMode === "ai-result") return drawAiResult(ctx, activeForeground, activeWidth, activeHeight, backdrop, customColor);
      const buf = computeViewBuffer(viewMode, activeSourceRgba, activeAlpha, activeWidth, activeHeight);
      ctx.putImageData(toImageData(buf, activeWidth, activeHeight), 0, 0);
    },
    [activeAlpha, activeForeground, activeSourceRgba, viewMode, activeWidth, activeHeight, backdrop, customColor, drawOriginal],
  );

  const stepFrame = async (direction: 1 | -1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const next = Math.min(trimEnd, Math.max(trimStart, video.currentTime + direction / fps));
    video.currentTime = next;
    await waitForSeek(video);
  };

  const computeExactFrame = async () => {
    const video = videoRef.current;
    if (!video || width === 0 || height === 0) return;
    setIsComputingExact(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const sourceRgba = ctx.getImageData(0, 0, width, height).data;
      const result = await removeBackgroundFromImage(canvas, width, height);
      setExactFrame({ time: video.currentTime, result, sourceRgba });
    } finally {
      setIsComputingExact(false);
    }
  };

  const handleFit = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || width === 0 || height === 0) return;
    // Side-by-side shows each pane at half the stage's width (a
    // `grid-cols-2` split) — fitting against the full stage width would
    // leave each pane's content only half-visible.
    const paneWidth = layout === "side-by-side" ? rect.width / 2 : rect.width;
    const zoom = Math.min(paneWidth / width, rect.height / height) * 0.95;
    setViewport({ zoom, panX: (paneWidth - width * zoom) / 2, panY: (rect.height - height * zoom) / 2 });
  };
  const handleHundred = () => setViewport((v) => ({ ...v, zoom: 1 }));

  // See the matching effect in ImageComparisonView — side-by-side and
  // slider mode fit against different pane widths, so a viewport computed
  // for one can park the image outside slider mode's clipped "after" pane
  // (looks blank). Re-fit whenever layout changes.
  useEffect(() => {
    handleFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return (
    <div className="flex flex-col gap-4">
      <video
        ref={videoRef}
        src={sourceUrl}
        onLoadedMetadata={handleLoadedMetadata}
        onError={() => setError("Your browser couldn't read this video. Try converting it to MP4 (H.264) first.")}
        controls
        className="mx-auto max-h-64 rounded-lg"
      />
      {error && <p className="text-body-sm text-danger-600">{error}</p>}

      {duration > 0 && (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
          <label className="flex items-center gap-2 text-caption">
            Trim start
            <input type="number" min={0} max={trimEnd} step={0.1} value={trimStart.toFixed(1)} onChange={(e) => setTrimStart(Number(e.target.value))} className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1" />
          </label>
          <label className="flex items-center gap-2 text-caption">
            Trim end
            <input type="number" min={trimStart} max={duration} step={0.1} value={trimEnd.toFixed(1)} onChange={(e) => setTrimEnd(Number(e.target.value))} className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1" />
          </label>
          <label className="flex items-center gap-2 text-caption">
            Assumed fps
            <input type="number" min={1} max={120} value={fps} onChange={(e) => setFps(Math.max(1, Number(e.target.value)))} className="w-16 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1" />
          </label>
          <button
            type="button"
            onClick={runSampling}
            disabled={isSampling}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-caption font-semibold text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSampling ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {isSampling ? `Sampling… ${(sampleProgress * 100).toFixed(0)}%` : samples.length > 0 ? "Re-run AI matte" : "Run AI matte"}
          </button>
          {samples.length > 0 && <span className="text-caption text-(--color-text-muted)">{samples.length} sampled frame(s)</span>}
        </div>
      )}

      {samples.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <ViewModeControl mode={viewMode} onChange={setViewMode} />
            <div className="flex items-center gap-3">
              {viewMode === "ai-result" && <BackdropControl backdrop={backdrop} onChange={setBackdrop} customColor={customColor} onCustomColor={setCustomColor} />}
              <LayoutToggle layout={layout} onChange={setLayout} />
              <ViewportControls viewport={viewport} onFit={handleFit} onHundred={handleHundred} />
            </div>
          </div>

          <div ref={stageRef} style={{ height: 420 }} className="overflow-hidden rounded-xl border border-(--color-border)">
            {layout === "side-by-side" ? (
              <div className="grid h-full grid-cols-2 divide-x divide-(--color-border)">
                <ComparisonCanvas width={activeWidth} height={activeHeight} draw={drawOriginal} viewport={viewport} onViewportChange={setViewport} label="Original (this frame)" />
                <ComparisonCanvas
                  width={activeWidth}
                  height={activeHeight}
                  draw={drawAfter}
                  viewport={viewport}
                  onViewportChange={setViewport}
                  checkerboardBackdrop={viewMode === "ai-result" && backdrop === "checkerboard"}
                  label={`${IMAGE_VIEW_MODES.find((m) => m.id === viewMode)?.label} (sample-and-hold)`}
                />
              </div>
            ) : (
              <BeforeAfterSlider
                viewport={viewport}
                onViewportChange={setViewport}
                beforeLabel="Original"
                afterLabel={IMAGE_VIEW_MODES.find((m) => m.id === viewMode)?.label}
                before={<ComparisonCanvas width={activeWidth} height={activeHeight} draw={drawOriginal} viewport={viewport} onViewportChange={setViewport} interactive={false} />}
                after={
                  <ComparisonCanvas
                    width={activeWidth}
                    height={activeHeight}
                    draw={drawAfter}
                    viewport={viewport}
                    onViewportChange={setViewport}
                    interactive={false}
                    checkerboardBackdrop={viewMode === "ai-result" && backdrop === "checkerboard"}
                  />
                }
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => stepFrame(-1)} className="grid h-7 w-7 place-items-center rounded-md border border-(--color-border) hover:border-(--color-border-strong)" title="Previous frame">
                <ChevronLeft size={15} />
              </button>
              <span className="w-20 text-center text-caption tabular-nums">{currentTime.toFixed(2)}s</span>
              <button type="button" onClick={() => stepFrame(1)} className="grid h-7 w-7 place-items-center rounded-md border border-(--color-border) hover:border-(--color-border-strong)" title="Next frame">
                <ChevronRight size={15} />
              </button>
            </div>
            <button
              type="button"
              onClick={computeExactFrame}
              disabled={isComputingExact}
              className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
              title="Runs the real pipeline once, on-demand, for the exact paused frame — the default view holds the nearest batch-sampled frame instead, same as production's own video AI-cutout"
            >
              {isComputingExact ? <Loader2 size={13} className="animate-spin" /> : null}
              {isComputingExact ? "Computing…" : "Compute this exact frame"}
            </button>
            {exactFrame && <span className="text-caption text-(--color-text-muted)">Exact frame computed at {exactFrame.time.toFixed(2)}s</span>}
            <div className="flex-1">
              <Scrubber min={trimStart} max={trimEnd} value={Math.min(trimEnd, Math.max(trimStart, currentTime))} onChange={(t) => {
                const video = videoRef.current;
                if (video) video.currentTime = t;
              }} sampleTimes={samples.map((s) => s.time)} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TOP-LEVEL PANEL
// ---------------------------------------------------------------------------

export default function MatteComparisonViewerPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"image" | "video" | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleFiles = (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    const validation = validateUploadedMediaFile(picked);
    if (!validation.ok) {
      setValidationError(validation.message ?? "That file couldn't be used.");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setValidationError(null);
    setFile(picked);
    setKind(validation.kind ?? null);
    setSourceUrl(URL.createObjectURL(picked));
  };

  const reset = () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setKind(null);
    setSourceUrl(null);
  };

  if (!file || !sourceUrl || !kind) {
    return (
      <ToolUploadScreen
        icon={SplitSquareHorizontal}
        title="Matte Comparison Viewer"
        description="Upload a real image or video and inspect the AI background-removal pipeline's real output against the original — alpha matte, composites, and an edge diagnostic, with zoom/pan and a before/after slider."
      >
        <Dropzone accept="image/*,video/*" label="Drop an image or video here, or click to browse" hint="Runs the same on-device pipeline the Remove Background tool uses" onFiles={handleFiles} />
        {validationError && (
          <p role="alert" className="mt-3 text-body-sm text-danger-600">
            {validationError}
          </p>
        )}
      </ToolUploadScreen>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-body-sm text-(--color-text-muted)">{file.name}</p>
        <button type="button" onClick={reset} className="text-caption font-medium text-(--color-text-muted) hover:text-(--color-text)">
          Choose a different file
        </button>
      </div>
      {kind === "image" ? <ImageComparisonView sourceUrl={sourceUrl} /> : <VideoComparisonView sourceUrl={sourceUrl} />}
    </div>
  );
}
