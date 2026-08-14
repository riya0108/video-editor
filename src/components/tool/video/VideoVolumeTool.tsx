import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension, VIDEO_EXT_MIME } from "../../../lib/ffmpeg/format";

export default function VideoVolumeTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [percent, setPercent] = useState(100);
  const [muted, setMuted] = useState(false);

  const handleExport = async () => {
    if (!video.file) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;
    const volumeArg = muted ? "0" : (percent / 100).toFixed(2);

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-c:v",
          "copy",
          "-af",
          `volume=${volumeArg}`,
          "-c:a",
          "aac",
          outputName,
        ],
        outputName,
        outputMimeType: VIDEO_EXT_MIME[ext] ?? video.file.type ?? "video/mp4",
      },
      `volume-${stripExtension(video.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setPercent(100);
    setMuted(false);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Turn audio up, down, or off entirely"
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
          <ToolPanelSection icon={Volume2} label="Volume">
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label={muted ? "Unmute" : "Mute"}
                onClick={() => setMuted((m) => !m)}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors ${
                  muted
                    ? "border-danger-500 bg-danger-500/10 text-danger-600"
                    : "border-(--color-border) hover:border-(--color-border-strong)"
                }`}
              >
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min={0}
                max={200}
                value={percent}
                disabled={muted}
                onChange={(e) => setPercent(Number(e.target.value))}
                className="flex-1 accent-(--color-primary-500) disabled:opacity-40"
              />
              <span className="w-14 text-right text-body-sm font-semibold tabular-nums">
                {muted ? "0%" : `${percent}%`}
              </span>
            </div>
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Adjusting volume…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Volume2 size={16} />
            {exportState.isProcessing ? "Processing…" : "Apply volume"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <SimplePreviewStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            muted={muted}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          />
        )
      }
    />
  );
}
