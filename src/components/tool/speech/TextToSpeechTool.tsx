import { useEffect, useRef, useState } from "react";
import { Play, Square, Mic2, Info } from "lucide-react";
import ResultPanel from "../ResultPanel";
import RecorderControls from "../media/RecorderControls";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { stopAllTracks } from "../../../lib/media/mix-audio";
import {
  AUDIO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";

const SAMPLE_TEXT =
  "Welcome to Clipbench. Type or paste any text here, pick a voice, and it will be read aloud.";

type AccentGroup = {
  id: string;
  label: string;
  match: (lang: string) => boolean;
};

// Other major Indian language locales (Bengali, Tamil, Telugu, Kannada, Malayalam,
// Marathi, Gujarati, Punjabi, Urdu, Odia, Assamese) that OS voice packs ship separately from Hindi.
const OTHER_INDIAN_LANG_PREFIXES = ["bn", "ta", "te", "kn", "ml", "mr", "gu", "pa", "ur", "or", "as"];

// Ordered so Hindi and Indian-English voices surface first when present.
const ACCENT_GROUPS: AccentGroup[] = [
  { id: "hi", label: "Hindi", match: (lang) => lang.startsWith("hi") },
  { id: "en-in", label: "English (India)", match: (lang) => lang === "en-in" },
  {
    id: "in-other",
    label: "Indian Languages (Other)",
    match: (lang) => OTHER_INDIAN_LANG_PREFIXES.some((p) => lang.startsWith(`${p}-in`) || lang === p),
  },
  { id: "en-us", label: "English (US)", match: (lang) => lang === "en-us" },
  { id: "en-gb", label: "English (UK)", match: (lang) => lang === "en-gb" },
  {
    id: "en-other",
    label: "English (Other)",
    match: (lang) => lang.startsWith("en") && !["en-in", "en-us", "en-gb"].includes(lang),
  },
];

function groupIdForLang(lang: string): string {
  const normalized = lang.toLowerCase();
  const found = ACCENT_GROUPS.find((g) => g.match(normalized));
  return found ? found.id : "other";
}

export default function TextToSpeechTool() {
  const recorder = useMediaRecorder();
  const [isSupported, setIsSupported] = useState(true);
  const [text, setText] = useState(SAMPLE_TEXT);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [accentFilter, setAccentFilter] = useState("all");
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setIsSupported(false);
      return;
    }
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      setVoices(list);
      if (list.length > 0 && !voiceURI) setVoiceURI(list[0].voiceURI);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const availableGroupIds = new Set(voices.map((v) => groupIdForLang(v.lang)));
  const accentOptions = [
    { id: "all", label: "All voices" },
    ...ACCENT_GROUPS.filter((g) => availableGroupIds.has(g.id)),
    ...(availableGroupIds.has("other") ? [{ id: "other", label: "Other languages" }] : []),
  ];
  const filteredVoices =
    accentFilter === "all" ? voices : voices.filter((v) => groupIdForLang(v.lang) === accentFilter);
  const hasIndianVoice = availableGroupIds.has("hi") || availableGroupIds.has("en-in");

  const buildUtterance = () => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voices.find((v) => v.voiceURI === voiceURI) ?? null;
    utterance.rate = rate;
    utterance.pitch = pitch;
    return utterance;
  };

  const play = () => {
    if (!text.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = buildUtterance();
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const stopPreview = () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  const recordNarration = async () => {
    if (!text.trim()) return;
    setRecordError(null);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        stopAllTracks(displayStream);
        setRecordError(
          'No audio was shared. Try again and, in the picker, choose "This Tab" and turn on "Share tab audio".',
        );
        return;
      }
      displayStream.getVideoTracks().forEach((t) => t.stop());
      captureStreamRef.current = displayStream;
      const audioOnlyStream = new MediaStream(audioTracks);

      const mimeType = pickSupportedMimeType(AUDIO_RECORDER_MIME_CANDIDATES);
      recorder.start(audioOnlyStream, mimeType);

      const utterance = buildUtterance();
      utterance.onend = () => {
        recorder.stop();
        stopAllTracks(captureStreamRef.current);
        captureStreamRef.current = null;
      };
      utterance.onerror = () => {
        recorder.stop();
        stopAllTracks(captureStreamRef.current);
        captureStreamRef.current = null;
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      setRecordError("Recording needs your permission to capture this tab's audio.");
    }
  };

  const cancelRecording = () => {
    window.speechSynthesis.cancel();
    recorder.stop();
    stopAllTracks(captureStreamRef.current);
    captureStreamRef.current = null;
  };

  const reset = () => {
    recorder.reset();
    setRecordError(null);
  };

  const handleAccentFilterChange = (nextFilter: string) => {
    setAccentFilter(nextFilter);
    const nextVoices =
      nextFilter === "all" ? voices : voices.filter((v) => groupIdForLang(v.lang) === nextFilter);
    if (nextVoices.length > 0 && !nextVoices.some((v) => v.voiceURI === voiceURI)) {
      setVoiceURI(nextVoices[0].voiceURI);
    }
  };

  const voicesByGroup =
    accentFilter === "all"
      ? [...ACCENT_GROUPS, { id: "other", label: "Other languages", match: () => true }]
          .map((g) => ({ group: g, list: voices.filter((v) => groupIdForLang(v.lang) === g.id) }))
          .filter((g) => g.list.length > 0)
      : [{ group: { id: accentFilter, label: "" }, list: filteredVoices }];

  if (!isSupported) {
    return (
      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-8 text-center shadow-sm">
        <p className="font-semibold">Text to speech isn&rsquo;t supported in this browser.</p>
        <p className="mt-1 text-body-sm text-(--color-text-muted)">Try the latest Chrome, Edge, or Safari.</p>
      </div>
    );
  }

  if (recorder.result) {
    const ext = extensionForMimeType(recorder.result.blob.type);
    return (
      <ResultPanel
        url={recorder.result.url}
        blob={recorder.result.blob}
        filename={`narration.${ext}`}
        kind="audio"
        onReset={reset}
      />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Type or paste text to read aloud…"
        className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
      />

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Accent / language
          <select
            value={accentFilter}
            onChange={(e) => handleAccentFilterChange(e.target.value)}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
          >
            {accentOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Voice
          <select
            value={voiceURI}
            onChange={(e) => setVoiceURI(e.target.value)}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
          >
            {voicesByGroup.map(({ group, list }) =>
              accentFilter === "all" ? (
                <optgroup key={group.id} label={group.label}>
                  {list.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </optgroup>
              ) : (
                list.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))
              ),
            )}
          </select>
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Rate: {rate.toFixed(1)}x
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="accent-(--color-primary-500)"
          />
        </label>
        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
          Pitch: {pitch.toFixed(1)}
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={pitch}
            onChange={(e) => setPitch(Number(e.target.value))}
            className="accent-(--color-primary-500)"
          />
        </label>
      </div>

      {!hasIndianVoice && (
        <p className="mt-3 flex items-start gap-2 text-caption text-(--color-text-muted)">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            No Hindi or Indian-English voice was found on this device yet. On Windows, add one under{" "}
            <strong>Settings → Time & Language → Speech → Manage voices</strong>. On macOS, add one under{" "}
            <strong>System Settings → Accessibility → Spoken Content → System voice</strong>. Chrome also adds
            online Google voices (including Hindi) automatically when you&rsquo;re connected to the internet.
          </span>
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        {!isSpeaking ? (
          <button
            type="button"
            onClick={play}
            disabled={!text.trim()}
            className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-5 py-2.5 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play size={16} />
            Play preview
          </button>
        ) : (
          <button
            type="button"
            onClick={stopPreview}
            className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-5 py-2.5 text-body-sm font-semibold hover:bg-(--color-bg-subtle)"
          >
            <Square size={14} />
            Stop
          </button>
        )}
      </div>

      <div className="mt-6 border-t border-(--color-border) pt-5">
        <p className="flex items-start gap-2 text-caption text-(--color-text-muted)">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            To export as an audio file, your browser will ask which screen or tab to share. Choose{" "}
            <strong>This Tab</strong> and make sure <strong>Share tab audio</strong> is turned on.
          </span>
        </p>

        {recordError && <p className="mt-3 text-body-sm text-danger-600">{recordError}</p>}

        <div className="mt-4">
          <RecorderControls
            state={recorder.state}
            elapsedMs={recorder.elapsedMs}
            onStart={recordNarration}
            onPause={recorder.pause}
            onResume={recorder.resume}
            onStop={cancelRecording}
            startLabel="Record narration as a file"
            disabled={!text.trim()}
          />
        </div>
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-caption text-(--color-text-faint)">
        <Mic2 size={12} />
        Voices are provided by your operating system, so the list varies by device.
      </p>
    </div>
  );
}
