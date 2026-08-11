import { useState } from "react";
import { Repeat, Minus, Plus } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension, VIDEO_EXT_MIME } from "../../../lib/ffmpeg/format";
import { formatTime } from "../../../lib/time";

export default function LoopVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [repeats, setRepeats] = useState(2);

  const handleExport = async () => {
    if (!video.file) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-stream_loop",
          String(repeats - 1),
          "-i",
          inputName,
          "-c",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: VIDEO_EXT_MIME[ext] ?? video.file.type ?? "video/mp4",
      },
      `looped-${stripExtension(video.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setRepeats(2);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Repeat a clip to reach a target length"
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
          <ToolPanelSection icon={Repeat} label="Repeat">
            <div className="flex flex-col items-center gap-3">
              <span className="text-body-sm font-medium text-(--color-text-muted)">Repeat this clip</span>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  aria-label="Fewer repeats"
                  onClick={() => setRepeats((r) => Math.max(2, r - 1))}
                  className="grid h-9 w-9 place-items-center rounded-full border border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                >
                  <Minus size={16} />
                </button>
                <span className="w-20 text-center text-h3 font-bold tabular-nums">{repeats}&times;</span>
                <button
                  type="button"
                  aria-label="More repeats"
                  onClick={() => setRepeats((r) => Math.min(20, r + 1))}
                  className="grid h-9 w-9 place-items-center rounded-full border border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                >
                  <Plus size={16} />
                </button>
              </div>
              {video.duration > 0 && (
                <p className="text-caption text-(--color-text-muted)">
                  New length: {formatTime(video.duration * repeats)}
                </p>
              )}
            </div>
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Looping video…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Repeat size={16} />
            {exportState.isProcessing ? "Looping…" : "Loop video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <div className="overflow-hidden rounded-lg bg-black">
            <video
              ref={video.videoRef}
              src={video.sourceUrl}
              controls
              className="max-h-[32rem] w-full"
              onLoadedMetadata={video.onLoadedMetadata}
              onError={video.onError}
            />
          </div>
        )
      }
    />
  );
}
