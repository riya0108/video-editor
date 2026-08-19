import { useRef, useState } from "react";
import {
  UploadCloud,
  Link2,
  FileText,
  Copy,
  Download,
  Check,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ProgressBar from "../ProgressBar";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import {
  transcribeWords,
  CAPTION_MODELS,
  type CaptionModelTier,
  type CaptionProgress,
} from "../../../lib/captions/auto-caption";
import { CAPTION_LANGUAGES } from "../../../lib/captions/languages";
import { fetchRemoteAudio } from "../../../lib/captions/fetch-remote-audio";
import { formatTime } from "../../../lib/time";

type Mode = "upload" | "link";
type MediaKind = "video" | "audio";

interface Source {
  blob: Blob;
  sourceUrl: string;
  name: string;
  kind: MediaKind;
}

interface Transcript {
  text: string;
  wordCount: number;
  duration: number;
}

function mediaKindFromType(type: string): MediaKind {
  return type.startsWith("video") ? "video" : "audio";
}

export default function TranscribeTool() {
  const [mode, setMode] = useState<Mode>("upload");
  const [linkValue, setLinkValue] = useState("");
  const [isFetchingLink, setIsFetchingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [source, setSource] = useState<Source | null>(null);

  const [modelTier, setModelTier] = useState<CaptionModelTier>("fast");
  const [language, setLanguage] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef(0);

  const setNewSource = (blob: Blob, name: string, kind: MediaKind) => {
    if (source) URL.revokeObjectURL(source.sourceUrl);
    setTranscript(null);
    setTranscribeError(null);
    setSource({ blob, sourceUrl: URL.createObjectURL(blob), name, kind });
  };

  const handleFiles = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setNewSource(file, file.name, mediaKindFromType(file.type));
  };

  const handleFetchLink = async () => {
    const url = linkValue.trim();
    if (!url) return;
    setIsFetchingLink(true);
    setLinkError(null);
    try {
      const blob = await fetchRemoteAudio(url);
      setNewSource(blob, url, mediaKindFromType(blob.type));
    } catch (err) {
      setLinkError(
        err instanceof Error ? err.message : "Couldn't fetch that link.",
      );
    } finally {
      setIsFetchingLink(false);
    }
  };

  const transcribe = async () => {
    if (!source) return;
    const runId = ++abortRef.current;
    setIsTranscribing(true);
    setTranscribeError(null);
    setProgress({ phase: "downloading", fraction: 0 });
    try {
      const result = await transcribeWords(source.blob, {
        modelTier,
        language,
        onProgress: (p) => {
          if (abortRef.current === runId) setProgress(p);
        },
      });
      if (abortRef.current !== runId) return;
      if (result.words.length === 0) {
        setTranscribeError("No speech was detected in this file.");
      } else {
        const text = result.words
          .map((w) => w.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        setTranscript({
          text,
          wordCount: result.words.length,
          duration: result.audioDuration,
        });
      }
    } catch (err) {
      if (abortRef.current !== runId) return;
      console.error(err);
      setTranscribeError(
        "Couldn't transcribe this file. Try a different source or quality setting.",
      );
    } finally {
      if (abortRef.current === runId) {
        setIsTranscribing(false);
        setProgress(null);
      }
    }
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const downloadTranscript = () => {
    if (!transcript) return;
    const blob = new Blob([transcript.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    abortRef.current++;
    if (source) URL.revokeObjectURL(source.sourceUrl);
    setSource(null);
    setLinkValue("");
    setLinkError(null);
    setTranscript(null);
    setTranscribeError(null);
    setIsTranscribing(false);
    setProgress(null);
  };

  const ModeTab = ({
    id,
    icon: Icon,
    label,
  }: {
    id: Mode;
    icon: typeof UploadCloud;
    label: string;
  }) => (
    <button
      type="button"
      onClick={() => setMode(id)}
      className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-body-sm font-semibold transition-colors ${
        mode === id
          ? "bg-primary-500 text-white"
          : "text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );

  if (!source) {
    return (
      <ToolUploadScreen
        icon={FileText}
        title="Video Transcript"
        description="Get a text transcript from an uploaded file or a YouTube, Instagram, or TikTok link."
      >
        <div className="mx-auto max-w-xl space-y-4">
          <div className="flex rounded-lg border border-(--color-border) bg-(--color-surface) p-1">
            <ModeTab id="upload" icon={UploadCloud} label="Upload a file" />
            <ModeTab id="link" icon={Link2} label="Paste a link" />
          </div>

          {mode === "upload" ? (
            <Dropzone
              accept="video/*,audio/*"
              label="Drop a video or audio file here, or click to browse"
              hint="Transcribed fully in your browser — nothing is uploaded"
              onFiles={handleFiles}
            />
          ) : (
            <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-6">
              <label
                className="block text-body-sm font-semibold"
                htmlFor="transcript-link-input"
              >
                YouTube, Instagram, TikTok, or any other video link
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="transcript-link-input"
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  value={linkValue}
                  onChange={(e) => setLinkValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleFetchLink();
                  }}
                  disabled={isFetchingLink}
                  className="min-w-0 flex-1 rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-body-sm"
                />
                <button
                  type="button"
                  onClick={handleFetchLink}
                  disabled={isFetchingLink || !linkValue.trim()}
                  className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Link2 size={15} />
                  {isFetchingLink ? "Fetching…" : "Fetch"}
                </button>
              </div>
              <p className="mt-2 text-caption text-(--color-text-muted)">
                The link is resolved server-side to its audio track, which is
                then transcribed locally in your browser and immediately
                discarded from the server.
              </p>
              {linkError && (
                <p className="mt-2 text-body-sm text-danger-600">{linkError}</p>
              )}
            </div>
          )}
        </div>
      </ToolUploadScreen>
    );
  }

  return (
    <ToolSplitLayout
      controls={
        <>
          <ToolPanelSection icon={Sparkles} label="Transcribe">
            <p
              className="truncate text-body-sm text-(--color-text-muted)"
              title={source.name}
            >
              Source:{" "}
              <span className="font-medium text-(--color-text)">
                {source.name}
              </span>
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                Quality
                <select
                  value={modelTier}
                  onChange={(e) =>
                    setModelTier(e.target.value as CaptionModelTier)
                  }
                  className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                >
                  {(
                    Object.entries(CAPTION_MODELS) as [
                      CaptionModelTier,
                      (typeof CAPTION_MODELS)[CaptionModelTier],
                    ][]
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
              disabled={isTranscribing}
              onClick={transcribe}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText size={15} />
              {isTranscribing
                ? "Transcribing…"
                : transcript
                  ? "Re-transcribe"
                  : "Transcribe"}
            </button>
            {progress && (
              <ProgressBar
                label={
                  progress.phase === "downloading"
                    ? "Downloading speech model…"
                    : "Transcribing…"
                }
                fraction={progress.fraction}
              />
            )}
            {transcribeError && (
              <p className="mt-2 text-body-sm text-danger-600">
                {transcribeError}
              </p>
            )}
          </ToolPanelSection>

          <button
            type="button"
            onClick={reset}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
          >
            <RotateCcw size={14} />
            Start over
          </button>
        </>
      }
      preview={
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg bg-black">
            {source.kind === "video" ? (
              <video
                src={source.sourceUrl}
                controls
                className="max-h-80 w-full"
              />
            ) : (
              <audio src={source.sourceUrl} controls className="w-full p-4" />
            )}
          </div>

          {transcript ? (
            <div className="rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-caption text-(--color-text-muted)">
                  {transcript.wordCount} words ·{" "}
                  {formatTime(transcript.duration, true)}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={copyTranscript}
                    className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-surface)"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={downloadTranscript}
                    className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-surface)"
                  >
                    <Download size={13} />
                    Download .txt
                  </button>
                </div>
              </div>
              <p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-body-sm leading-relaxed">
                {transcript.text}
              </p>
            </div>
          ) : (
            <p className="text-body-sm text-(--color-text-muted)">
              Run "Transcribe" to generate the text transcript for this{" "}
              {source.kind}.
            </p>
          )}
        </div>
      }
    />
  );
}
