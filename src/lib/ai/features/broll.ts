import { AIError } from "../errors";
import { itemId, type AIProvider, type TranscriptWord } from "../provider";
import { conf, type BrollItem } from "../types";
import { bare, clipTranscript } from "./transcript";

/**
 * B-ROLL SUGGESTIONS — heuristic over the Whisper transcript. Speech is split into phrases (sentence punctuation or
 * a pause > 0.7 s); each phrase of at least `minDuration` seconds gets keywords: content words (stop words removed),
 * scored by TF-IDF across the clip's phrases with bonuses for length and capitalised (proper-noun-like) words. The
 * top keywords become a search query.
 *
 * What it does NOT do: understand images or fetch footage — no stock-media service is connected. A suggestion is a
 * time range + query; applying it drops an editable placeholder layer there for you to replace with real media.
 */

export interface BrollParams {
  minDuration?: number;
  maxSuggestions?: number;
}

const STOP = new Set(
  "a an the and or but if then so because as of at by for with about against between into through during before after above below to from up down in out on off over under again further here there when where why how all any both each few more most other some such no nor not only own same than too very can will just don should now i me my myself we our ours you your yours he him his she her it its they them their what which who whom this that these those am is are was were be been being have has had having do does did doing would could ought i'm you're he's she's it's we're they're i've you've we've they've i'd you'd he'd she'd we'd they'd i'll you'll he'll she'll we'll they'll isn't aren't wasn't weren't hasn't haven't hadn't doesn't don't didn't won't wouldn't shan't shouldn't can't cannot couldn't mustn't let's that's who's what's here's there's when's where's why's how's really also like know get got going go gonna wanna yeah okay ok um uh well thing things lot lots way one two make made today something anything everything stuff kind sort mean actually basically just right"
    .split(" "),
);

export interface Phrase {
  start: number;
  end: number;
  words: TranscriptWord[];
}

export function phrases(words: TranscriptWord[]): Phrase[] {
  const out: Phrase[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    if (cur.length && w.start - words[i - 1].end > 0.7) flush();
    cur.push(w);
    if (/[.!?]\s*$/.test(w.text)) flush();
  });
  flush();
  return out;
}

export function suggestBroll(words: TranscriptWord[], params: BrollParams = {}): { start: number; end: number; keywords: string[]; score: number; transcript: string }[] {
  const ps = phrases(words).filter((p) => p.end - p.start >= (params.minDuration ?? 1.5));
  if (ps.length === 0) return [];
  const tokens = ps.map((p) => p.words.map((w) => ({ raw: w.text.trim(), b: bare(w.text) })).filter((t) => t.b.length >= 3 && !STOP.has(t.b) && !/^\d+$/.test(t.b)));
  const df = new Map<string, number>();
  for (const ts of tokens) for (const b of new Set(ts.map((t) => t.b))) df.set(b, (df.get(b) ?? 0) + 1);
  const out = ps.map((p, i) => {
    const tf = new Map<string, { n: number; cap: boolean }>();
    tokens[i].forEach((t, k) => {
      const e = tf.get(t.b) ?? { n: 0, cap: false };
      e.n++;
      // Capitalised mid-sentence = proper-noun-like (the first word of a phrase is capitalised anyway).
      if (k > 0 && /^[A-Z]/.test(t.raw.replace(/^[^\p{L}]+/u, ""))) e.cap = true;
      tf.set(t.b, e);
    });
    const scored = [...tf.entries()].map(([b, e]) => ({ b, s: e.n * Math.log(1 + ps.length / (df.get(b) ?? 1)) * (1 + Math.min(4, b.length - 3) * 0.15) * (e.cap ? 1.5 : 1) }));
    scored.sort((a, z) => z.s - a.s);
    const keywords = scored.slice(0, 3).map((x) => x.b);
    return { start: p.start, end: p.end, keywords, score: scored.slice(0, 3).reduce((s, x) => s + x.s, 0), transcript: p.words.map((w) => w.text.trim()).join(" ") };
  });
  const withKw = out.filter((o) => o.keywords.length > 0);
  const max = Math.max(...withKw.map((o) => o.score), 1e-9);
  return withKw
    .map((o) => ({ ...o, score: o.score / max }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.maxSuggestions ?? 8)
    .sort((a, b) => a.start - b.start);
}

export const brollProvider: AIProvider<BrollParams> = {
  id: "broll.transcript-keywords",
  feature: "broll-suggestions",
  label: "B-roll suggestions",
  kind: "heuristic",
  model: { name: "Whisper transcript (transformers.js) + TF-IDF keywords", source: "Hugging Face Hub (downloaded on first use)", license: "MIT (Whisper weights)" },
  description: "Suggests where B-roll could go and what to search for, from keywords in the speech. Heuristic: it doesn't look at footage or fetch stock media.",
  needs: { audio: true, transcribe: true },
  availability: (s) => (s.transcribe ? { available: true } : { available: false, reason: "Speech-to-text is not connected." }),
  async run(req, ctx) {
    const words = await clipTranscript(req, ctx, 0, 0.9);
    if (words.length === 0) throw new AIError("no-result", "No speech was recognized, so there is nothing to base suggestions on.");
    const sugg = suggestBroll(words, req.params);
    const items: BrollItem[] = sugg.map((s) => ({ kind: "broll", id: itemId("broll"), accepted: true, start: s.start, end: s.end, keywords: s.keywords, query: s.keywords.join(" "), transcript: s.transcript, confidence: conf(s.score, "heuristic") }));
    return { items, warnings: items.length === 0 ? ["No phrase had clear keywords."] : [], metrics: { words: words.length }, params: { minDuration: req.params.minDuration ?? 1.5, maxSuggestions: req.params.maxSuggestions ?? 8 } };
  },
};
