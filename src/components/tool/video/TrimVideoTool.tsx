import { useState } from "react";
import { Play, Pause, Scissors } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension, VIDEO_EXT_MIME } from "../../../lib/ffmpeg/format";
import { formatTime, toFfmpegTimestamp } from "../../../lib/time";

export default function TrimVideoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const handleLoadedMetadata = () => {
    video.onLoadedMetadata();
    const d = video.videoRef.current?.duration || 0;
    setStart(0);
    setEnd(d);
  };

  const clampToRange = (t: number) => Math.min(end, Math.max(start, t));

  const togglePlay = () => {
    const el = video.videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.currentTime = clampToRange(el.currentTime);
      el.play();
    } else {
      el.pause();
    }
  };

  const seekTo = (t: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    el.currentTime = clampToRange(t);
    setCurrentTime(el.currentTime);
  };

  const handleTimeUpdate = () => {
    const el = video.videoRef.current;
    if (!el) return;
    setCurrentTime(el.currentTime);
    if (el.currentTime >= end) el.pause();
  };

  const trimmedDuration = Math.max(0, end - start);

  const handleExport = async () => {
    if (!video.file) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-ss",
          toFfmpegTimestamp(start),
          "-to",
          toFfmpegTimestamp(end),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          outputName,
        ],
        outputName,
        outputMimeType: VIDEO_EXT_MIME[ext] ?? video.file.type ?? "video/mp4",
      },
      `trimmed-${stripExtension(video.file.name)}.${ext}`,
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
        label="Drop a video here, or click to browse"
        hint="MP4, WebM, MOV, and more — processed entirely on your device"
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
          <ToolPanelSection icon={Scissors} label="Trim">
            <TrimSlider
              duration={video.duration}
              start={start}
              end={end}
              currentTime={currentTime}
              onChangeStart={setStart}
              onChangeEnd={setEnd}
              onSeek={seekTo}
            />
            <div className="flex justify-between text-caption tabular-nums text-(--color-text-muted)">
              <span>{formatTime(start, true)}</span>
              <span>Selected: {formatTime(trimmedDuration)}</span>
              <span>{formatTime(end, true)}</span>
            </div>
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Trimming video…"
          />

          <button
            type="button"
            disabled={exportState.isProcessing || trimmedDuration <= 0}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Scissors size={16} />
            {exportState.isProcessing ? "Trimming…" : "Trim video"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <div>
            <div className="overflow-hidden rounded-lg bg-black">
              <video
                ref={video.videoRef}
                src={video.sourceUrl}
                className="max-h-[32rem] w-full"
                onLoadedMetadata={handleLoadedMetadata}
                onError={video.onError}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            </div>
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
              >
                {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
              </button>
            </div>
          </div>
        )
      }
    />
  );
}
