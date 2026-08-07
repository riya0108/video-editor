import { Rewind } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import AudioWaveform from "./AudioWaveform";
import { useAudioFile } from "../../../lib/hooks/useAudioFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessAudioExtension, stripExtension, AUDIO_EXT_MIME } from "../../../lib/ffmpeg/format";

export default function ReverseAudioTool() {
  const audio = useAudioFile();
  const exportState = useFfmpegExport();

  const handleExport = async () => {
    if (!audio.file) return;
    const ext = guessAudioExtension(audio.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    await exportState.run(
      {
        inputs: [{ name: inputName, data: audio.file }],
        args: ["-i", inputName, "-af", "areverse", outputName],
        outputName,
        outputMimeType: AUDIO_EXT_MIME[ext] ?? audio.file.type ?? "audio/mpeg",
      },
      `reversed-${stripExtension(audio.file.name)}.${ext}`,
    );
  };

  const reset = () => {
    exportState.reset();
    audio.reset();
  };

  if (!audio.hasFile) {
    return (
      <Dropzone
        accept="audio/*"
        label="Drop an audio file here, or click to browse"
        hint="Play a track backwards"
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

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Reversing audio…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Rewind size={16} />
          {exportState.isProcessing ? "Reversing…" : "Reverse audio"}
        </button>
      </div>
    </div>
  );
}
