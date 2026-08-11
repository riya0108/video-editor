import { useEffect, useMemo, useState } from "react";
import { Wand2, Sparkles } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ProgressBar from "../ProgressBar";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { buildTrimConcatFilter } from "../../../lib/ffmpeg/build-trim-concat-filter";
import {
  transcribeWords,
  CAPTION_MODELS,
  type CaptionModelTier,
  type CaptionProgress,
} from "../../../lib/captions/auto-caption";
import { CAPTION_LANGUAGES } from "../../../lib/captions/languages";
import {
  DEFAULT_FILLER_WORDS,
  detectFillerWords,
  detectSilences,
  buildKeepIntervals,
  type RemovableSegment,
} from "../../../lib/captions/filler-silence";
import type { CaptionWord } from "../../../lib/captions/types";
import { formatTime } from "../../../lib/time";

const SILENCE_MIN = 0.3;
const SILENCE_MAX = 2;

function SegmentRow({
  segment,
  onToggle,
  onSeek,
}: {
  segment: RemovableSegment;
  onToggle: () => void;
  onSeek: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5">
      <input
        type="checkbox"
        checked={segment.included}
        onChange={onToggle}
        className="accent-(--color-primary-500)"
      />
      <button
        type="button"
        onClick={onSeek}
        className="text-caption tabular-nums text-(--color-text-muted) hover:text-(--color-text)"
      >
        {formatTime(segment.start, true)}
      </button>
      <span className={`text-body-sm ${segment.kind === "filler" ? "font-medium" : "text-(--color-text-muted) italic"}`}>
        {segment.label}
      </span>
      <span className="ml-auto text-caption text-(--color-text-faint)">
        {(segment.end - segment.start).toFixed(2)}s
      </span>
    </div>
  );
}

