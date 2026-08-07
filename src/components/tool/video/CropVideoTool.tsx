import { useState } from "react";
import { Crop } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";

const DEFAULT_RECT: FractionRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

export default function CropVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [rect, setRect] = useState<FractionRect>(DEFAULT_RECT);

  const handleExport = async () => {
    if (!video.file || video.videoWidth === 0) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    const w = evenRound(rect.w * video.videoWidth);
    const h = evenRound(rect.h * video.videoHeight);
    const x = evenRound(rect.x * video.videoWidth);
    const y = evenRound(rect.y * video.videoHeight);

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-vf",
          `crop=${w}:${h}:${x}:${y}`,
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
      `cropped-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setRect(DEFAULT_RECT);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Drag the box to choose what stays in frame"
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
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      {video.sourceUrl && (
        <FramedVideoStage
          videoRef={video.videoRef}
          sourceUrl={video.sourceUrl}
          naturalWidth={video.videoWidth}
          naturalHeight={video.videoHeight}
          onLoadedMetadata={video.onLoadedMetadata}
        >
          {(box) => (
            <RectOverlay boxWidth={box.width} boxHeight={box.height} rect={rect} onChange={setRect} />
          )}
        </FramedVideoStage>
      )}

      {video.videoWidth > 0 && (
        <p className="mt-3 text-center text-caption tabular-nums text-(--color-text-muted)">
          {evenRound(rect.w * video.videoWidth)} &times; {evenRound(rect.h * video.videoHeight)}px
        </p>
      )}

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Cropping video…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Crop size={16} />
          {exportState.isProcessing ? "Cropping…" : "Crop video"}
        </button>
      </div>
    </div>
  );
}
