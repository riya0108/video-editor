import { useState } from "react";
import { Maximize } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";

const PRESETS = [
  { id: "youtube", label: "YouTube (1920×1080)", width: 1920, height: 1080 },
  { id: "square", label: "Instagram Square (1080×1080)", width: 1080, height: 1080 },
  { id: "story", label: "Reels / Story / TikTok (1080×1920)", width: 1080, height: 1920 },
  { id: "twitter", label: "Twitter / X (1280×720)", width: 1280, height: 720 },
  { id: "custom", label: "Custom size", width: 0, height: 0 },
];

export default function ResizeVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [presetId, setPresetId] = useState("youtube");
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(720);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const targetWidth = presetId === "custom" ? customWidth : preset.width;
  const targetHeight = presetId === "custom" ? customHeight : preset.height;

  const handleExport = async () => {
    if (!video.file) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";
    const w = evenRound(targetWidth);
    const h = evenRound(targetHeight);

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-vf",
          `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `resized-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setPresetId("youtube");
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Fit it to any platform's ideal size"
        onFiles={video.handleFiles}
      />
    );
  }

  if (exportState.result) {
    return (
      <ResultPanel
        url={exportState.result.url}
        blob={exportState.result.blob}
        filename={exportState.result.filename}
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <ToolSplitLayout
      controls={
        <>
          <ToolPanelSection icon={Maximize} label="Target size">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  className={`rounded-lg border px-4 py-3 text-left text-body-sm font-medium transition-colors ${
                    presetId === p.id
                      ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                      : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {presetId === "custom" && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <label className="flex flex-col items-start gap-1 text-caption text-(--color-text-muted)">
                  Width
                  <input
                    type="number"
                    min={2}
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value) || 0)}
                    className="w-24 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                  />
                </label>
                <span className="mt-4 text-(--color-text-faint)">&times;</span>
                <label className="flex flex-col items-start gap-1 text-caption text-(--color-text-muted)">
                  Height
                  <input
                    type="number"
                    min={2}
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Number(e.target.value) || 0)}
                    className="w-24 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                  />
                </label>
              </div>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Resizing video…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || targetWidth < 2 || targetHeight < 2}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Maximize size={16} />
            {exportState.isProcessing ? "Resizing…" : "Resize video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <SimplePreviewStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          />
        )
      }
    />
  );
}
