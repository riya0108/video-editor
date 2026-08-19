import { useState } from "react";
import { RotateCcw, RotateCw as RotateCwIcon } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import TransformedVideoPreview from "./TransformedVideoPreview";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";

const ROTATE_FILTER: Record<1 | 2 | 3, string> = {
  1: "transpose=1",
  2: "hflip,vflip",
  3: "transpose=2",
};

export default function RotateVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [turns, setTurns] = useState<0 | 1 | 2 | 3>(0);

  const rotateRight = () => setTurns((t) => ((t + 1) % 4) as 0 | 1 | 2 | 3);
  const rotateLeft = () => setTurns((t) => ((t + 3) % 4) as 0 | 1 | 2 | 3);

  const handleExport = async () => {
    if (!video.file || turns === 0) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-vf",
          ROTATE_FILTER[turns],
          "-c:v",
          "libx264",
          "-threads",
          "1",
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
      `rotated-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setTurns(0);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Fix sideways or upside-down footage"
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
          <ToolPanelSection icon={RotateCwIcon} label="Rotate">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={rotateLeft}
                className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
              >
                <RotateCcw size={16} />
                Rotate left
              </button>
              <button
                type="button"
                onClick={rotateRight}
                className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
              >
                <RotateCwIcon size={16} />
                Rotate right
              </button>
            </div>
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Rotating video…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || turns === 0}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCwIcon size={16} />
            {exportState.isProcessing ? "Rotating…" : "Rotate video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <TransformedVideoPreview
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            turns={turns}
            naturalWidth={video.videoWidth}
            naturalHeight={video.videoHeight}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          />
        )
      }
    />
  );
}
