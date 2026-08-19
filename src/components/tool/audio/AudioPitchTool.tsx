import { useState } from "react";
import { Music2 } from "lucide-react";
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

const WORK_RATE = 44100;

export default function AudioPitchTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();
  const [semitones, setSemitones] = useState(0);

  const handleExport = async () => {
    if (!audio.file || semitones === 0) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    const factor = Math.pow(2, semitones / 12);
    // Force a known sample rate first so the asetrate trick's math is exact
    // regardless of the source file's native rate.
    const filter = [
      `aresample=${WORK_RATE}`,
      `asetrate=${WORK_RATE}*${factor.toFixed(6)}`,
      `aresample=${WORK_RATE}`,
      atempoChain(1 / factor),
    ].join(",");

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: ["-i", inputName, "-af", filter, outputName],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `pitch-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
    setSemitones(0);
  };

  if (!audio.hasFile) {
    return (
      <ToolUploadScreen
        icon={Music2}
        title="Change Pitch"
        description="Shift pitch up or down independent of speed."
      >
        <Dropzone
          accept="audio/*"
          label="Drop an audio file here, or click to browse"
          hint="Shift pitch up or down independent of speed"
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
        <input
          type="range"
          min={-12}
          max={12}
          step={1}
          value={semitones}
          onChange={(e) => setSemitones(Number(e.target.value))}
          className="w-full accent-(--color-primary-500)"
        />
        <p className="text-center text-body-sm font-semibold">
          {semitones === 0
            ? "No change"
            : `${semitones > 0 ? "+" : ""}${semitones} semitones`}
        </p>
      </div>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Shifting pitch…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || semitones === 0}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Music2 size={16} />
          {exportState.isProcessing ? "Processing…" : "Change pitch"}
        </button>
      </div>
    </div>
  );
}
