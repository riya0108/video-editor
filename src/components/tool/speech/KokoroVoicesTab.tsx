import { useState } from "react";
import { Play, Sparkles } from "lucide-react";
import ResultPanel from "../ResultPanel";
import ProgressBar from "../ProgressBar";

const SAMPLE_TEXT =
  "Welcome to Clipbench. Type or paste any text here, pick a voice, and it will be read aloud.";

// Curated subset of Kokoro's 26 voices — full id, display name, and a short
// description pulled from the model's own voice metadata.
const VOICE_OPTIONS: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart (US female)" },
  { id: "af_bella", label: "Bella (US female)" },
  { id: "af_nicole", label: "Nicole (US female)" },
  { id: "af_sarah", label: "Sarah (US female)" },
  { id: "af_sky", label: "Sky (US female)" },
  { id: "am_adam", label: "Adam (US male)" },
  { id: "am_michael", label: "Michael (US male)" },
  { id: "am_fenrir", label: "Fenrir (US male)" },
  { id: "am_puck", label: "Puck (US male)" },
  { id: "bf_emma", label: "Emma (UK female)" },
  { id: "bf_lily", label: "Lily (UK female)" },
  { id: "bm_george", label: "George (UK male)" },
  { id: "bm_fable", label: "Fable (UK male)" },
];

type Kokoro = InstanceType<typeof import("kokoro-js").KokoroTTS>;

let cachedModel: Promise<Kokoro> | null = null;
function loadModel(onProgress: (fraction: number) => void): Promise<Kokoro> {
  if (cachedModel) return cachedModel;
  cachedModel = (async () => {
    const { KokoroTTS } = await import("kokoro-js");
    return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      progress_callback: (info: { status: string; progress?: number }) => {
        if (info.status === "progress" && typeof info.progress === "number") {
          onProgress(info.progress / 100);
        }
      },
    });
  })();
  cachedModel.catch(() => {
    cachedModel = null;
  });
  return cachedModel;
}

export default function KokoroVoicesTab() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [voice, setVoice] = useState(VOICE_OPTIONS[0].id);
  const [speed, setSpeed] = useState(1);
  const [isBusy, setIsBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(null);

  const generate = async () => {
    if (!text.trim() || isBusy) return;
    setIsBusy(true);
    setError(null);
    setProgress({ label: "Downloading voice model…", fraction: 0 });
    try {
      const model = await loadModel((fraction) => setProgress({ label: "Downloading voice model…", fraction }));
      setProgress({ label: "Generating speech…", fraction: 1 });
      // `voice` is one of VOICE_OPTIONS' ids, a subset of kokoro-js's own voice key union.
      const audio = await model.generate(text, { voice, speed } as Parameters<Kokoro["generate"]>[1]);
      const blob = audio.toBlob();
      if (result) URL.revokeObjectURL(result.url);
      setResult({ url: URL.createObjectURL(blob), blob });
    } catch (err) {
      console.error(err);
      setError("Couldn't generate speech. The voice model may have failed to download — try again.");
    } finally {
      setIsBusy(false);
      setProgress(null);
    }
  };

  const reset = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setError(null);
  };

  if (result) {
    return (
      <ResultPanel url={result.url} blob={result.blob} filename="ai-voice-narration.wav" kind="audio" onReset={reset} />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      <p className="mb-4 flex items-start gap-2 text-caption text-(--color-text-muted)">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-primary-500" />
        <span>
          These voices come from an AI model (Kokoro, 82M params) that runs fully in your browser — the same
          quality on every device, unlike the system voices above. First use downloads it once (~85MB) and
          caches it for next time.
        </span>
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Type or paste text to read aloud…"
        className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
      />

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Voice
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
          >
            {VOICE_OPTIONS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Speed: {speed.toFixed(1)}x
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="mt-1.5 accent-(--color-primary-500)"
          />
        </label>
      </div>

      {progress && <div className="mt-4">
        <ProgressBar label={progress.label} fraction={progress.fraction} />
      </div>}
      {error && <p className="mt-3 text-body-sm text-danger-600">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={!text.trim() || isBusy}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isBusy ? (
            "Generating…"
          ) : (
            <>
              <Play size={16} />
              Generate speech
            </>
          )}
        </button>
      </div>
    </div>
  );
}
