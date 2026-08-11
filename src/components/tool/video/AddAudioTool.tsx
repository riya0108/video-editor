import { useEffect, useState } from "react";
import { Music } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, guessAudioExtension, stripExtension } from "../../../lib/ffmpeg/format";

type Mode = "replace" | "mix";

export default function AddAudioTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("replace");

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const handleAudioFiles = (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    setAudioFile(picked);
    setAudioUrl(URL.createObjectURL(picked));
  };

  const handleExport = async () => {
    if (!video.file || !audioFile) return;
    const ext = guessVideoExtension(video.file);
    const audioExt = guessAudioExtension(audioFile);
    const inputName = `input.${ext}`;
    const audioName = `audio.${audioExt}`;
    const outputName = "output.mp4";

    const args =
      mode === "replace"
        ? [
            "-i",
            inputName,
            "-i",
            audioName,
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-shortest",
            outputName,
          ]
        : [
            "-i",
            inputName,
            "-i",
            audioName,
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]",
            "-map",
            "0:v",
            "-map",
            "[a]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            outputName,
          ];

    await exportState.run(
      {
        inputs: [
          { name: inputName, data: video.file },
          { name: audioName, data: audioFile },
        ],
        args,
        outputName,
        outputMimeType: "video/mp4",
      },
      `with-audio-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setAudioFile(null);
    setAudioUrl(null);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Mix in music or a voiceover track"
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
    <ToolSplitLayout
      controls={
        <>
          <ToolPanelSection icon={Music} label="Audio track">
            {!audioFile ? (
              <Dropzone
                accept="audio/*"
                label="Drop an audio file here"
                hint="MP3, WAV, M4A, and more"
                onFiles={handleAudioFiles}
              />
            ) : (
              <div className="space-y-4">
                {audioUrl && <audio src={audioUrl} controls className="w-full" />}
                <div className="flex items-center justify-center gap-1 rounded-md border border-(--color-border) p-1">
                  <button
                    type="button"
                    onClick={() => setMode("replace")}
                    className={`rounded px-4 py-1.5 text-body-sm font-medium transition-colors ${
                      mode === "replace"
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    Replace original audio
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("mix")}
                    className={`rounded px-4 py-1.5 text-body-sm font-medium transition-colors ${
                      mode === "mix"
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    Mix with original audio
                  </button>
                </div>
              </div>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Adding audio…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || !audioFile}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Music size={16} />
            {exportState.isProcessing ? "Adding audio…" : "Add audio"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <div className="overflow-hidden rounded-lg bg-black">
            <video
              ref={video.videoRef}
              src={video.sourceUrl}
              controls
              className="max-h-[32rem] w-full"
              onLoadedMetadata={video.onLoadedMetadata}
              onError={video.onError}
            />
          </div>
        )
      }
    />
  );
}