export default function RemoveFillerWordsTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();

  const [modelTier, setModelTier] = useState<CaptionModelTier>("fast");
  const [language, setLanguage] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<CaptionProgress | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [words, setWords] = useState<CaptionWord[] | null>(null);
  const [fillerSegments, setFillerSegments] = useState<RemovableSegment[]>([]);
  const [silenceSegments, setSilenceSegments] = useState<RemovableSegment[]>([]);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [removeSilences, setRemoveSilences] = useState(true);
  const [silenceThreshold, setSilenceThreshold] = useState(0.6);

  useEffect(() => {
    if (!words) return;
    setFillerSegments(detectFillerWords(words, DEFAULT_FILLER_WORDS));
  }, [words]);

  useEffect(() => {
    if (!words || video.duration === 0) return;
    setSilenceSegments(detectSilences(words, video.duration, silenceThreshold));
  }, [words, video.duration, silenceThreshold]);

  const activeSegments = useMemo(
    () => [...(removeFillers ? fillerSegments : []), ...(removeSilences ? silenceSegments : [])],
    [removeFillers, fillerSegments, removeSilences, silenceSegments],
  );

  const keepIntervals = useMemo(
    () => (video.duration > 0 ? buildKeepIntervals(video.duration, activeSegments) : []),
    [video.duration, activeSegments],
  );

  const keptDuration = keepIntervals.reduce((sum, k) => sum + (k.end - k.start), 0);
  const removedDuration = Math.max(0, video.duration - keptDuration);

  const analyze = async () => {
    if (!video.file) return;
    setIsAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeProgress({ phase: "downloading", fraction: 0 });
    try {
      const result = await transcribeWords(video.file, {
        modelTier,
        language,
        onProgress: setAnalyzeProgress,
      });
      if (result.words.length === 0) {
        setAnalyzeError("No speech was detected in this video.");
      } else {
        setWords(result.words);
      }
    } catch (err) {
      console.error(err);
      setAnalyzeError("Couldn't analyze this video's speech. Try a different file.");
    } finally {
      setIsAnalyzing(false);
      setAnalyzeProgress(null);
    }
  };

  const toggleSegment = (list: "filler" | "silence", id: string) => {
    const setter = list === "filler" ? setFillerSegments : setSilenceSegments;
    setter((segs) => segs.map((s) => (s.id === id ? { ...s, included: !s.included } : s)));
  };

  const seekTo = (t: number) => {
    const el = video.videoRef.current;
    if (el) el.currentTime = t;
  };

  const handleExport = async () => {
    if (!video.file || video.videoWidth === 0 || video.isMetadataLoading || keepIntervals.length === 0) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    const { filterComplex, videoLabel, audioLabel } = buildTrimConcatFilter(keepIntervals);

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-filter_complex",
          filterComplex,
          "-map",
          `[${videoLabel}]`,
          "-map",
          `[${audioLabel}]`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `cleaned-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setWords(null);
    setFillerSegments([]);
    setSilenceSegments([]);
    setAnalyzeError(null);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Automatically finds filler words and dead air in your speech"
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
          {!words ? (
            <ToolPanelSection icon={Sparkles} label="Analyze speech">
              <p className="text-body-sm text-(--color-text-muted)">
                Transcribes the video's audio fully in your browser to find filler words ("um", "uh"…) and
                silent gaps — nothing is uploaded anywhere.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                  Quality
                  <select
                    value={modelTier}
                    onChange={(e) => setModelTier(e.target.value as CaptionModelTier)}
                    className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                  >
                    {(
                      Object.entries(CAPTION_MODELS) as [CaptionModelTier, (typeof CAPTION_MODELS)[CaptionModelTier]][]
                    ).map(([id, m]) => (
                      <option key={id} value={id}>
                        {m.label} ({m.sizeHint})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                  Spoken language
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                  >
                    {CAPTION_LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={isAnalyzing || video.isMetadataLoading}
                onClick={analyze}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles size={15} />
                {isAnalyzing ? "Analyzing…" : "Analyze speech"}
              </button>
              {analyzeProgress && (
                <ProgressBar
                  label={analyzeProgress.phase === "downloading" ? "Downloading speech model…" : "Transcribing…"}
                  fraction={analyzeProgress.fraction}
                />
              )}
              {analyzeError && <p className="mt-2 text-body-sm text-danger-600">{analyzeError}</p>}
            </ToolPanelSection>
          ) : (
            <>
              <div className="rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-4">
                <p className="text-body-sm">
                  New duration: <span className="font-semibold tabular-nums">{formatTime(keptDuration, true)}</span>{" "}
                  <span className="text-(--color-text-muted)">
                    (was {formatTime(video.duration, true)}, removing {formatTime(removedDuration, true)})
                  </span>
                </p>
              </div>

              <ToolPanelSection icon={Wand2} label={`Filler words (${fillerSegments.length} found)`}>
                <label className="flex items-center gap-2 text-body-sm font-medium">
                  <input
                    type="checkbox"
                    checked={removeFillers}
                    onChange={(e) => setRemoveFillers(e.target.checked)}
                    className="accent-(--color-primary-500)"
                  />
                  Remove filler words
                </label>
                {fillerSegments.length > 0 && (
                  <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {fillerSegments.map((s) => (
                      <SegmentRow
                        key={s.id}
                        segment={s}
                        onToggle={() => toggleSegment("filler", s.id)}
                        onSeek={() => seekTo(s.start)}
                      />
                    ))}
                  </div>
                )}
              </ToolPanelSection>

              <ToolPanelSection icon={Wand2} label={`Silences (${silenceSegments.length} found)`}>
                <label className="flex items-center gap-2 text-body-sm font-medium">
                  <input
                    type="checkbox"
                    checked={removeSilences}
                    onChange={(e) => setRemoveSilences(e.target.checked)}
                    className="accent-(--color-primary-500)"
                  />
                  Remove silences
                </label>
                <label className="mt-2 flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Longer than
                  <input
                    type="range"
                    min={SILENCE_MIN}
                    max={SILENCE_MAX}
                    step={0.1}
                    value={silenceThreshold}
                    onChange={(e) => setSilenceThreshold(Number(e.target.value))}
                    className="w-32 accent-(--color-primary-500)"
                  />
                  <span className="w-12 tabular-nums">{silenceThreshold.toFixed(1)}s</span>
                </label>
                {silenceSegments.length > 0 && (
                  <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {silenceSegments.map((s) => (
                      <SegmentRow
                        key={s.id}
                        segment={s}
                        onToggle={() => toggleSegment("silence", s.id)}
                        onSeek={() => seekTo(s.start)}
                      />
                    ))}
                  </div>
                )}
              </ToolPanelSection>
            </>
          )}

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Cleaning up…"
          />

          {words && (
            <button
              type="button"
              disabled={
                exportState.isProcessing ||
                video.isMetadataLoading ||
                !!video.metadataError ||
                keepIntervals.length === 0 ||
                activeSegments.filter((s) => s.included).length === 0
              }
              onClick={handleExport}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Wand2 size={16} />
              {exportState.isProcessing ? "Cleaning…" : "Remove selected"}
            </button>
          )}
        </>
      }
      preview={
        video.sourceUrl && (
          <FramedVideoStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            naturalWidth={video.videoWidth}
            naturalHeight={video.videoHeight}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
            controls
          />
        )
      }
    />
  );
}
