import { nextCaptionId, type CaptionCue } from "./types";

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

/** Breaks text into <= maxChars pieces, preferring sentence/word boundaries. */
function splitIntoReadableSegments(text: string, maxChars: number): { text: string; offset: number }[] {
  const segments: { text: string; offset: number }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let sliceEnd = Math.min(cursor + maxChars, text.length);
    if (sliceEnd < text.length) {
      const window = text.slice(cursor, sliceEnd + 1);
      const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      if (sentenceBreak > maxChars * 0.4) {
        sliceEnd = cursor + sentenceBreak + 1;
      } else {
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace > maxChars * 0.4) sliceEnd = cursor + lastSpace;
      }
    }
    const piece = text.slice(cursor, sliceEnd).trim();
    if (piece) segments.push({ text: piece, offset: cursor });
    cursor = sliceEnd;
    while (text[cursor] === " ") cursor += 1;
  }
  return segments;
}

function chunksToCues(chunks: RawChunk[], audioDuration: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (!text) continue;
    const start = chunk.timestamp[0] ?? 0;
    const end = chunk.timestamp[1] ?? Math.min(audioDuration, start + 4);
    const duration = Math.max(0.1, end - start);

    if (text.length <= MAX_CUE_CHARS && duration <= MAX_CUE_SECONDS) {
      cues.push({ id: nextCaptionId(), start, end, text });
      continue;
    }

    for (const piece of splitIntoReadableSegments(text, MAX_CUE_CHARS)) {
      const segStart = start + duration * (piece.offset / text.length);
      const segEnd = start + duration * ((piece.offset + piece.text.length) / text.length);
      cues.push({
        id: nextCaptionId(),
        start: segStart,
        end: Math.max(segStart + 0.3, segEnd),
        text: piece.text,
      });
    }
  }
  return cues;
}

/**
 * Transcribes a video's audio track fully client-side (via an in-browser
 * Whisper model) and returns timed caption cues. Works on any language the
 * video happens to be in — pass `language` only as an optional accuracy hint.
 */
export async function generateCaptions(
  videoFile: File,
  { modelTier, language, onProgress }: GenerateCaptionsOptions,
): Promise<CaptionCue[]> {
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
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language || undefined,
  });

  const audioDuration = audio.length / 16000;
  return chunksToCues(output.chunks ?? [], audioDuration);
}
