import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import AudioWaveform from "./AudioWaveform";
import { useAudioFile } from "../../../lib/hooks/useAudioFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessAudioExtension, stripExtension, AUDIO_EXT_MIME } from "../../../lib/ffmpeg/format";

export default function AudioVolumeTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();
  const [percent, setPercent] = useState(100);
  const [muted, setMuted] = useState(false);

  const handleExport = async () => {
    if (!audio.file) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;
    const volumeArg = muted ? "0" : (percent / 100).toFixed(2);

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: ["-i", inputName, "-af", `volume=${volumeArg}`, outputName],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `volume-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
    setPercent(100);
    setMuted(false);
  };

  if (!audio.hasFile) {
    return (
      <Dropzone
        accept="audio/*"
        label="Drop an audio file here, or click to browse"
        hint="Make it louder, quieter, or silent"
        onFiles={audio.handleFiles}
      />
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

      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted((m) => !m)}
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors ${
            muted
              ? "border-danger-500 bg-danger-500/10 text-danger-600"
              : "border-(--color-border) hover:border-(--color-border-strong)"
          }`}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          type="range"
          min={0}
          max={200}
          value={percent}
          disabled={muted}
          onChange={(e) => setPercent(Number(e.target.value))}
          className="flex-1 accent-(--color-primary-500) disabled:opacity-40"
        />
        <span className="w-14 text-right text-body-sm font-semibold tabular-nums">
          {muted ? "0%" : `${percent}%`}
        </span>
      </div>

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Adjusting volume…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Volume2 size={16} />
          {exportState.isProcessing ? "Processing…" : "Apply volume"}
        </button>
      </div>
    </div>
  );
}
