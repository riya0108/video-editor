import { useState } from "react";
import { Anchor } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { stabilizeFilter, type StabilizeStrength } from "../../../lib/ffmpeg/video-filters";

const STRENGTHS: { id: StabilizeStrength; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "standard", label: "Standard" },
  { id: "strong", label: "Strong" },
];

export default function StabilizeVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [strength, setStrength] = useState<StabilizeStrength>("standard");

  const handleExport = async () => {
    if (!video.file) return;
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
          stabilizeFilter(strength),
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
      `stabilized-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a shaky video here, or click to browse"
        hint="Smooths out handheld camera shake"
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
        <div className="overflow-hidden rounded-lg bg-black">
          <video
            ref={video.videoRef}
            src={video.sourceUrl}
            controls
            className="max-h-96 w-full"
            onLoadedMetadata={video.onLoadedMetadata}
          />
        </div>
      )}

      <div className="mt-5 flex items-center justify-center gap-1 rounded-md border border-(--color-border) p-1">
        {STRENGTHS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStrength(s.id)}
            className={`flex-1 rounded px-4 py-1.5 text-body-sm font-medium transition-colors ${
              strength === s.id
                ? "bg-primary-500 text-white"
                : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-center text-caption text-(--color-text-muted)">
        Stronger settings smooth out bigger shakes but crop in and soften the frame a bit more.
      </p>

      <p className="mt-4 text-center text-body-sm text-(--color-text-muted)">
        Stabilizing re-encodes the whole clip, so it can take a little longer than other tools.
      </p>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Stabilizing video…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Anchor size={16} />
          {exportState.isProcessing ? "Stabilizing…" : "Stabilize video"}
        </button>
      </div>
    </div>
  );
}
