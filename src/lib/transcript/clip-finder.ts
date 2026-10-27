import type { TimelineModel } from "../timeline/model";
import { timelineDurationFrames } from "../timeline/model";
import { isTrimmableContent } from "../timeline/clip";
import { importCaptionCues, applyCaptionPreset, setClipVisualsAtFrame, setCompositionSettings } from "../timeline/operations";
import { keepRange } from "../timeline/ripple";
import { segmentWords, SEGMENT_PROFILES } from "../captions/segmenter";
import type { TimelineWord } from "./transcript";

/**
 * LONG VIDEO -> SHORT CLIPS. A HEURISTIC (honestly labelled as such in the UI), built on the transcript:
 *
 *   candidates  windows that start and end on sentence boundaries, `minSec`..`maxSec` long — a clip never starts
 *               or stops mid-thought
 *   score       hook (an opening question, "how / why / here's / never / the secret…", a number)   0.30
 *               pace (words per second relative to this video)                                        0.25
 *               few dead pauses (fraction of the window not in pauses > 0.7 s)                        0.20
 *               energy (loudness relative to this video, when audio levels are given)                 0.25
 *   pick        the best non-overlapping windows
 *
 * `buildShortTimeline` turns a candidate into a ready-to-post vertical project: only that span, 9:16 with the
 * picture filling the frame, and punchy one-word captions made from the transcript (no second transcription).
 */

export interface ClipCandidate {
  start: number;
  end: number;
  score: number;
  title: string;
  text: string;
  reasons: string[];
}

const HOOKS = /^(how|why|what|here'?s|never|stop|the (secret|truth|reason|problem)|you (need|should|won'?t)|this is|i (wish|never|almost)|nobody|most people|if you)\b/i;

interface Sentence {
  words: TimelineWord[];
  start: number;
  end: number;
  text: string;
}

export function sentences(words: readonly TimelineWord[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: TimelineWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text.trim()).join(" ") });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.?!…]["')\]]*$/.test(w.text.trim()) || !next || next.start - w.end > 1.2) flush();
  });
  flush();
  return out;
}

export function findClips(words: readonly TimelineWord[], opts: { minSec?: number; maxSec?: number; count?: number; loudness?: (start: number, end: number) => number } = {}): ClipCandidate[] {
  const { minSec = 15, maxSec = 60, count = 5, loudness } = opts;
  const sents = sentences(words);
  if (sents.length === 0) return [];
  const totalSec = Math.max(1, sents[sents.length - 1].end - sents[0].start);
  const avgRate = words.length / totalSec;
  const avgLoud = loudness ? loudness(sents[0].start, sents[sents.length - 1].end) : 0;

  type Win = { start: number; end: number; first: Sentence; text: string; feats: { hook: number; pace: number; flow: number; energy: number }; reasons: string[] };
  const wins: Win[] = [];
  for (let i = 0; i < sents.length; i++) {
    let wordsIn = 0;
    let pauses = 0;
    for (let j = i; j < sents.length; j++) {
      const s = sents[j];
      wordsIn += s.words.length;
      for (let k = 1; k < s.words.length; k++) pauses += Math.max(0, s.words[k].start - s.words[k - 1].end - 0.7);
      if (j > i) pauses += Math.max(0, s.start - sents[j - 1].end - 0.7);
      const start = sents[i].start;
      const end = s.end;
      const dur = end - start;
      if (dur > maxSec) break;
      if (dur < minSec) continue;
      const first = sents[i];
      const reasons: string[] = [];
      const hook = (first.text.includes("?") ? 0.6 : 0) + (HOOKS.test(first.text) ? 0.6 : 0) + (/\d/.test(first.text) ? 0.25 : 0);
      if (first.text.includes("?")) reasons.push("opens with a question");
      else if (HOOKS.test(first.text)) reasons.push("strong opening line");
      const pace = wordsIn / dur / Math.max(0.1, avgRate);
      if (pace > 1.15) reasons.push("fast-paced");
      const flow = 1 - Math.min(1, pauses / dur);
      const energy = loudness ? loudness(start, end) - avgLoud : 0;
      if (energy > 2) reasons.push("energetic delivery");
      wins.push({ start, end, first, text: sents.slice(i, j + 1).map((x) => x.text).join(" "), feats: { hook: Math.min(1, hook), pace, flow, energy }, reasons });
    }
  }
  if (wins.length === 0) return [];
  const norm = (k: keyof Win["feats"]) => {
    const vs = wins.map((w) => w.feats[k]);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  };
  const nPace = norm("pace");
  const nFlow = norm("flow");
  const nEnergy = norm("energy");
  const scored = wins
    .map((w) => ({ ...w, score: 0.3 * w.feats.hook + 0.25 * nPace(w.feats.pace) + 0.2 * nFlow(w.feats.flow) + (loudness ? 0.25 * nEnergy(w.feats.energy) : 0.125) }))
    .sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  for (const w of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => w.start < p.end && w.end > p.start)) continue;
    picked.push(w);
  }
  const title = (t: string) => (t.length > 64 ? `${t.slice(0, 61).trimEnd()}…` : t);
  return picked
    .sort((a, b) => a.start - b.start)
    .map((w) => ({ start: w.start, end: w.end, score: Math.round(w.score * 100) / 100, title: title(w.first.text), text: w.text, reasons: w.reasons.length ? w.reasons : ["complete thought"] }));
}

/** A vertical short of one candidate: span only, 9:16, picture filling the frame, one-word captions from the transcript. */
export function buildShortTimeline(timeline: TimelineModel, cand: ClipCandidate, words: readonly TimelineWord[], opts: { captions: boolean; captionPreset?: string }): TimelineModel {
  const fps = timeline.frameRate;
  const s = Math.max(0, Math.round(cand.start * fps) - 3);
  const e = Math.round(cand.end * fps) + 6;
  let tl = keepRange(timeline, s, e, timelineDurationFrames(timeline));
  tl = setCompositionSettings(tl, { width: 1080, height: 1920 }, "proportional");
  // Footage fills the vertical frame (centre crop); the AI panel's auto-reframe can then follow the speaker.
  const fill: Record<string, { fit: "cover"; transform: { x: number; y: number; scaleX: number; scaleY: number } }> = {};
  for (const c of Object.values(tl.clips)) {
    const kind = tl.tracks[c.trackId]?.kind;
    if (isTrimmableContent(c.content) && (kind === "video" || kind === "overlay") && c.content.kind !== "audio") fill[c.id] = { fit: "cover", transform: { x: 540, y: 960, scaleX: 1, scaleY: 1 } };
  }
  if (Object.keys(fill).length) tl = setClipVisualsAtFrame(tl, fill, 0);
  if (opts.captions) {
    const inside = words.filter((w) => w.start >= s / fps && w.end <= e / fps).map((w) => ({ text: w.text, start: w.start - s / fps, end: w.end - s / fps }));
    const cues = segmentWords(inside, SEGMENT_PROFILES["short-form"]);
    if (cues.length) {
      // Existing caption tracks were cut along with everything else; new captions come from the words themselves.
      const r = importCaptionCues(tl, cues, { name: "Captions" });
      tl = r.timeline;
      tl = applyCaptionPreset(tl, r.trackId, opts.captionPreset ?? "punchy");
    }
  }
  return tl;
}
