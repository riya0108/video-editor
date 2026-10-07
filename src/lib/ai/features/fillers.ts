import { AIError } from "../errors";
import { itemId, type AIProvider, type TranscriptWord } from "../provider";
import { conf, type FillerItem } from "../types";
import { bare, clipTranscript } from "./transcript";

/**
 * FILLER-WORD DETECTION — speech-to-text model (the app's Whisper) + a lexicon. Two categories:
 *  - "hesitation": um, uh, er, erm, ah, hmm, mm... — unambiguous when transcribed (confidence 0.85, heuristic basis:
 *    the ASR exposes no per-word probability);
 *  - "discourse": "you know", "I mean", "like" set off by commas, "basically", "literally", "sort of"... — often
 *    legitimate speech, so lower confidence (0.45) and the user decides.
 *
 * Honest limit (measured in the test report): Whisper is trained to write CLEAN transcripts and frequently omits
 * disfluencies, so hesitations it never transcribed cannot be found. Word timings are interpolated inside Whisper's
 * phrase chunks (CAPTIONS_ARCHITECTURE.md), so ranges are approximate.
 */

const HESITATIONS = new Set(["um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "err", "ah", "ahh", "eh", "ehm", "hmm", "hm", "mm", "mmm"]);
const DISCOURSE_SINGLE = new Set(["basically", "literally", "actually", "honestly", "anyway"]);
const DISCOURSE_PAIRS = [
  ["you", "know"],
  ["i", "mean"],
  ["sort", "of"],
  ["kind", "of"],
  ["you", "see"],
];

export function findFillers(words: TranscriptWord[]): { start: number; end: number; text: string; category: FillerItem["category"] }[] {
  const out: { start: number; end: number; text: string; category: FillerItem["category"] }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i].text);
    if (!w) continue;
    if (HESITATIONS.has(w)) {
      out.push({ start: words[i].start, end: words[i].end, text: words[i].text.trim(), category: "hesitation" });
      continue;
    }
    const pair = DISCOURSE_PAIRS.find(([a, b]) => w === a && bare(words[i + 1]?.text ?? "") === b);
    if (pair) {
      // Only when set off as an aside ("..., you know, ...") — "do you know her" is not a filler.
      const prevComma = i === 0 || /[,.;!?]\s*$/.test(words[i - 1].text);
      const nextComma = /[,.;!?]/.test(words[i + 1].text);
      if (prevComma || nextComma) {
        out.push({ start: words[i].start, end: words[i + 1].end, text: `${words[i].text.trim()} ${words[i + 1].text.trim()}`, category: "discourse" });
        i++;
      }
      continue;
    }
    if (w === "like" && (/,\s*$/.test(words[i].text) || (i > 0 && /,\s*$/.test(words[i - 1].text)))) {
      out.push({ start: words[i].start, end: words[i].end, text: words[i].text.trim(), category: "discourse" });
      continue;
    }
    if (DISCOURSE_SINGLE.has(w) && /,\s*$/.test(words[i].text)) out.push({ start: words[i].start, end: words[i].end, text: words[i].text.trim(), category: "discourse" });
  }
  return out;
}

export const fillerProvider: AIProvider = {
  id: "fillers.whisper-lexicon",
  feature: "filler-detection",
  label: "Filler-word detection",
  kind: "ml-model",
  model: { name: "Whisper (onnx-community, via transformers.js) + filler lexicon", source: "Hugging Face Hub (downloaded on first use)", license: "MIT (Whisper weights)" },
  description: "Transcribes speech with Whisper and flags hesitations (um, uh…) and aside phrases (you know, I mean…). Whisper often omits disfluencies, so some fillers can be missed.",
  needs: { audio: true, transcribe: true },
  availability: (s) => (s.transcribe ? { available: true } : { available: false, reason: "Speech-to-text is not connected." }),
  async run(req, ctx) {
    const words = await clipTranscript(req, ctx, 0, 0.9);
    if (words.length === 0) throw new AIError("no-result", "No speech was recognized in this clip.");
    const found = findFillers(words);
    const items: FillerItem[] = found.map((f) => ({ kind: "filler", id: itemId("fill"), accepted: f.category === "hesitation", start: f.start, end: Math.max(f.end, f.start + 0.05), text: f.text, category: f.category, confidence: conf(f.category === "hesitation" ? 0.85 : 0.45, "heuristic") }));
    const warnings = items.length === 0 ? ["No filler words were transcribed. Whisper tends to omit hesitations, so absence here is not proof there are none."] : [];
    return { items, warnings, metrics: { words: words.length }, params: {} };
  },
};
