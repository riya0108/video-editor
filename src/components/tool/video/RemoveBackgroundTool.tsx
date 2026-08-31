import { useEffect, useRef, useState } from "react";
import {
  Blend,
  Image as ImageIcon,
  Layers,
  Pipette,
  Scissors,
  Sparkles,
  Video as VideoIcon,
  Wand2,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import PickColorOverlay from "./editor/PickColorOverlay";
import { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import { useBgRemovalPreview, type BgRemovalReplaceState } from "../../../lib/hooks/useBgRemovalPreview";
import { useBgRemovalExport } from "../../../lib/hooks/useBgRemovalExport";
import {
  keyChromaForeground,
  drawBgReplacement,
  drawBlurredBackdrop,
  sampleColorAt,
  type BgReplaceMode,
  type BgReplaceSettings,
  type ChromaSettings,
} from "../../../lib/media/bg-removal-canvas";
import type { BgReplaceExportSettings } from "../../../lib/ffmpeg/bg-removal-command";
import { stripExtension } from "../../../lib/ffmpeg/format";

const PRESET_COLORS = ["#00ff00", "#00b140", "#0047ff", "#ffffff", "#000000"];
const GRADIENT_PRESETS: [string, string][] = [
  ["#6366f1", "#22d3ee"],
  ["#f97316", "#ec4899"],
  ["#0ea5e9", "#22c55e"],
  ["#111827", "#4b5563"],
];

type Mode = "chroma" | "ai";

function blurPxFor(width: number, height: number): number {
  return Math.max(4, Math.round(Math.max(width, height) * 0.035));
}

export default function RemoveBackgroundTool() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [duration, setDuration] = useState(0);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const [mode, setMode] = useState<Mode>("chroma");
  const [chroma, setChroma] = useState<ChromaSettings>({ colorHex: "#00ff00", similarity: 0.2, blend: 0.12 });
  const [picking, setPicking] = useState(false);

  const [replace, setReplace] = useState<BgRemovalReplaceState>({
    mode: "transparent",
    color: "#f5f5f5",
    gradientFrom: GRADIENT_PRESETS[0][0],
    gradientTo: GRADIENT_PRESETS[0][1],
    gradientDirection: "vertical",
    imageFile: null,
    videoFile: null,
  });
  const [replaceImageEl, setReplaceImageEl] = useState<HTMLImageElement | null>(null);

  const toReplaceSettings = (imageEl: HTMLImageElement | null): BgReplaceSettings => ({
    mode: replace.mode,
    color: replace.color,
    gradientFrom: replace.gradientFrom,
    gradientTo: replace.gradientTo,
    gradientDirection: replace.gradientDirection,
    imageEl,
    videoEl: null,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const imagePreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const chromaWorkRef = useRef<HTMLCanvasElement | null>(null);
  if (!chromaWorkRef.current && typeof document !== "undefined") chromaWorkRef.current = document.createElement("canvas");

  const cutout = usePersonCutout();
  const exportState = useBgRemovalExport();
  const videoPreview = useBgRemovalPreview({ mode, chroma, replace, cutoutFrames: cutout.frames });

  // Load the replacement background image (image-kind path only — the video
  // preview hook manages its own copy for canvas-mode video previews).
  useEffect(() => {
    const f = replace.imageFile;
    if (!f) {
      setReplaceImageEl(null);
      return;
    }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => setReplaceImageEl(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [replace.imageFile]);

  // Live chroma-key preview for a still image — cheap enough to redraw on
  // every settings change. AI mode has no live image preview (segmentation
  // is a real model pass); its result only appears once export finishes,
  // same as this app's other AI tools (e.g. Upscale).
  useEffect(() => {
    if (kind !== "image" || width === 0 || height === 0) return;
    const img = imgRef.current;
    const canvas = imagePreviewCanvasRef.current;
    if (!img || !canvas) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    if (mode !== "chroma") {
      ctx.drawImage(img, 0, 0, width, height);
      return;
    }
    const foreground = keyChromaForeground(img, width, height, chroma, chromaWorkRef.current!);
    const stage = { width, height };
    if (replace.mode === "blur") {
      drawBlurredBackdrop(ctx, img, width, height, stage, blurPxFor(width, height));
    } else {
      drawBgReplacement(ctx, stage, toReplaceSettings(replaceImageEl));
    }
    ctx.drawImage(foreground, 0, 0, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, mode, chroma, replace, replaceImageEl, width, height, sourceUrl]);

  const resetFileState = () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl(null);
    setWidth(0);
    setHeight(0);
    setDuration(0);
    setTrimStart(0);
    setTrimEnd(0);
    setMetadataError(null);
    cutout.clear();
  };

  const handleFiles = (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    resetFileState();
    exportState.reset();
    const isVideo = picked.type.startsWith("video/");
    setFile(picked);
    setKind(isVideo ? "video" : "image");
    setSourceUrl(URL.createObjectURL(picked));
    // Video export can't produce real transparency (no alpha-capable encoder
    // in this app's ffmpeg build) — default it to a background that always
    // works instead of a mode the export step would have to silently swap.
    setReplace((r) => ({ ...r, mode: isVideo ? "blur" : "transparent" }));
  };

  const handleImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setWidth(img.naturalWidth);
    setHeight(img.naturalHeight);
  };

  const handleVideoMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    setWidth(el.videoWidth);
    setHeight(el.videoHeight);
    setDuration(el.duration || 0);
    setTrimStart(0);
    setTrimEnd(el.duration || 0);
  };

  const handleVideoError = () => {
    setMetadataError("Your browser couldn't read this video. Try converting it to MP4 (H.264) first.");
  };

  const handlePickColor = (fx: number, fy: number) => {
    const source = kind === "video" ? videoRef.current : imgRef.current;
    if (!source) return;
    const w = kind === "video" ? (source as HTMLVideoElement).videoWidth : (source as HTMLImageElement).naturalWidth;
    const h = kind === "video" ? (source as HTMLVideoElement).videoHeight : (source as HTMLImageElement).naturalHeight;
    setChroma((c) => ({ ...c, colorHex: sampleColorAt(source, w, h, fx, fy) }));
    setPicking(false);
  };

  const availableReplaceModes: BgReplaceMode[] =
    kind === "image" ? ["transparent", "color", "gradient", "blur", "image"] : ["color", "gradient", "blur", "image", "video"];

  const trimmedDuration = Math.max(0, trimEnd - trimStart);
  const canDetectSubject = kind === "video" && width > 0 && trimmedDuration > 0;
  const aiVideoReady = mode === "ai" && kind === "video" && cutout.frames.length > 0;
  const canExport =
    !!file &&
    width > 0 &&
    height > 0 &&
    !exportState.isProcessing &&
    (kind === "image" || trimmedDuration > 0) &&
    (mode === "chroma" || kind === "image" || aiVideoReady);

  const handleDetectSubject = () => {
    const el = videoRef.current;
    if (!el) return;
    cutout.generate(el, trimStart, trimEnd);
  };

  const handleExport = async () => {
    if (!file) return;
    const filenameBase = `no-bg-${stripExtension(file.name)}`;

    if (kind === "image") {
      await exportState.runImage(
        file,
        {
          mode,
          chroma: mode === "chroma" ? chroma : undefined,
          replace: toReplaceSettings(replaceImageEl),
        },
        `${filenameBase}.png`,
      );
      return;
    }

    const replaceExport: BgReplaceExportSettings = {
      mode: replace.mode === "transparent" ? "blur" : replace.mode,
      color: replace.color,
      gradientFrom: replace.gradientFrom,
      gradientTo: replace.gradientTo,
      gradientDirection: replace.gradientDirection,
      imageFile: replace.imageFile,
      videoFile: replace.videoFile,
    };

    if (mode === "chroma") {
      await exportState.runVideoChroma(
        { file, width, height, trimStart, trimEnd, replace: replaceExport, chroma },
        `${filenameBase}.mp4`,
      );
    } else {
      if (cutout.frames.length === 0) return;
      await exportState.runVideoAi(
        { file, width, height, trimStart, trimEnd, replace: replaceExport, cutoutFrames: cutout.frames },
        `${filenameBase}.mp4`,
      );
    }
  };

  const reset = () => {
    exportState.reset();
    resetFileState();
  };

  if (!file) {
    return (
      <ToolUploadScreen
        icon={Layers}
        title="Remove Background from Video or Image"
        description="Green-screen chroma key for precise, per-pixel keying — or AI subject detection when you don't have a green screen at all. Everything runs on your device."
      >
        <Dropzone
          accept="image/*,video/*"
          label="Drop an image or video here, or click to browse"
          hint="Works with green-screen footage, or any clip/photo via AI subject detection"
          onFiles={handleFiles}
        />
      </ToolUploadScreen>
    );
  }

  if (exportState.result) {
    return (
      <ResultPanel
        url={exportState.result.url}
        blob={exportState.result.blob}
        filename={exportState.result.filename}
        kind={kind}
        onReset={reset}
      />
    );
  }

  return (
    <ToolSplitLayout
      controls={
        <>
          <ToolPanelSection icon={Wand2} label="How should we find the subject?">
            <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
              <button
                type="button"
                onClick={() => setMode("chroma")}
                className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${mode === "chroma" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
              >
                I have a green screen
              </button>
              <button
                type="button"
                onClick={() => setMode("ai")}
                className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${mode === "ai" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
              >
                No green screen (AI)
              </button>
            </div>

            {mode === "chroma" ? (
              <div className="mt-4 space-y-4">
                <p className="text-caption text-(--color-text-muted)">
                  Keys out a solid backdrop color with per-pixel precision — the sharpest edges, best for real green/blue screen footage.
                </p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-caption text-(--color-text-muted)">Screen color</span>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Use ${c}`}
                      onClick={() => setChroma((s) => ({ ...s, colorHex: c }))}
                      className={`h-6 w-6 rounded-full border-2 ${chroma.colorHex === c ? "border-primary-500" : "border-(--color-border)"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={chroma.colorHex}
                    onChange={(e) => setChroma((s) => ({ ...s, colorHex: e.target.value }))}
                    className="h-6 w-6 cursor-pointer rounded border border-(--color-border) bg-transparent"
                    aria-label="Custom screen color"
                  />
                  <button
                    type="button"
                    onClick={() => setPicking((p) => !p)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${picking ? "border-primary-500 bg-primary-500 text-white" : "border-(--color-border) hover:border-(--color-border-strong)"}`}
                  >
                    <Pipette size={13} />
                    {picking ? "Click the preview…" : "Pick from preview"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                    Similarity
                    <input
                      type="range"
                      min={0.05}
                      max={0.6}
                      step={0.01}
                      value={chroma.similarity}
                      onChange={(e) => setChroma((s) => ({ ...s, similarity: Number(e.target.value) }))}
                      className="w-28 accent-(--color-primary-500)"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                    Edge softness
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.01}
                      value={chroma.blend}
                      onChange={(e) => setChroma((s) => ({ ...s, blend: Number(e.target.value) }))}
                      className="w-28 accent-(--color-primary-500)"
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-caption text-(--color-text-muted)">
                  Runs an on-device AI segmentation model to find the subject — no green screen needed. A one-time ~44MB model
                  download, cached after first use.
                </p>
                {kind === "video" ? (
                  <>
                    <button
                      type="button"
                      disabled={!canDetectSubject || cutout.isGenerating}
                      onClick={handleDetectSubject}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Sparkles size={15} />
                      {cutout.isGenerating ? "Detecting…" : cutout.frames.length > 0 ? "Re-detect subject" : "Detect subject"}
                    </button>
                    {cutout.isGenerating && cutout.progress && (
                      <p className="text-caption text-(--color-text-muted)">
                        {cutout.progress.phase === "downloading"
                          ? `Downloading model… ${Math.round(cutout.progress.fraction * 100)}%`
                          : `Analyzing frames… ${Math.round(cutout.progress.fraction * 100)}%`}
                      </p>
                    )}
                    {cutout.error && <p className="text-body-sm text-danger-600">{cutout.error}</p>}
                    {cutout.frames.length > 0 && !cutout.isGenerating && (
                      <p className="text-caption text-success-600">Subject detected — preview updated below.</p>
                    )}
                    <p className="text-caption text-(--color-text-muted)">
                      Video is sampled at a reduced frame rate for detection, so it works best on mostly-static or talking-head
                      clips. For fast motion, green-screen mode still gives the cleanest per-frame edges.
                    </p>
                  </>
                ) : (
                  <p className="text-caption text-(--color-text-muted)">
                    Click "Remove background" below — the AI result appears there once it finishes (this is a real model pass, so
                    there's no live preview first).
                  </p>
                )}
              </div>
            )}
          </ToolPanelSection>

          <ToolPanelSection icon={Layers} label="Replace background with">
            <div className="grid grid-cols-3 gap-2">
              {availableReplaceModes.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setReplace((r) => ({ ...r, mode: m }))}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-caption font-medium capitalize transition-colors ${replace.mode === m ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300" : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"}`}
                >
                  {m === "transparent" && <span className="h-4 w-4 rounded-full bg-checkerboard" />}
                  {m === "color" && <span className="h-4 w-4 rounded-full" style={{ backgroundColor: replace.color }} />}
                  {m === "gradient" && (
                    <span
                      className="h-4 w-4 rounded-full"
                      style={{ background: `linear-gradient(135deg, ${replace.gradientFrom}, ${replace.gradientTo})` }}
                    />
                  )}
                  {m === "blur" && <Blend size={15} />}
                  {m === "image" && <ImageIcon size={15} />}
                  {m === "video" && <VideoIcon size={15} />}
                  {m}
                </button>
              ))}
            </div>

            <div className="mt-3">
              {replace.mode === "color" && (
                <input
                  type="color"
                  value={replace.color}
                  onChange={(e) => setReplace((r) => ({ ...r, color: e.target.value }))}
                  className="h-8 w-16 cursor-pointer rounded border border-(--color-border) bg-transparent"
                  aria-label="Background color"
                />
              )}
              {replace.mode === "gradient" && (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap gap-2">
                    {GRADIENT_PRESETS.map(([from, to]) => (
                      <button
                        key={`${from}-${to}`}
                        type="button"
                        onClick={() => setReplace((r) => ({ ...r, gradientFrom: from, gradientTo: to }))}
                        className={`h-7 w-10 rounded-md border-2 ${replace.gradientFrom === from && replace.gradientTo === to ? "border-primary-500" : "border-(--color-border)"}`}
                        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                        aria-label={`Use gradient ${from} to ${to}`}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={replace.gradientFrom}
                      onChange={(e) => setReplace((r) => ({ ...r, gradientFrom: e.target.value }))}
                      className="h-7 w-12 cursor-pointer rounded border border-(--color-border) bg-transparent"
                    />
                    <input
                      type="color"
                      value={replace.gradientTo}
                      onChange={(e) => setReplace((r) => ({ ...r, gradientTo: e.target.value }))}
                      className="h-7 w-12 cursor-pointer rounded border border-(--color-border) bg-transparent"
                    />
                    <select
                      value={replace.gradientDirection}
                      onChange={(e) => setReplace((r) => ({ ...r, gradientDirection: e.target.value as typeof r.gradientDirection }))}
                      className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption"
                    >
                      <option value="vertical">Vertical</option>
                      <option value="horizontal">Horizontal</option>
                      <option value="diagonal">Diagonal</option>
                    </select>
                  </div>
                </div>
              )}
              {replace.mode === "blur" && (
                <p className="text-caption text-(--color-text-muted)">Blurs the subject's own original background — like a video-call blur effect.</p>
              )}
              {replace.mode === "image" && (
                <label className="inline-flex cursor-pointer items-center rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  {replace.imageFile ? replace.imageFile.name : "Choose background image"}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => setReplace((r) => ({ ...r, imageFile: e.target.files?.[0] ?? null }))}
                  />
                </label>
              )}
              {replace.mode === "video" && (
                <label className="inline-flex cursor-pointer items-center rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  {replace.videoFile ? replace.videoFile.name : "Choose background video"}
                  <input
                    type="file"
                    accept="video/*"
                    className="sr-only"
                    onChange={(e) => setReplace((r) => ({ ...r, videoFile: e.target.files?.[0] ?? null }))}
                  />
                </label>
              )}
              {replace.mode === "transparent" && (
                <p className="text-caption text-(--color-text-muted)">Exports a PNG with real transparency — drop it straight into another design or edit.</p>
              )}
            </div>
          </ToolPanelSection>

          {kind === "video" && duration > 0 && (
            <ToolPanelSection icon={Scissors} label="Trim" defaultOpen={false}>
              <TrimSlider
                duration={duration}
                start={trimStart}
                end={trimEnd}
                currentTime={currentTime}
                onChangeStart={setTrimStart}
                onChangeEnd={setTrimEnd}
                onSeek={(t) => {
                  if (videoRef.current) videoRef.current.currentTime = t;
                }}
              />
            </ToolPanelSection>
          )}

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? metadataError}
            runLabel={exportState.runLabel}
            engineLabel="Downloading AI model…"
            tip="This runs entirely on your device, so it's fine to switch tabs while it finishes."
          />

          <button
            type="button"
            disabled={!canExport}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Layers size={16} />
            {exportState.isProcessing ? "Removing background…" : "Remove background"}
          </button>
          {mode === "ai" && kind === "video" && cutout.frames.length === 0 && (
            <p className="text-center text-caption text-(--color-text-muted)">Detect the subject above before exporting.</p>
          )}
        </>
      }
      preview={
        kind === "image" ? (
          <div className={`overflow-hidden rounded-lg ${replace.mode === "transparent" ? "bg-checkerboard" : "bg-black"}`}>
            <img ref={imgRef} src={sourceUrl ?? undefined} onLoad={handleImageLoad} alt="" className="hidden" />
            <div className="relative">
              <canvas ref={imagePreviewCanvasRef} className="max-h-[32rem] w-full object-contain" />
              {picking && (
                <div className="absolute inset-0">
                  <PickColorOverlay onPick={handlePickColor} />
                </div>
              )}
            </div>
          </div>
        ) : (
          sourceUrl && (
            <FramedVideoStage
              videoRef={videoRef}
              sourceUrl={sourceUrl}
              naturalWidth={width}
              naturalHeight={height}
              onLoadedMetadata={handleVideoMetadata}
              onError={handleVideoError}
              onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
              controls
              canvasMode={videoPreview.canvasMode}
              checkerboard={videoPreview.checkerboard}
              onDrawFrame={videoPreview.onDrawFrame}
              overlayInteractive={picking}
            >
              {() => picking && <PickColorOverlay onPick={handlePickColor} />}
            </FramedVideoStage>
          )
        )
      }
    />
  );
}
