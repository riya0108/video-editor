import { AIError, throwIfAborted } from "../errors";
import { sampleTimes, toMono } from "../media";
import { itemId, type AIProvider } from "../provider";
import { conf, type HighlightItem } from "../types";
import { frameDistance, frameFeatures, type FrameFeatures } from "./shots";
import { windowLevelsDb } from "./silence";

/**
 * HIGHLIGHT DETECTION — a HEURISTIC, not a model of "interestingness". It scores sliding windows by signals that
 * correlate with energetic moments, and says which signals fired:
 *   - loudness: window mean level relative to the clip (z-score),
 *   - speech/sound activity: fraction of the window above the clip's noise floor,
 *   - visual activity: mean frame-to-frame change (motion, cuts) at 2 fps.
 * Weighted (0.45 / 0.2 / 0.35; missing signals drop out and the rest renormalise), min-max normalised across the
 * clip, and the top non-overlapping windows above 0.5 are returned. Confidence = that normalised score
 * ("heuristic" basis) — relative to THIS clip, not an absolute judgement.
 */

export interface HighlightParams {
  windowSec?: number;
  maxHighlights?: number;
}

export interface WindowSignals {
  start: number;
  end: number;
  loudness?: number;
  activity?: number;
  motion?: number;
}

const zscores = (xs: number[]) => {
  const m = xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length)) || 1;
  return xs.map((x) => (x - m) / sd);
};

export function scoreHighlights(windows: WindowSignals[], maxHighlights = 3): { start: number; end: number; score: number; reasons: string[] }[] {
  if (windows.length === 0) return [];
  const has = { loudness: windows.every((w) => w.loudness !== undefined), activity: windows.every((w) => w.activity !== undefined), motion: windows.every((w) => w.motion !== undefined) };
  const zl = has.loudness ? zscores(windows.map((w) => w.loudness!)) : [];
  const zm = has.motion ? zscores(windows.map((w) => w.motion!)) : [];
  const wts = { loudness: has.loudness ? 0.45 : 0, activity: has.activity ? 0.2 : 0, motion: has.motion ? 0.35 : 0 };
  const total = wts.loudness + wts.activity + wts.motion || 1;
  const raw = windows.map((w, i) => (wts.loudness * (zl[i] ?? 0) + wts.activity * ((w.activity ?? 0) * 2 - 1) + wts.motion * (zm[i] ?? 0)) / total);
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  const norm = raw.map((r) => (hi - lo > 1e-9 ? (r - lo) / (hi - lo) : 0));
  const order = norm.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const picked: { start: number; end: number; score: number; reasons: string[] }[] = [];
  for (const { s, i } of order) {
    if (picked.length >= maxHighlights || s < 0.5) break;
    const w = windows[i];
    if (picked.some((p) => w.start < p.end && w.end > p.start)) continue;
    const reasons: string[] = [];
    if (has.loudness && zl[i] > 0.75) reasons.push(`louder than the rest of the clip (+${zl[i].toFixed(1)}σ)`);
    if (has.motion && zm[i] > 0.75) reasons.push(`more visual action (+${zm[i].toFixed(1)}σ)`);
    if (has.activity && (w.activity ?? 0) > 0.85) reasons.push("continuous sound/speech");
    if (reasons.length === 0) reasons.push("highest combined activity");
    picked.push({ start: w.start, end: w.end, score: s, reasons });
  }
  return picked.sort((a, b) => a.start - b.start);
}

export const highlightProvider: AIProvider<HighlightParams> = {
  id: "highlights.activity-heuristic",
  feature: "highlight-detection",
  label: "Highlight detection",
  kind: "heuristic",
  description: "Ranks moments by loudness, sound activity and visual action relative to the rest of the clip, and says which signals fired. A heuristic, not a judgement of content.",
  needs: {},
  availability: () => ({ available: true }),
  async run(req, ctx) {
    const media = req.media;
    if (!media.hasAudio && (!media.hasVideo || media.still)) throw new AIError("invalid-input", "Highlights need audio or moving picture.");
    const win = req.params.windowSec ?? 4;
    const dur = media.sourceEnd - media.sourceStart;
    if (dur < win * 1.5) throw new AIError("invalid-input", `The clip is too short for ${win} s highlight windows.`);
    const hop = win / 4;
    const windows: WindowSignals[] = [];
    for (let s = media.sourceStart; s + win <= media.sourceEnd + 1e-6; s += hop) windows.push({ start: +s.toFixed(3), end: +(s + win).toFixed(3) });
    if (media.hasAudio) {
      ctx.progress(0.05, "Reading audio");
      const a = await media.audio();
      throwIfAborted(ctx.signal);
      const levels = windowLevelsDb(toMono(a), a.sampleRate, 0.05);
      const sorted = Float32Array.from(levels).sort();
      const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
      for (const w of windows) {
        const i0 = Math.floor((w.start - media.sourceStart) / 0.05);
        const i1 = Math.min(levels.length, Math.floor((w.end - media.sourceStart) / 0.05));
        let sum = 0;
        let active = 0;
        for (let i = i0; i < i1; i++) {
          sum += 10 ** (levels[i] / 10);
          if (levels[i] > floor + 10) active++;
        }
        w.loudness = 10 * Math.log10(sum / Math.max(1, i1 - i0) + 1e-12);
        w.activity = active / Math.max(1, i1 - i0);
      }
    }
    let frames = 0;
    if (media.hasVideo && !media.still) {
      const times = sampleTimes(media.sourceStart, media.sourceEnd, 2, 600);
      const feats: FrameFeatures[] = [];
      for (let k = 0; k < times.length; k++) {
        throwIfAborted(ctx.signal);
        feats.push(frameFeatures(await media.frameAt(times[k], 96)));
        ctx.progress(0.2 + (0.7 * (k + 1)) / times.length, "Measuring visual activity");
      }
      frames = feats.length;
      const diffs = feats.map((f, i) => (i === 0 ? 0 : frameDistance(feats[i - 1], f)));
      for (const w of windows) {
        const inside = times.map((t, i) => ({ t, d: diffs[i] })).filter((x, i) => i > 0 && x.t >= w.start && x.t < w.end);
        w.motion = inside.length ? inside.reduce((s, x) => s + x.d, 0) / inside.length : 0;
      }
    }
    const picks = scoreHighlights(windows, req.params.maxHighlights ?? 3);
    const items: HighlightItem[] = picks.map((p) => ({ kind: "highlight", id: itemId("hl"), accepted: true, start: p.start, end: p.end, score: +p.score.toFixed(3), reasons: p.reasons, confidence: conf(p.score, "heuristic") }));
    return { items, warnings: items.length === 0 ? ["No moment stood out from the rest of the clip."] : [], metrics: { framesAnalyzed: frames, windows: windows.length }, params: { windowSec: win, maxHighlights: req.params.maxHighlights ?? 3 } };
  },
};
