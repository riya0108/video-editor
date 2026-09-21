import { useState } from "react";
import { FlipHorizontal, FlipVertical } from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import ResizeForPlatformSection from "./ResizeForPlatformSection";
import TransformedVideoPreview from "./TransformedVideoPreview";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import {
  guessVideoExtension,
  stripExtension,
} from "../../../lib/ffmpeg/format";
import { applyResizeCanvas, DEFAULT_RESIZE_SETTINGS, type ResizeCanvasSettings } from "../../../lib/ffmpeg/resize-canvas-filter";

export default function FlipVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [resize, setResize] = useState<ResizeCanvasSettings>(DEFAULT_RESIZE_SETTINGS);

  const handleExport = async () => {
    if (!video.file || (!flipH && !flipV && !resize.enabled)) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    const inputArgs = ["-threads", "1", "-i", inputName];
    const filters: string[] = [];
    let inputCount = 1;
    let labelCount = 0;
    const newLabel = (prefix: "v") => `${prefix}${++labelCount}`;
    const addLavfiInput = (source: string, preArgs: string[] = []): number => {
      inputArgs.push(...preArgs, "-f", "lavfi", "-i", source);
      return inputCount++;
    };

    let vLabel = "0:v";
    const flipFilter = [flipH && "hflip", flipV && "vflip"].filter(Boolean).join(",");
    if (flipFilter) {
      const flipped = newLabel("v");
      filters.push(`[${vLabel}]${flipFilter}[${flipped}]`);
      vLabel = flipped;
    }
    if (resize.enabled) {
      const resized = applyResizeCanvas({
        vLabel,
        filters,
        addLavfiInput,
        newLabel,
        settings: resize,
        durationSeconds: video.duration,
      });
      vLabel = resized.vLabel;
    }

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          ...inputArgs,
          "-filter_complex",
          filters.join(";"),
          "-map",
          `[${vLabel}]`,
          "-map",
          "0:a?",
          "-filter_threads",
          "1",
          "-filter_complex_threads",
          "1",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          resize.enabled ? "aac" : "copy",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `flipped-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setFlipH(false);
    setFlipV(false);
  };

  if (!video.hasFile) {
    return (
      <ToolUploadScreen
        icon={FlipHorizontal}
        title="Flip Video"
        description="Mirror a video horizontally or vertically."
      >
        <Dropzone
          accept="video/*"
          label="Drop a video here, or click to browse"
          hint="Mirror a video horizontally or vertically"
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
          <ToolPanelSection icon={FlipHorizontal} label="Flip">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setFlipH((v) => !v)}
                className={`inline-flex items-center gap-2 rounded-md border px-4 py-2 text-body-sm font-semibold transition-colors ${
                  flipH
                    ? "border-primary-500 bg-primary-500 text-white"
                    : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                }`}
              >
                <FlipHorizontal size={16} />
                Flip horizontal
              </button>
              <button
                type="button"
                onClick={() => setFlipV((v) => !v)}
                className={`inline-flex items-center gap-2 rounded-md border px-4 py-2 text-body-sm font-semibold transition-colors ${
                  flipV
                    ? "border-primary-500 bg-primary-500 text-white"
                    : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                }`}
              >
                <FlipVertical size={16} />
                Flip vertical
              </button>
            </div>
          </ToolPanelSection>

          <ResizeForPlatformSection value={resize} onChange={setResize} />

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Flipping video…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || (!flipH && !flipV && !resize.enabled)}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FlipHorizontal size={16} />
            {exportState.isProcessing ? "Flipping…" : "Flip video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <TransformedVideoPreview
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            flipH={flipH}
            flipV={flipV}
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
