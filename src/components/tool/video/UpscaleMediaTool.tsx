import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useUpscaleExport } from "../../../lib/hooks/useUpscaleExport";
import { stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";
import type { VideoUpscaleQuality } from "../../../lib/upscale/upscale-media";

// Rough frame-count floor past which the fully client-side, frame-by-frame AI
// pipeline (every frame held in browser memory as it's extracted/upscaled/
// re-encoded — see upscaleVideoFile) risks running the tab out of memory or
// taking an impractically long time.
const LONG_VIDEO_FRAME_WARNING = 300;

// Mirrors upscale-media.ts's FAST_MODE_MAX_FPS — used here only to estimate
// frame count for the long-video warning, not to drive the actual pipeline.
const FAST_MODE_MAX_FPS = 15;
const ASSUMED_SOURCE_FPS = 30;

type Mode = "factor" | "resolution";
const FACTORS = [1.5, 2, 3, 4];
const RESOLUTIONS: { id: string; label: string; height: number }[] = [
  { id: "720p", label: "720p (HD)", height: 720 },
  { id: "1080p", label: "1080p (Full HD)", height: 1080 },
  { id: "4k", label: "4K (Ultra HD)", height: 2160 },
];

export default function UpscaleMediaTool() {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("factor");
  const [factor, setFactor] = useState(2);
  const [resolutionId, setResolutionId] = useState("1080p");
  const [videoQuality, setVideoQuality] = useState<VideoUpscaleQuality>("fast");

  const exportState = useUpscaleExport();
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleFiles = (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(picked);
    setKind(picked.type.startsWith("video/") ? "video" : "image");
    setSourceUrl(URL.createObjectURL(picked));
    setWidth(0);
    setHeight(0);
    setDurationSec(0);
    setMetadataError(null);
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setWidth(e.currentTarget.naturalWidth);
    setHeight(e.currentTarget.naturalHeight);
  };

  const handleVideoMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    setWidth(el.videoWidth);
    setHeight(el.videoHeight);
    setDurationSec(el.duration || 0);
  };

  const handleVideoError = () => {
    setMetadataError(
      "Your browser couldn't read this video. Try converting it to MP4 (H.264) first.",
    );
  };

  const targetSize = (): { w: number; h: number } | null => {
    if (width <= 0 || height <= 0) return null;
    if (mode === "factor") {
      return { w: evenRound(width * factor), h: evenRound(height * factor) };
    }
    const resolution = RESOLUTIONS.find((r) => r.id === resolutionId)!;
    if (height >= resolution.height) return null;
    const scale = resolution.height / height;
    return { w: evenRound(width * scale), h: evenRound(resolution.height) };
  };

  const size = targetSize();
  const effectiveFps = kind === "video" && videoQuality === "fast" ? Math.min(ASSUMED_SOURCE_FPS, FAST_MODE_MAX_FPS) : ASSUMED_SOURCE_FPS;
  const estimatedFrames = kind === "video" ? Math.round(durationSec * effectiveFps) : 0;
  const isLongVideo = estimatedFrames > LONG_VIDEO_FRAME_WARNING;

  const handleExport = async () => {
    if (!file || !size) return;
    if (kind === "image") {
      await exportState.runImage(file, size.w, size.h, `upscaled-${stripExtension(file.name)}.png`);
      return;
    }
    await exportState.runVideo(file, size.w, size.h, videoQuality, `upscaled-${stripExtension(file.name)}.mp4`);
  };

  const reset = () => {
    exportState.reset();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl(null);
    setWidth(0);
    setHeight(0);
    setMetadataError(null);
  };

  if (!file) {
    return (
      <ToolUploadScreen
        icon={Sparkles}
        title="Upscale Video or Image"
        description="Increase resolution with real AI super-resolution — sharper detail, not just a bigger file."
      >
        <Dropzone
          accept="image/*,video/*"
          label="Drop an image or video here, or click to browse"
          hint="Upscale its resolution with an on-device AI super-resolution model"
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
          <ToolPanelSection icon={Sparkles} label="Upscale target">
            <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
              <button
                type="button"
                onClick={() => setMode("factor")}
                className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${mode === "factor" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
              >
                By scale factor
              </button>
              <button
                type="button"
                onClick={() => setMode("resolution")}
                className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${mode === "resolution" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
              >
                By target resolution
              </button>
            </div>

            <div className="mt-4">
              {mode === "factor" ? (
                <div className="grid grid-cols-4 gap-2">
                  {FACTORS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFactor(f)}
                      className={`rounded-lg border px-3 py-2.5 text-body-sm font-semibold transition-colors ${factor === f ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300" : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"}`}
                    >
                      {f}x
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setResolutionId(r.id)}
                      className={`rounded-lg border px-3 py-2.5 text-body-sm font-semibold transition-colors ${resolutionId === r.id ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300" : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-3 text-caption text-(--color-text-muted)">
              {width > 0 && height > 0 ? (
                size ? (
                  <>
                    {width}×{height} &rarr;{" "}
                    <span className="font-semibold text-(--color-text)">
                      {size.w}×{size.h}
                    </span>
                  </>
                ) : (
                  "Your file already meets or exceeds this target — nothing to upscale."
                )
              ) : (
                "Reading file…"
              )}
            </div>
            <p className="mt-3 text-caption text-(--color-text-muted)">
              This runs a real super-resolution model on-device (a one-time
              ~5MB model download, cached after first use) — it reconstructs
              plausible detail rather than just resizing and sharpening, so
              results are genuinely clearer, not just bigger. The model only
              does as much work as your chosen scale needs, so a 1.5x or 2x
              target finishes well before a 4x one.
            </p>
            {kind === "video" && (
              <>
                <p className="mt-2 text-caption text-(--color-text-muted)">
                  Video is upscaled frame by frame, so it's slower than a simple
                  resize{isLongVideo ? " — this clip is long enough that it may take a while and use a lot of memory; a shorter clip will go faster" : ""}.
                  There's no GPU shortcut for this in-browser, so speed comes
                  from processing fewer frames per second.
                </p>
                <div className="mt-3 flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                  <button
                    type="button"
                    onClick={() => setVideoQuality("fast")}
                    className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${videoQuality === "fast" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                  >
                    Fast (~{FAST_MODE_MAX_FPS}fps)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVideoQuality("full")}
                    className={`flex-1 rounded px-3 py-1.5 text-caption font-medium transition-colors ${videoQuality === "full" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                  >
                    Every frame
                  </button>
                </div>
                <p className="mt-2 text-caption text-(--color-text-muted)">
                  {videoQuality === "fast"
                    ? `Processes at up to ${FAST_MODE_MAX_FPS}fps and outputs at that rate — roughly halves the wait on typical 24-30fps footage, at the cost of less smooth motion. Good for talking-head or mostly-static clips.`
                    : "Processes and outputs every source frame — smoothest motion, but takes the longest."}
                </p>
              </>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? metadataError}
            runLabel={exportState.runLabel}
            engineLabel="Downloading AI model…"
            etaLabel={exportState.etaLabel}
            tip="This runs entirely on your device, so it's fine to switch tabs — keep working on other things, or put on your favorite song, and check back once it's done."
          />

          <button
            type="button"
            disabled={exportState.isProcessing || !size}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles size={16} />
            {exportState.isProcessing ? "Upscaling…" : "Upscale"}
          </button>
        </>
      }
      preview={
        sourceUrl && (
          <SimplePreviewStage
            kind={kind}
            videoRef={videoRef}
            sourceUrl={sourceUrl}
            onLoadedMetadata={handleVideoMetadata}
            onError={handleVideoError}
            onLoad={handleImageLoad}
          />
        )
      }
    />
  );
}
