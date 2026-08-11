import { nextCaptionId, type CaptionCue, type CaptionWord } from "./types";

export type CaptionModelTier = "fast" | "balanced";

export const CAPTION_MODELS: Record<CaptionModelTier, { modelId: string; label: string; sizeHint: string }> = {
  fast: { modelId: "onnx-community/whisper-tiny", label: "Fast", sizeHint: "~95MB download" },
  balanced: { modelId: "onnx-community/whisper-base", label: "Balanced", sizeHint: "~140MB download" },
};

export interface CaptionProgress {
  phase: "downloading" | "transcribing";
  /** 0–1 */
  fraction: number;
}

export interface GenerateCaptionsOptions {
  modelTier: CaptionModelTier;
  /** A Whisper language name (e.g. "english", "hindi"); omitted/empty auto-detects. */
  language?: string;
  onProgress?: (progress: CaptionProgress) => void;
}

interface RawChunk {
  text: string;
  timestamp: [number, number | null];
}

// Caption-line guidance (broadcast norms land around 32–42 chars/line for
// two lines, and a few seconds of read time) applied when Whisper hands back
// a long chunk that needs splitting into shorter, readable cues.
const MAX_CUE_CHARS = 84;
const MAX_CUE_SECONDS = 6;

let cachedTranscriber: { tier: CaptionModelTier; promise: Promise<unknown> } | null = null;

async function loadTranscriber(tier: CaptionModelTier, onProgress?: GenerateCaptionsOptions["onProgress"]) {
  if (cachedTranscriber?.tier === tier) return cachedTranscriber.promise;

  const { pipeline } = await import("@huggingface/transformers");
  const promise = pipeline("automatic-speech-recognition", CAPTION_MODELS[tier].modelId, {
    // q8/int8 hit a broken MatMulNBits/DequantizeLinear scale, and fp16 hits
    // a LayerNorm-fusion bug, in the onnxruntime-web version this package
    // pins for these particular ONNX exports — q4 (block-quantized) and fp32
    // are the two dtypes that actually load; q4 for a much smaller download.
    dtype: "q4",
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === "progress_total" && typeof info.progress === "number") {
        onProgress?.({ phase: "downloading", fraction: info.progress / 100 });
      }
    },
  });
  promise.catch(() => {
    if (cachedTranscriber?.promise === promise) cachedTranscriber = null;
  });
  cachedTranscriber = { tier, promise };
  return promise;
}

/**
 * Groups word-level chunks into readable cues (broadcast norms land around
 * 32-42 chars/line for two lines, and a few seconds of read time), keeping
 * each word's own timestamp on the cue so the caption editor can offer
 * word-by-word karaoke highlighting.
 */
function wordsToCues(words: CaptionWord[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let current: CaptionWord[] = [];
  let charCount = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      cues.push({
        id: nextCaptionId(),
        start: current[0].start,
        end: current[current.length - 1].end,
        text,
        words: current,
      });
    }
    current = [];
    charCount = 0;
  };

  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const endsSentence = /[.!?]$/.test(text);

    const wouldOverflowChars = charCount + text.length + 1 > MAX_CUE_CHARS;
    const wouldOverflowSeconds = current.length > 0 && word.end - current[0].start > MAX_CUE_SECONDS;
    if (current.length > 0 && (wouldOverflowChars || wouldOverflowSeconds)) flush();

    current.push({ text, start: word.start, end: Math.max(word.start, word.end) });
    charCount += text.length + 1;

    if (endsSentence) flush();
  }
  flush();

  return cues;
}

export interface TranscribeWordsResult {
  words: CaptionWord[];
  audioDuration: number;
}

/**
 * Transcribes a video's audio track fully client-side (via an in-browser
 * Whisper model) and returns flat, word-level timestamps. Shared foundation
 * for both auto-captions (grouped into readable cues) and the filler-word /
 * silence detector, which needs the raw per-word timing to find gaps.
 */
export async function transcribeWords(
  videoFile: File,
  { modelTier, language, onProgress }: GenerateCaptionsOptions,
): Promise<TranscribeWordsResult> {
  const { read_audio } = await import("@huggingface/transformers");
  const objectUrl = URL.createObjectURL(videoFile);
  let audio: Float32Array;
  try {
    audio = await read_audio(objectUrl, 16000);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const transcriber = (await loadTranscriber(modelTier, onProgress)) as (
    audio: Float32Array,
    options: Record<string, unknown>,
  ) => Promise<{ chunks?: RawChunk[] }>;

  onProgress?.({ phase: "transcribing", fraction: 0 });
  const output = await transcriber(audio, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language || undefined,
  });

  const audioDuration = audio.length / 16000;
  const words: CaptionWord[] = [];
  for (const chunk of output.chunks ?? []) {
    const text = chunk.text.trim();
    if (!text) continue;
    const start = chunk.timestamp[0] ?? (words.at(-1)?.end ?? 0);
    const end = chunk.timestamp[1] ?? Math.min(audioDuration, start + 0.5);
    words.push({ text, start, end: Math.max(start, end) });
  }

  return { words, audioDuration };
}

/**
 * Transcribes a video's audio track fully client-side (via an in-browser
 * Whisper model) and returns timed caption cues. Works on any language the
 * video happens to be in — pass `language` only as an optional accuracy hint.
 */
export async function generateCaptions(
  videoFile: File,
  options: GenerateCaptionsOptions,
): Promise<CaptionCue[]> {
  const { words } = await transcribeWords(videoFile, options);
  return wordsToCues(words);
}
