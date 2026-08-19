import { useState } from "react";
import { Crop } from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import {
  guessVideoExtension,
  stripExtension,
} from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";

const DEFAULT_RECT: FractionRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

export default function CropVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [rect, setRect] = useState<FractionRect>(DEFAULT_RECT);

  const handleExport = async () => {
    if (!video.file || video.videoWidth === 0 || video.isMetadataLoading)
      return;
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
      <ToolUploadScreen
        icon={Crop}
        title="Crop Video"
        description="Cut out unwanted edges or change the frame."
      >
        <Dropzone
          accept="video/*"
          label="Drop a video here, or click to browse"
          hint="Drag the box to choose what stays in frame"
          onFiles={video.handleFiles}
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
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <ToolSplitLayout
      controls={
        <>
          <ToolPanelSection icon={Crop} label="Crop">
            <p className="text-body-sm text-(--color-text-muted)">
              {video.isMetadataLoading
                ? "Reading your video…"
                : "Drag the box on the preview to choose what stays in frame."}
            </p>
            {video.videoWidth > 0 && (
              <p className="mt-2 text-caption tabular-nums text-(--color-text-muted)">
                {evenRound(rect.w * video.videoWidth)} &times;{" "}
                {evenRound(rect.h * video.videoHeight)}px
              </p>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Cropping video…"
          />

          <button
            type="button"
            disabled={
              exportState.isProcessing ||
              video.isMetadataLoading ||
              !!video.metadataError
            }
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Crop size={16} />
            {exportState.isProcessing
              ? "Cropping…"
              : video.isMetadataLoading
                ? "Reading video…"
                : "Crop video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <FramedVideoStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            naturalWidth={video.videoWidth}
            naturalHeight={video.videoHeight}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          >
            {(box) => (
              <RectOverlay
                boxWidth={box.width}
                boxHeight={box.height}
                rect={rect}
                onChange={setRect}
              />
            )}
          </FramedVideoStage>
        )
      }
    />
  );
}
