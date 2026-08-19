import { useState } from "react";
import { Gauge } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { atempoChain } from "../../../lib/ffmpeg/audio-filters";
import { formatTime } from "../../../lib/time";

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

export default function VideoSpeedTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [speed, setSpeed] = useState(1);

  const handleExport = async () => {
    if (!video.file || speed === 1) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-filter_complex",
          `[0:v]setpts=PTS/${speed}[v];[0:a]${atempoChain(speed)}[a]`,
          "-map",
          "[v]",
          "-map",
          "[a]",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `${speed}x-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setSpeed(1);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Slow footage down or speed it up"
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
          <ToolPanelSection icon={Gauge} label="Speed">
            <div className="flex flex-wrap justify-center gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSpeed(p)}
                  className={`rounded-full border px-4 py-1.5 text-body-sm font-semibold transition-colors ${
                    speed === p
                      ? "border-primary-500 bg-primary-500 text-white"
                      : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)"
                  }`}
                >
                  {p}&times;
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="mt-4 w-full accent-(--color-primary-500)"
            />
            <div className="flex items-center justify-between text-caption text-(--color-text-muted)">
              <span>0.25&times;</span>
              <span className="text-body-sm font-semibold text-(--color-text)">{speed.toFixed(2)}&times;</span>
              <span>4&times;</span>
            </div>
            {video.duration > 0 && (
              <p className="mt-1 text-center text-caption text-(--color-text-muted)">
                New length: {formatTime(video.duration / speed)}
              </p>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Changing speed…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || speed === 1}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Gauge size={16} />
            {exportState.isProcessing ? "Processing…" : "Change speed"}
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
