import { useEffect, useRef, useState } from "react";
import { Music, Mic, Square } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import SimplePreviewStage from "./SimplePreviewStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { stopAllTracks } from "../../../lib/media/mix-audio";
import {
  AUDIO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";
import { guessVideoExtension, guessAudioExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { formatTime } from "../../../lib/time";

// "Duck" is the dubbing case: the new track is a spoken-word replacement
// (voiceover/dub) that should read clearly, with the original audio kept
// underneath at low volume instead of removed outright or mixed evenly.
type Mode = "replace" | "mix" | "duck";
const DUCK_LEVEL = 0.15;

export default function AddAudioTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("replace");

  const dubRecorder = useMediaRecorder();
  const dubStreamRef = useRef<MediaStream | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!dubRecorder.result) return;
    const ext = extensionForMimeType(dubRecorder.result.blob.type);
    const file = new File([dubRecorder.result.blob], `dub-recording.${ext}`, { type: dubRecorder.result.blob.type });
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
    setMode("duck");
    dubRecorder.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dubRecorder.result]);

  const startDubRecording = async () => {
    setRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      dubStreamRef.current = stream;
      const mimeType = pickSupportedMimeType(AUDIO_RECORDER_MIME_CANDIDATES);
      dubRecorder.start(stream, mimeType);
    } catch {
      setRecordError("Microphone access needs your permission.");
    }
  };
  const stopDubRecording = () => {
    dubRecorder.stop();
    stopAllTracks(dubStreamRef.current);
    dubStreamRef.current = null;
  };
  useEffect(() => () => stopAllTracks(dubStreamRef.current), []);

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
        : mode === "duck"
          ? [
              "-i",
              inputName,
              "-i",
              audioName,
              "-filter_complex",
              `[0:a]volume=${DUCK_LEVEL}[ducked];[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]`,
              "-map",
              "0:v",
              "-map",
              "[a]",
              "-c:v",
              "copy",
              "-c:a",
              "aac",
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
    setMode("replace");
    dubRecorder.reset();
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Mix in music, dub over the voice, or add a voiceover track"
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
              <div className="space-y-3">
                <Dropzone
                  accept="audio/*"
                  label="Drop an audio file here"
                  hint="MP3, WAV, M4A, and more"
                  onFiles={handleAudioFiles}
                />
                <div className="flex items-center gap-2">
                  <div className="h-px flex-1 bg-(--color-border)" />
                  <span className="text-caption text-(--color-text-muted)">or</span>
                  <div className="h-px flex-1 bg-(--color-border)" />
                </div>
                {dubRecorder.state !== "recording" ? (
                  <button
                    type="button"
                    onClick={startDubRecording}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                  >
                    <Mic size={15} />
                    Record a dub with your mic
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopDubRecording}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-danger-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-danger-600"
                  >
                    <Square size={13} />
                    Stop recording · {formatTime(dubRecorder.elapsedMs / 1000)}
                  </button>
                )}
                {(recordError || dubRecorder.error) && (
                  <p className="text-caption text-danger-600">{recordError ?? dubRecorder.error}</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {audioUrl && <audio src={audioUrl} controls className="w-full" />}
                <div className="flex items-center justify-center gap-1 rounded-md border border-(--color-border) p-1">
                  <button
                    type="button"
                    onClick={() => setMode("replace")}
                    className={`flex-1 rounded px-3 py-1.5 text-body-sm font-medium transition-colors ${
                      mode === "replace"
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("mix")}
                    className={`flex-1 rounded px-3 py-1.5 text-body-sm font-medium transition-colors ${
                      mode === "mix"
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    Mix
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("duck")}
                    className={`flex-1 rounded px-3 py-1.5 text-body-sm font-medium transition-colors ${
                      mode === "duck"
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    Dub (duck original)
                  </button>
                </div>
                <p className="text-caption text-(--color-text-muted)">
                  {mode === "replace" && "The original audio is dropped entirely."}
                  {mode === "mix" && "Both tracks play together at even volume."}
                  {mode === "duck" && "This track plays clearly, with the original kept quiet underneath — ideal for a dubbed voiceover."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setAudioFile(null);
                    setAudioUrl(null);
                  }}
                  className="text-caption font-medium text-danger-600 hover:underline"
                >
                  Remove and choose another
                </button>
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
          <SimplePreviewStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          />
        )
      }
    />
  );
}
