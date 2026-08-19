import { useState } from "react";
import { Scissors } from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import AudioWaveform, { type AudioRegion } from "./AudioWaveform";
import { useAudioFile } from "../../../lib/hooks/useAudioFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import {
  guessAudioExtension,
  stripExtension,
  AUDIO_EXT_MIME,
} from "../../../lib/ffmpeg/format";
import { formatTime, toFfmpegTimestamp } from "../../../lib/time";

export default function AudioTrimTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();
  const [region, setRegion] = useState<AudioRegion>({ start: 0, end: 0 });

  const handleExport = async () => {
    if (!audio.file) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: [
          "-ss",
          toFfmpegTimestamp(region.start),
          "-i",
          inputName,
          "-to",
          toFfmpegTimestamp(region.end - region.start),
          "-c",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `trimmed-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
    setRegion({ start: 0, end: 0 });
  };

  if (!audio.hasFile) {
    return (
      <ToolUploadScreen
        icon={Scissors}
        title="Trim Audio"
        description="Cut an audio file down to the part you need."
      >
        <Dropzone
          accept="audio/*"
          label="Drop an audio file here, or click to browse"
          hint="MP3, WAV, M4A, and more — processed entirely on your device"
          onFiles={audio.handleFiles}
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
        kind="audio"
        onReset={reset}
      />
    );
  }

  const selected = Math.max(0, region.end - region.start);

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      {audio.sourceUrl && (
        <AudioWaveform
          url={audio.sourceUrl}
          enableRegion
          onRegionChange={setRegion}
        />
      )}

      <p className="mt-3 text-center text-body-sm text-(--color-text-muted)">
        Drag the highlighted region's edges to choose what to keep. Selected:{" "}
        <span className="font-semibold text-(--color-text)">
          {formatTime(selected)}
        </span>
      </p>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Trimming audio…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || selected <= 0}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Scissors size={16} />
          {exportState.isProcessing ? "Trimming…" : "Trim audio"}
        </button>
      </div>
    </div>
  );
}
