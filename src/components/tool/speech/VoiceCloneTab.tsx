import { useEffect, useState } from "react";
import { Wand2, TriangleAlert, UploadCloud } from "lucide-react";
import Dropzone from "../Dropzone";
import ResultPanel from "../ResultPanel";
import ProgressBar from "../ProgressBar";
import { transcribeWords } from "../../../lib/captions/auto-caption";
import { formatTime } from "../../../lib/time";

const MIN_REF_SECONDS = 15;
const NFE_PRESETS = { fast: 8, balanced: 16, high: 32 } as const;
type Quality = keyof typeof NFE_PRESETS;

function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    el.preload = "metadata";
    el.src = url;
    el.onloadedmetadata = () => {
      resolve(el.duration || 0);
      URL.revokeObjectURL(url);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that audio file"));
    };
  });
}

export default function VoiceCloneTab() {
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refDuration, setRefDuration] = useState(0);
  const [refText, setRefText] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  const [genText, setGenText] = useState("");
  const [quality, setQuality] = useState<Quality>("balanced");
  const [isBusy, setIsBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; fraction: number } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefFile = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setTranscribeError(null);
    setRefText("");
    setRefFile(file);

    let duration = 0;
    try {
      duration = await readAudioDuration(file);
    } catch {
      setTranscribeError("Couldn't read that file. Try a different audio file.");
      setRefFile(null);
      return;
    }
    setRefDuration(duration);
    if (duration < MIN_REF_SECONDS) {
      return; // too short — surfaced in the UI, transcription skipped
    }

    setTranscribing(true);
    try {
      const { words } = await transcribeWords(file, { modelTier: "fast" });
      setRefText(words.map((w) => w.text).join(" ").trim());
    } catch {
      setTranscribeError("Couldn't auto-transcribe this clip. You can type what it says manually below.");
    } finally {
      setTranscribing(false);
    }
  };

  const generate = async () => {
    if (!refFile || !refText.trim() || !genText.trim() || isBusy || refDuration < MIN_REF_SECONDS) return;
    setIsBusy(true);
    setGenError(null);
    setProgress({ label: "Downloading voice-cloning model (large, one-time)…", fraction: 0 });
    try {
      const [{ F5TTS }, { read_audio, RawAudio }] = await Promise.all([
        import("../../../lib/tts/f5-tts"),
        import("@huggingface/transformers"),
      ]);

      const tts = new F5TTS();
      await tts.initialize((p) => {
        if (p.phase === "downloading") setProgress({ label: p.message, fraction: p.fraction });
      });

      const objectUrl = URL.createObjectURL(refFile);
      let refAudio: Float32Array;
      try {
        refAudio = await read_audio(objectUrl, 24000);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      setProgress({ label: "Generating speech…", fraction: 0 });
      const audioData = await tts.inference({
        refAudio,
        refText: refText.trim(),
        genText: genText.trim(),
        nfeSteps: NFE_PRESETS[quality],
        onProgress: (p) => {
          if (p.phase === "generating") setProgress({ label: p.message, fraction: p.fraction });
        },
      });

      const blob = new RawAudio(audioData, 24000).toBlob();
      if (result) URL.revokeObjectURL(result.url);
      setResult({ url: URL.createObjectURL(blob), blob });
      tts.dispose();
    } catch {
      setGenError("Voice cloning failed — this feature is experimental and can be unreliable on some devices. Try again, or use a shorter/clearer reference clip.");
    } finally {
      setIsBusy(false);
      setProgress(null);
    }
  };

  const reset = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setGenError(null);
  };

  if (result) {
    return (
      <ResultPanel url={result.url} blob={result.blob} filename="cloned-voice.wav" kind="audio" onReset={reset} />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      <p className="mb-4 flex items-start gap-2 text-caption text-(--color-text-muted)">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
        <span>
          <strong>Experimental.</strong> Clones a voice from a short recording using an open-source AI model
          that runs fully in your browser. First use downloads a large model (roughly 750MB–1.4GB depending on
          your device) and caches it for next time — expect it to take a while, and results can be uneven.
        </span>
      </p>

      {!refFile ? (
        <Dropzone
          accept="audio/*"
          label="Drop a voice sample here, or click to browse"
          hint={`At least ${MIN_REF_SECONDS} seconds of clear, single-speaker speech works best`}
          onFiles={handleRefFile}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-(--color-border) px-3 py-2.5">
            <UploadCloud size={18} className="shrink-0 text-primary-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-sm font-medium">{refFile.name}</p>
              <p className="text-caption text-(--color-text-muted)">
                {refDuration > 0 ? formatTime(refDuration) : "Reading…"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setRefFile(null);
                setRefText("");
                setTranscribeError(null);
              }}
              className="shrink-0 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
            >
              Change
            </button>
          </div>

          {refDuration > 0 && refDuration < MIN_REF_SECONDS ? (
            <p className="text-body-sm text-danger-600">
              That clip is only {formatTime(refDuration)} — use one at least {MIN_REF_SECONDS} seconds long for
              a proper clone.
            </p>
          ) : (
            <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
              What the clip says
              <textarea
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                rows={2}
                placeholder={transcribing ? "Transcribing…" : "Type exactly what's said in the clip…"}
                disabled={transcribing}
                className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200 disabled:opacity-60"
              />
            </label>
          )}
          {transcribeError && <p className="text-body-sm text-danger-600">{transcribeError}</p>}
        </div>
      )}

      <label className="mt-4 flex flex-col gap-1 text-caption text-(--color-text-muted)">
        Text to speak in the cloned voice
        <textarea
          value={genText}
          onChange={(e) => setGenText(e.target.value)}
          rows={4}
          placeholder="Type what you want the cloned voice to say…"
          className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
        />
      </label>

      <label className="mt-4 flex flex-col gap-1 text-caption text-(--color-text-muted)">
        Quality
        <select
          value={quality}
          onChange={(e) => setQuality(e.target.value as Quality)}
          className="w-40 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
        >
          <option value="fast">Fast (rougher)</option>
          <option value="balanced">Balanced</option>
          <option value="high">High (slower)</option>
        </select>
      </label>

      {progress && (
        <div className="mt-4">
          <ProgressBar label={progress.label} fraction={progress.fraction} />
        </div>
      )}
      {genError && <p className="mt-3 text-body-sm text-danger-600">{genError}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={
            isBusy || !refFile || !refText.trim() || !genText.trim() || refDuration < MIN_REF_SECONDS || transcribing
          }
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wand2 size={16} />
          {isBusy ? "Cloning voice…" : "Generate in cloned voice"}
        </button>
      </div>
    </div>
  );
}
