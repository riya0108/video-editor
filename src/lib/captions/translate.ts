import { nextCaptionId, type CaptionCue } from "./types";

// Meta's NLLB-200, distilled to 600M params — a single model that translates
// between any of ~200 languages, run fully client-side via transformers.js
// (same library/approach as the Whisper auto-caption model). Nothing is
// uploaded; the (quantized, a few hundred MB) download is cached by the
// browser after first use.
export const TRANSLATE_MODEL_ID = "Xenova/nllb-200-distilled-600M";

export interface TranslateProgress {
  phase: "downloading" | "translating";
  /** 0-1 */
  fraction: number;
}

let cachedTranslator: Promise<unknown> | null = null;

async function loadTranslator(onProgress?: (p: TranslateProgress) => void) {
  if (cachedTranslator) return cachedTranslator;

  const { pipeline } = await import("@huggingface/transformers");
  const promise = pipeline("translation", TRANSLATE_MODEL_ID, {
    // Same onnxruntime-web quirk noted in auto-caption.ts: q8 hits a broken
    // MatMulNBits/DequantizeLinear scale for this ONNX export, q4 loads fine.
    dtype: "q4",
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === "progress_total" && typeof info.progress === "number") {
        onProgress?.({ phase: "downloading", fraction: info.progress / 100 });
      }
    },
  });
  promise.catch(() => {
    if (cachedTranslator === promise) cachedTranslator = null;
  });
  cachedTranslator = promise;
  return promise;
}

/**
 * Translates every cue's text into another language, one cue at a time so
 * cue boundaries and their original start/end timing are preserved exactly.
 * Per-word karaoke timing can't carry over (the translated line has
 * different words in a different order), so translated cues come back
 * without `words` — karaoke highlighting falls back to whole-line display
 * for them, same as manually-typed or uploaded captions.
 */
export async function translateCues(
  cues: CaptionCue[],
  targetLanguageCode: string,
  sourceLanguageCode: string,
  onProgress?: (p: TranslateProgress) => void,
): Promise<CaptionCue[]> {
  const translator = (await loadTranslator(onProgress)) as (
    text: string,
    options: Record<string, unknown>,
  ) => Promise<{ translation_text: string }[]>;

  const results: CaptionCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    onProgress?.({ phase: "translating", fraction: i / Math.max(1, cues.length) });
    const text = cue.text.trim();
    if (!text) {
      results.push({ ...cue });
      continue;
    }
    const output = await translator(text, {
      src_lang: sourceLanguageCode,
      tgt_lang: targetLanguageCode,
    });
    const translated = output[0]?.translation_text?.trim() || cue.text;
    results.push({ id: nextCaptionId(), start: cue.start, end: cue.end, text: translated });
  }
  onProgress?.({ phase: "translating", fraction: 1 });
  return results;
}
