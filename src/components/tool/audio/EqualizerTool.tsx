import { useState } from "react";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
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

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function bandLabel(hz: number) {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

const PRESETS: Record<string, number[]> = {
  Flat: BANDS.map(() => 0),
  Bass: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  Vocal: [-2, -2, 0, 3, 5, 5, 3, 1, 0, -1],
};

export default function EqualizerTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();
  const [gains, setGains] = useState<number[]>(() => BANDS.map(() => 0));

  const setGain = (index: number, value: number) => {
    setGains((prev) => prev.map((g, i) => (i === index ? value : g)));
  };

  const hasChanges = gains.some((g) => g !== 0);

  const handleExport = async () => {
    if (!audio.file || !hasChanges) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    const filter = BANDS.map(
      (freq, i) => `equalizer=f=${freq}:t=q:w=1:g=${gains[i]}`,
    ).join(",");

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: ["-i", inputName, "-af", filter, outputName],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `equalized-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
    setGains(BANDS.map(() => 0));
  };

  if (!audio.hasFile) {
    return (
      <ToolUploadScreen
        icon={SlidersHorizontal}
        title="Equalizer"
        description="Shape the sound with a 10-band graphic EQ."
      >
        <Dropzone
          accept="audio/*"
          label="Drop an audio file here, or click to browse"
          hint="Shape the sound with a 10-band graphic EQ"
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

      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {Object.entries(PRESETS).map(([name, values]) => (
          <button
            key={name}
            type="button"
            onClick={() => setGains(values)}
            className="rounded-full border border-(--color-border) px-3 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setGains(BANDS.map(() => 0))}
          className="inline-flex items-center gap-1 rounded-full border border-(--color-border) px-3 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
        >
          <RotateCcw size={11} />
          Reset
        </button>
      </div>

      <div className="mt-6 overflow-x-auto">
        <div
          className="flex items-end justify-between gap-2 sm:gap-4"
          style={{ minWidth: 420 }}
        >
          {BANDS.map((freq, i) => (
            <div key={freq} className="flex flex-1 flex-col items-center gap-2">
              <span className="text-caption tabular-nums text-(--color-text-muted)">
                {gains[i] > 0 ? `+${gains[i]}` : gains[i]}
              </span>
              <div className="flex h-32 items-center">
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={gains[i]}
                  onChange={(e) => setGain(i, Number(e.target.value))}
                  aria-label={`${bandLabel(freq)}Hz band gain`}
                  className="h-32 w-2 accent-(--color-primary-500)"
                  style={{ writingMode: "vertical-lr", direction: "rtl" }}
                />
              </div>
              <span className="text-caption text-(--color-text-faint)">
                {bandLabel(freq)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Applying equalizer…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || !hasChanges}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <SlidersHorizontal size={16} />
          {exportState.isProcessing ? "Processing…" : "Apply equalizer"}
        </button>
      </div>
    </div>
  );
}
