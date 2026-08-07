import { useState } from "react";
import { FlipHorizontal, FlipVertical } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TransformedVideoPreview from "./TransformedVideoPreview";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";

export default function FlipVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);

  const handleExport = async () => {
    if (!video.file || (!flipH && !flipV)) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";
    const filter = [flipH && "hflip", flipV && "vflip"].filter(Boolean).join(",");

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-vf",
          filter,
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
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Mirror a video horizontally or vertically"
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
        <TransformedVideoPreview
          videoRef={video.videoRef}
          sourceUrl={video.sourceUrl}
          flipH={flipH}
          flipV={flipV}
          naturalWidth={video.videoWidth}
          naturalHeight={video.videoHeight}
          onLoadedMetadata={video.onLoadedMetadata}
        />
      )}

      <div className="mt-5 flex items-center justify-center gap-3">
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

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Flipping video…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || (!flipH && !flipV)}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FlipHorizontal size={16} />
          {exportState.isProcessing ? "Flipping…" : "Flip video"}
        </button>
      </div>
    </div>
  );
}
