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
import ExportValidationPanel from "../ExportValidationPanel";
import TrimSlider from "../TrimSlider";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import PickColorOverlay from "./editor/PickColorOverlay";
import { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import { useBgRemovalPreview, type BgRemovalReplaceState } from "../../../lib/hooks/useBgRemovalPreview";
import { useBgRemovalExport } from "../../../lib/hooks/useBgRemovalExport";
import { useAiImageMatte } from "../../../lib/hooks/useAiImageMatte";
import { useExportValidation, type ExportValidationExpectation } from "../../../lib/hooks/useExportValidation";
import { validateUploadedMediaFile } from "../../../lib/media/upload-validation";
import RefineMattePanel from "./RefineMattePanel";
import {
  keyChromaForeground,
  drawBgReplacement,
  drawBlurredBackdrop,
  sampleColorAt,
  compositeBgRemoval,
  type BgReplaceMode,
  type BgReplaceSettings,
  type ChromaSettings,
} from "../../../lib/media/bg-removal-canvas";
import { encodeCanvasForExport, IMAGE_FORMAT_EXTENSIONS, IMAGE_FORMAT_LABELS, type ImageExportFormat } from "../../../lib/media/image-export";
import { probeVideoMeta } from "../../../lib/media/export-validation";
import type { BgReplaceExportSettings } from "../../../lib/ffmpeg/bg-removal-command";
import { stripExtension } from "../../../lib/ffmpeg/format";
import { compositeTransparentForeground } from "../../../lib/matting/pipeline";

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
  // PHASE 13 — TRANSPARENT EXPORT. Only meaningful for image exports in
  // "transparent" mode — every other replace mode is fully opaque, so
  // format choice has no visual effect and PNG is used regardless (see
  // bg-removal-image.ts).
  const [imageFormat, setImageFormat] = useState<ImageExportFormat>("png");

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

  const cutout = usePersonCutout("subject");
  const exportState = useBgRemovalExport();
  const videoPreview = useBgRemovalPreview({ mode, chroma, replace, cutoutFrames: cutout.frames });
  // PHASE 12 — BACKGROUND REMOVAL UI. Image AI mode's REFINE step: generates
  // the matte separately from compositing (see useAiImageMatte.ts) so the
  // model never re-runs while the user tries different preview backgrounds
  // or paints touch-ups in RefineMattePanel — only handleApplyRefinedMatte
  // below (the APPLY step) produces the final flattened export.
  const aiMatte = useAiImageMatte();
  // PHASE 13 — TRANSPARENT EXPORT. Automatic post-export verification (file
  // exists/readable, resolution, frame rate, real alpha, no flatten-to-
  // black) — see src/lib/media/export-validation.ts. `expectationRef`
  // snapshots what the export SHOULD look like at the moment it's kicked
  // off (not read fresh when the result lands), since the user could in
  // principle change kind/mode/replace settings while a slow export is
  // still running.
  const exportValidation = useExportValidation();
  const expectationRef = useRef<ExportValidationExpectation | null>(null);
  const lastValidatedResultRef = useRef<Blob | null>(null);

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

  // PHASE 13 — TRANSPARENT EXPORT. Fires the automatic post-export
  // verification pass the instant any export path (chroma image, AI image
  // via the REFINE/APPLY step, chroma video, AI video) lands a result —
  // all four funnel through the same exportState.result, so one effect
  // here covers all of them instead of each call site remembering to do it.
  useEffect(() => {
    const blob = exportState.result?.blob ?? null;
    const expectation = expectationRef.current;
    if (!blob || !expectation || lastValidatedResultRef.current === blob) return;
    lastValidatedResultRef.current = blob;
    (async () => {
      let finalExpectation = expectation;
      // Video's expected fps isn't known at click-time without adding a
      // probe to the critical path — filled in here instead, during the
      // "verifying" phase that already runs after the result lands, so it
      // adds no perceived latency to the export itself.
      if (expectation.kind === "video" && expectation.fps === undefined && file) {
        const sourceProbe = await probeVideoMeta(file).catch(() => null);
        if (sourceProbe?.fps) finalExpectation = { ...expectation, fps: sourceProbe.fps };
      }
      exportValidation.validate(blob, finalExpectation);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportState.result]);

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
    const validation = validateUploadedMediaFile(picked);
    if (!validation.ok) {
      setMetadataError(validation.message ?? "That file couldn't be used.");
      return;
    }
    resetFileState();
    exportState.reset();
    const isVideo = validation.kind === "video";
    setFile(picked);
    setKind(isVideo ? "video" : "image");
    setSourceUrl(URL.createObjectURL(picked));
    // Video defaults to "blur" — "transparent" is still available for video,
    // but (like cutout.pro's own transparent export) it's a ProRes 4444
    // .mov with real alpha that most browsers can't preview inline, so it's
    // an opt-in rather than the default.
    setReplace((r) => ({ ...r, mode: isVideo ? "blur" : "transparent" }));
    exportValidation.reset();
  };

  // PRODUCTION READINESS (H5): the background-replace image/video pickers
  // used to set replace.imageFile/videoFile straight from the raw
  // FileList, bypassing the same type/size gate the main Dropzone already
  // enforces — closing that gap here rather than leaving a second,
  // inconsistent upload entry point in the same tool.
  const handleBackgroundReplaceFile = (picked: File | undefined, expectedKind: "image" | "video") => {
    if (!picked) return;
    const validation = validateUploadedMediaFile(picked);
    if (!validation.ok) {
      setMetadataError(validation.message ?? "That file couldn't be used.");
      return;
    }
    if (validation.kind !== expectedKind) {
      setMetadataError(`That looks like a${validation.kind === "image" ? "n image" : " video"} file — choose a ${expectedKind} instead.`);
      return;
    }
    setMetadataError(null);
    setReplace((r) => (expectedKind === "image" ? { ...r, imageFile: picked } : { ...r, videoFile: picked }));
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

  // PHASE 16 — ADVERSARIAL MATTE TESTING ("corrupt media", #24). Without
  // this, a file that fails to decode as an image (wrong bytes, truncated,
  // a non-image file with an image-like extension) left width/height at 0
  // forever — canExport correctly stayed false (no fake success), but the
  // user got zero explanation for why "Remove background" was stuck
  // disabled. Mirrors handleVideoError's existing pattern for the video path.
  const handleImageError = () => {
    setMetadataError("Your browser couldn't read this image. It may be corrupted, or not actually an image file — try a different file.");
  };

  const handlePickColor = (fx: number, fy: number) => {
    const source = kind === "video" ? videoRef.current : imgRef.current;
    if (!source) return;
    const w = kind === "video" ? (source as HTMLVideoElement).videoWidth : (source as HTMLImageElement).naturalWidth;
    const h = kind === "video" ? (source as HTMLVideoElement).videoHeight : (source as HTMLImageElement).naturalHeight;
    setChroma((c) => ({ ...c, colorHex: sampleColorAt(source, w, h, fx, fy) }));
    setPicking(false);
  };

  // "transparent" export for video is only offered in green-screen mode.
  // The AI-cutout path needs its overlay chain to actually carry alpha
  // (format=auto, see person-cutout-filter.ts), and combined with a
  // lossless qtrle encode that reliably hangs indefinitely in this app's
  // ffmpeg-wasm build on real (non-trivial) clips — confirmed by testing, a
  // genuine environment limitation rather than something more tuning fixes.
  // Green-screen mode's transparent export doesn't touch that chain at all
  // and is fast and reliable.
  const availableReplaceModes: BgReplaceMode[] =
    kind === "image"
      ? ["transparent", "color", "gradient", "blur", "image"]
      : mode === "chroma"
        ? ["transparent", "color", "gradient", "blur", "image", "video"]
        : ["color", "gradient", "blur", "image", "video"];

  const trimmedDuration = Math.max(0, trimEnd - trimStart);
  const canDetectSubject = kind === "video" && width > 0 && trimmedDuration > 0;
  const aiVideoReady = mode === "ai" && kind === "video" && cutout.frames.length > 0;
  const canExport =
    !!file &&
    width > 0 &&
    height > 0 &&
    !exportState.isProcessing &&
    !aiMatte.isProcessing &&
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
    const expectAlpha = replace.mode === "transparent";

    if (kind === "image") {
      if (mode === "ai") {
        // Generates the matte only — see useAiImageMatte.ts. Once it
        // succeeds, aiMatte.result becomes truthy and the render below
        // switches to RefineMattePanel instead of compositing immediately;
        // handleApplyRefinedMatte does the actual export once the user hits
        // Apply there.
        if (imgRef.current) await aiMatte.generate(imgRef.current, width, height);
        return;
      }
      expectationRef.current = { kind: "image", width, height, expectAlpha };
      await exportState.runImage(
        file,
        {
          mode,
          chroma: chroma,
          replace: toReplaceSettings(replaceImageEl),
          format: imageFormat,
        },
        filenameBase,
      );
      return;
    }

    const replaceExport: BgReplaceExportSettings = {
      mode: replace.mode,
      color: replace.color,
      gradientFrom: replace.gradientFrom,
      gradientTo: replace.gradientTo,
      gradientDirection: replace.gradientDirection,
      imageFile: replace.imageFile,
      videoFile: replace.videoFile,
    };
    // "transparent" video exports real alpha as a ProRes 4444 .mov — every
    // other mode composites onto something opaque and stays mp4.
    const videoExt = replace.mode === "transparent" ? "mov" : "mp4";
    // fps is filled in lazily by the validation effect once the export
    // lands, probing the source rather than adding latency here.
    expectationRef.current = { kind: "video", width, height, expectAlpha };

    if (mode === "chroma") {
      await exportState.runVideoChroma(
        { file, width, height, trimStart, trimEnd, replace: replaceExport, chroma },
        `${filenameBase}.${videoExt}`,
      );
    } else {
      if (cutout.frames.length === 0) return;
      await exportState.runVideoAi(
        { file, width, height, trimStart, trimEnd, replace: replaceExport, cutoutFrames: cutout.frames },
        `${filenameBase}.${videoExt}`,
      );
    }
  };

  /**
   * PHASE 12 — APPLY step. Composites the refined alpha (from
   * RefineMattePanel — a Phase 6 ManualRefinementEngine edit over the
   * matte useAiImageMatte.ts already generated) onto whichever background
   * is selected in "Replace background with", reusing the exact same
   * compositeTransparentForeground + compositeBgRemoval canvas calls the
   * ordinary chroma/video export paths use — the model does not run again
   * here; this is pure compositing over an already-finished alpha.
   */
  const handleApplyRefinedMatte = async (finalAlpha: Float32Array, workingRgba: Uint8ClampedArray) => {
    if (!file || width === 0 || height === 0 || !imgRef.current) return;
    const foreground = compositeTransparentForeground(workingRgba, finalAlpha, width, height);
    const outCanvas = document.createElement("canvas");
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) return;
    const stage = { width, height };
    compositeBgRemoval(ctx, imgRef.current, width, height, foreground, stage, stage, toReplaceSettings(replaceImageEl), blurPxFor(width, height));

    const expectAlpha = replace.mode === "transparent";
    const requestedFormat: ImageExportFormat = expectAlpha ? imageFormat : "png";
    const encoded = await encodeCanvasForExport(outCanvas, requestedFormat);
    const cutoutBlob = await new Promise<Blob | null>((resolve) => foreground.toBlob((b) => resolve(b), "image/png"));

    expectationRef.current = { kind: "image", width, height, expectAlpha };
    exportState.finishWithBlob(
      encoded.blob,
      `no-bg-${stripExtension(file.name)}.${IMAGE_FORMAT_EXTENSIONS[encoded.format]}`,
      cutoutBlob ?? undefined,
      {
        confidence: aiMatte.result?.confidence ?? 0,
        warnings: aiMatte.result?.warnings ?? [],
        modelUsed: aiMatte.result?.modelUsed ?? "",
      },
      encoded.fellBack,
    );
    aiMatte.reset();
  };

  const reset = () => {
    exportState.reset();
    aiMatte.reset();
    exportValidation.reset();
    expectationRef.current = null;
    lastValidatedResultRef.current = null;
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
        {metadataError && (
          <p role="alert" className="mt-3 text-body-sm text-red-600 dark:text-red-400">
            {metadataError}
          </p>
        )}
      </ToolUploadScreen>
    );
  }

  // Rendered as one persistent element (never unmounted while result/refine/
  // main views swap) — otherwise RefineMattePanel would receive a stale or
  // not-yet-(re)loaded imgRef.current the moment the AI matte finishes and
  // this component switches away from the main layout's own preview, which
  // is where this element used to live.
  const sourceImgElement = kind === "image" && sourceUrl && (
    <img ref={imgRef} src={sourceUrl} onLoad={handleImageLoad} onError={handleImageError} alt="" className="hidden" />
  );

  if (exportState.result) {
    return (
      <>
        {sourceImgElement}
        {exportState.matting && (exportState.matting.warnings.length > 0 || exportState.matting.confidence < 0.5) && (
          <div className="mb-3 rounded-lg border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-body-sm">
            <p className="font-medium text-warning-600">
              AI matte confidence: {(exportState.matting.confidence * 100).toFixed(0)}% (via {exportState.matting.modelUsed})
            </p>
            {exportState.matting.warnings.map((w, i) => (
              <p key={i} className="mt-1 text-caption text-(--color-text-muted)">
                {w}
              </p>
            ))}
          </div>
        )}
        {exportState.formatFellBack && (
          <div className="mb-3 rounded-lg border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-body-sm text-warning-600">
            This browser couldn't encode {IMAGE_FORMAT_LABELS[imageFormat]} with transparency, so PNG was used instead.
          </div>
        )}
        <ExportValidationPanel report={exportValidation.report} isValidating={exportValidation.isValidating} />
        <ResultPanel
          url={exportState.result.url}
          blob={exportState.result.blob}
          filename={exportState.result.filename}
          kind={kind}
          previewNote={
            kind === "video" && replace.mode === "transparent"
              ? "This is a .mov with a real alpha channel — most browsers can't preview transparent video inline, so this player won't show it. Open it in Premiere Pro, DaVinci Resolve, Final Cut Pro, or iMovie to see the transparency. Need something that plays everywhere instead? Use a solid color background and key it out in your editor."
              : undefined
          }
          onReset={reset}
        />
      </>
    );
  }

  if (mode === "ai" && kind === "image" && aiMatte.result && imgRef.current) {
    return (
      <>
        {sourceImgElement}
        <RefineMattePanel
          sourceImg={imgRef.current}
          matting={aiMatte.result}
          onCancel={() => aiMatte.reset()}
          onApply={handleApplyRefinedMatte}
        />
      </>
    );
  }

  return (
    <>
      {sourceImgElement}
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
                onClick={() => {
                  setMode("ai");
                  // "transparent" video export isn't offered in AI mode (see
                  // availableReplaceModes) — fall back so a stale selection
                  // from green-screen mode can't sneak through to export.
                  if (kind === "video" && replace.mode === "transparent") setReplace((r) => ({ ...r, mode: "blur" }));
                }}
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
                  Runs an on-device AI matting pipeline to find the subject — no green screen needed. A one-time model
                  download (a few MB), cached after first use.
                </p>
                {kind === "video" ? (
                  <>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!canDetectSubject || cutout.isGenerating}
                        onClick={handleDetectSubject}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles size={15} />
                        {cutout.isGenerating ? "Detecting…" : cutout.frames.length > 0 ? "Re-detect subject" : "Detect subject"}
                      </button>
                      {cutout.isGenerating && (
                        <button
                          type="button"
                          onClick={cutout.cancel}
                          className="rounded-md border border-(--color-border) px-3 py-2 text-body-sm font-semibold text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
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
                    <p className="text-caption text-(--color-text-muted)">
                      Transparent (real alpha) export isn't available in AI mode — switch to "I have a green screen" for that.
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
                    onChange={(e) => handleBackgroundReplaceFile(e.target.files?.[0], "image")}
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
                    onChange={(e) => handleBackgroundReplaceFile(e.target.files?.[0], "video")}
                  />
                </label>
              )}
              {replace.mode === "transparent" && kind === "image" && (
                <div className="space-y-2">
                  <p className="text-caption text-(--color-text-muted)">Exports with real transparency — drop it straight into another design or edit.</p>
                  <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                    {(["png", "webp", "tiff"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setImageFormat(f)}
                        className={`flex-1 rounded px-2 py-1 text-caption font-medium transition-colors ${imageFormat === f ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        {IMAGE_FORMAT_LABELS[f]}
                      </button>
                    ))}
                  </div>
                  {imageFormat === "webp" && (
                    <p className="text-caption text-(--color-text-muted)">
                      Falls back to PNG automatically if this browser can't encode transparent WebP.
                    </p>
                  )}
                  {imageFormat === "tiff" && (
                    <p className="text-caption text-(--color-text-muted)">Uncompressed, so files are large — best for print or further editing, not web use.</p>
                  )}
                </div>
              )}
              {replace.mode === "transparent" && kind === "video" && (
                <p className="text-caption text-(--color-text-muted)">
                  Exports a .mov with a real alpha channel — drop it into Premiere Pro, DaVinci Resolve, Final Cut Pro, or iMovie. Most browsers and simpler players can't preview transparent video, so use "Blur" or a color/image backdrop if you need something that plays everywhere.
                </p>
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

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canExport}
              onClick={handleExport}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Layers size={16} />
              {exportState.isProcessing || aiMatte.isProcessing
                ? mode === "ai" && kind === "image"
                  ? aiMatte.progress > 0 && aiMatte.progress < 1
                    ? `Downloading model… ${Math.round(aiMatte.progress * 100)}%`
                    : "Analyzing image…"
                  : "Removing background…"
                : "Remove background"}
            </button>
            {/* PHASE 14 — PERFORMANCE (cancellation). Only the video export
                path (ffmpeg-backed) has a real cancel mechanism — see
                useBgRemovalExport.ts's `cancel`. Image export (matting
                inference) has no cancellable API, so no button is shown for it. */}
            {kind === "video" && exportState.isProcessing && (
              <button
                type="button"
                onClick={exportState.cancel}
                className="rounded-md border border-(--color-border) px-4 py-2.5 text-body-sm font-semibold text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
              >
                Cancel
              </button>
            )}
          </div>
          {mode === "ai" && kind === "image" && aiMatte.error && (
            <p className="text-center text-caption text-danger-600">{aiMatte.error}</p>
          )}
          {mode === "ai" && kind === "video" && cutout.frames.length === 0 && (
            <p className="text-center text-caption text-(--color-text-muted)">Detect the subject above before exporting.</p>
          )}
        </>
      }
      preview={
        kind === "image" ? (
          <div className={`overflow-hidden rounded-lg ${replace.mode === "transparent" ? "bg-checkerboard" : "bg-black"}`}>
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
    </>
  );
}
