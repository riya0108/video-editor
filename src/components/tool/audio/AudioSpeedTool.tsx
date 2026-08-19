import { useState } from "react";
import { Gauge } from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import AudioWaveform from "./AudioWaveform";
import { useAudioFile } from "../../../lib/hooks/useAudioFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import {
  guessAudioExtension,
  stripExtension,
  AUDIO_EXT_MIME,
} from "../../../lib/ffmpeg/format";
import { atempoChain } from "../../../lib/ffmpeg/audio-filters";

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function AudioSpeedTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();
  const [speed, setSpeed] = useState(1);

  const handleExport = async () => {
    if (!audio.file || speed === 1) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: ["-i", inputName, "-af", atempoChain(speed), outputName],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `${speed}x-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
    setSpeed(1);
  };

  if (!audio.hasFile) {
    return (
      <ToolUploadScreen
        icon={Gauge}
        title="Change Speed"
        description="Speed up or slow down without changing pitch."
      >
        <Dropzone
          accept="audio/*"
          label="Drop an audio file here, or click to browse"
          hint="Speed up or slow down without changing pitch"
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

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      {audio.sourceUrl && <AudioWaveform url={audio.sourceUrl} />}

      <div className="mt-5">
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
          min={0.5}
          max={2}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="mt-4 w-full accent-(--color-primary-500)"
        />
        <p className="text-center text-body-sm font-semibold">
          {speed.toFixed(2)}&times;
        </p>
      </div>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Changing speed…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || speed === 1}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Gauge size={16} />
          {exportState.isProcessing ? "Processing…" : "Change speed"}
        </button>
      </div>
    </div>
  );
}
