import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, guessImageExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";
import { upscaleFilter } from "../../../lib/ffmpeg/upscale-filter";

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
  const [metadataError, setMetadataError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("factor");
  const [factor, setFactor] = useState(2);
  const [resolutionId, setResolutionId] = useState("1080p");
  const [sharpen, setSharpen] = useState(true);

  const exportState = useFfmpegExport();
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
  };

  const handleVideoError = () => {
    setMetadataError("Your browser couldn't read this video. Try converting it to MP4 (H.264) first.");
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

  const handleExport = async () => {
    if (!file || !size) return;
    const vf = upscaleFilter(size.w, size.h, sharpen);

    if (kind === "image") {
      const ext = guessImageExtension(file);
      const inputName = `input.${ext}`;
      const outputName = "output.png";
      await exportState.run(
        {
          inputs: [{ name: inputName, data: file }],
          args: ["-i", inputName, "-vf", vf, outputName],
          outputName,
          outputMimeType: "image/png",
        },
        `upscaled-${stripExtension(file.name)}.png`,
      );
      return;
    }

    const ext = guessVideoExtension(file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";
    await exportState.run(
      {
        inputs: [{ name: inputName, data: file }],
        args: [
          "-i",
          inputName,
          "-vf",
          vf,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "20",
          "-c:a",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `upscaled-${stripExtension(file.name)}.mp4`,
    );
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
      <Dropzone
        accept="image/*,video/*"
        label="Drop an image or video here, or click to browse"
        hint="Upscale its resolution with sharpened, lanczos-resampled scaling"
        onFiles={handleFiles}
      />
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

            <label className="mt-4 flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={sharpen}
                onChange={(e) => setSharpen(e.target.checked)}
                className="accent-(--color-primary-500)"
              />
              Sharpen (recommended)
            </label>

            <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-3 text-caption text-(--color-text-muted)">
              {width > 0 && height > 0 ? (
                size ? (
                  <>
                    {width}×{height} &rarr; <span className="font-semibold text-(--color-text)">{size.w}×{size.h}</span>
                  </>
                ) : (
                  "Your file already meets or exceeds this target — nothing to upscale."
                )
              ) : (
                "Reading file…"
              )}
            </div>
            <p className="mt-3 text-caption text-(--color-text-muted)">
              This is fast, filter-based upscaling (sharpened lanczos resampling) — not an AI model generating new
              detail, so very large jumps (e.g. 4x on a small source) will look softer than a dedicated
              super-resolution tool.
            </p>
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? metadataError}
            runLabel="Upscaling…"
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
