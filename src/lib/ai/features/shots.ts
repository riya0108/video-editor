import { AIError, throwIfAborted } from "../errors";
import { lumaPlane, type AIFrame, type AIMediaSource } from "../media";
import { itemId, type AIProvider, type AIRunContext } from "../provider";
import { marginConfidence, type SceneItem, type ShotItem } from "../types";

/**
 * SHOT & SCENE DETECTION — classical computer vision, no model.
 *
 * Per frame: a soft-binned HSV colour histogram (8 hue x 4 sat x 4 val) and a 32 px-wide luma thumbnail. Between consecutive
 * frames: d = 0.5 x Bhattacharyya distance of the histograms + 0.5 x mean absolute thumbnail difference.
 *
 *  - HARD CUT: d is an outlier against its neighbourhood — d > 3 x local median + 0.03 and d > 0.05 — so steady
 *    camera/subject motion (high but uniform d) doesn't trigger, while a cut between similar-looking shots (a jump
 *    cut) still stands out.
 *  - DISSOLVE (twin comparison): a RUN of consecutive raised d (a cut is one isolated spike; a dissolve spreads
 *    over several frames) whose endpoints differ a lot (direct distance > 0.25), accepted only if the middle frame
 *    really is a mix of the endpoints (blend error < 35% of their difference, mixing weight 0.2-0.8) — which rejects
 *    zooms, pans, and a cut followed by motion. A run that fails keeps only its spikes as cuts. Single-sample dips
 *    inside a run are bridged (frame-rate conformance duplicates frames).
 *  - Cuts found at the analysis rate are refined to the exact source frame by checking every frame in between.
 *
 * SCENES group consecutive shots whose mean histograms are similar (Bhattacharyya < 0.3): a jump cut stays in its
 * scene, a cut to a different place starts a new one.
 */

export interface ShotParams {
  /** Frames per second to analyse (capped at the source rate). Default 12 ("fast"). */
  analysisFps?: number;
  /** "precise" analyses EVERY frame (slower) — needed to separate a jump cut within the same setup from normal motion. */
  precision?: "fast" | "precise";
  /** Scene grouping threshold. */
  sceneThreshold?: number;
}

const HIST_BINS = 8 * 4 * 4;
const THUMB_W = 32;
const ANALYSIS_SIDE = 96;

export interface FrameFeatures {
  hist: Float32Array;
  thumb: Float32Array;
  thumbW: number;
  thumbH: number;
}

export function frameFeatures(f: AIFrame): FrameFeatures {
  const hist = new Float32Array(HIST_BINS);
  const d = f.data;
  const n = f.width * f.height;
  for (let p = 0; p < n * 4; p += 4) {
    const r = d[p] / 255;
    const g = d[p + 1] / 255;
    const b = d[p + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const c = max - min;
    let h = 0;
    if (c > 1e-6) {
      if (max === r) h = ((g - b) / c + 6) % 6;
      else if (max === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
    }
    const s = max > 0 ? c / max : 0;
    // SOFT (trilinear) binning: each pixel votes into neighbouring bins by distance, so a gradual colour change
    // (a dissolve, a lighting drift) moves the histogram gradually instead of jumping a whole bin at once.
    // Hue wraps around; saturation/value clamp at the ends.
    const hf = (h / 6) * 8 - 0.5;
    const sf = Math.min(3, Math.max(0, s * 4 - 0.5));
    const vf = Math.min(3, Math.max(0, max * 4 - 0.5));
    const h0 = Math.floor(hf);
    const s0 = Math.min(2, Math.floor(sf));
    const v0 = Math.min(2, Math.floor(vf));
    const fh = hf - h0;
    const fs = sf - s0;
    const fv = vf - v0;
    for (let dh = 0; dh < 2; dh++) {
      const hb = (((h0 + dh) % 8) + 8) % 8;
      const wh = dh ? fh : 1 - fh;
      for (let ds = 0; ds < 2; ds++) {
        const ws = ds ? fs : 1 - fs;
        for (let dv = 0; dv < 2; dv++) {
          const wv = dv ? fv : 1 - fv;
          hist[(hb * 4 + s0 + ds) * 4 + v0 + dv] += wh * ws * wv;
        }
      }
    }
  }
  for (let i = 0; i < HIST_BINS; i++) hist[i] /= n;
  // Luma thumbnail by box averaging.
  const luma = lumaPlane(f);
  const tw = Math.min(THUMB_W, f.width);
  const th = Math.max(1, Math.round((f.height * tw) / f.width));
  const thumb = new Float32Array(tw * th);
  const cnt = new Float32Array(tw * th);
  for (let y = 0; y < f.height; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / f.height));
    for (let x = 0; x < f.width; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / f.width));
      thumb[ty * tw + tx] += luma[y * f.width + x];
      cnt[ty * tw + tx] += 1;
    }
  }
  for (let i = 0; i < thumb.length; i++) thumb[i] /= Math.max(1, cnt[i]) * 255;
  return { hist, thumb, thumbW: tw, thumbH: th };
}

export function bhattacharyya(p: Float32Array, q: Float32Array): number {
  let bc = 0;
  for (let i = 0; i < p.length; i++) bc += Math.sqrt(p[i] * q[i]);
  return Math.sqrt(Math.max(0, 1 - bc));
}

export function frameDistance(a: FrameFeatures, b: FrameFeatures): number {
  let pix = 0;
  for (let i = 0; i < a.thumb.length; i++) pix += Math.abs(a.thumb[i] - b.thumb[i]);
  pix /= a.thumb.length;
  return 0.5 * bhattacharyya(a.hist, b.hist) + 0.5 * pix;
}

/**
 * How well `mid` is explained as a mix of `a` and `b`: least-squares mixing weight `w` (mid ≈ a + w (b - a)) and the
 * residual relative to |a - b| (0 = perfect blend).
 */
export function blendFit(a: FrameFeatures, mid: FrameFeatures, b: FrameFeatures): { error: number; weight: number } {
  let span = 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.thumb.length; i++) {
    const diff = b.thumb[i] - a.thumb[i];
    span += Math.abs(diff);
    num += (mid.thumb[i] - a.thumb[i]) * diff;
    den += diff * diff;
  }
  const w = den > 0 ? Math.min(1, Math.max(0, num / den)) : 0.5;
  let err = 0;
  for (let i = 0; i < a.thumb.length; i++) err += Math.abs(mid.thumb[i] - (a.thumb[i] + w * (b.thumb[i] - a.thumb[i])));
  return { error: span > 0 ? err / span : 1, weight: w };
}

/**
 * A real dissolve: the run's middle frame is a GENUINE mix of its ends — small residual AND a mixing weight well
 * inside (0.2, 0.8). A weight near 0 or 1 means the middle frame is just one of the ends (e.g. a hard cut followed by
 * camera motion), which a free least-squares fit would otherwise also "explain".
 */
export function isDissolve(a: FrameFeatures, mid: FrameFeatures, b: FrameFeatures): boolean {
  const f = blendFit(a, mid, b);
  return frameDistance(a, b) > 0.25 && f.error < 0.35 && f.weight >= 0.2 && f.weight <= 0.8;
}

export interface Boundary {
  /** Index of the first frame AFTER the boundary (cut) / of the transition's first and last frames (dissolve). */
  kind: "cut" | "dissolve";
  index: number;
  endIndex: number;
  score: number;
  threshold: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Pure boundary detection over per-frame features (exported for tests). */
export function detectBoundaries(feats: FrameFeatures[], window = 6): Boundary[] {
  const n = feats.length;
  const d: number[] = [0];
  for (let i = 1; i < n; i++) d.push(frameDistance(feats[i - 1], feats[i]));
  const localMedian = (i: number, w: number) => {
    const xs: number[] = [];
    for (let k = Math.max(1, i - w); k <= Math.min(n - 1, i + w); k++) if (k !== i) xs.push(d[k]);
    return median(xs);
  };
  const local = (i: number) => localMedian(i, window);
  // Dissolve frames raise d for several frames in a row, so their baseline comes from a much wider window.
  const raised = (i: number) => d[i] > Math.max(0.015, 1.3 * localMedian(i, window * 4) + 0.008);
  const out: Boundary[] = [];
  const cutTh = (i: number) => Math.max(0.05, 2.5 * local(i) + 0.02);
  const spike = (i: number) => d[i] > cutTh(i);
  let i = 1;
  while (i < n) {
    if (!spike(i) && !raised(i)) {
      i++;
      continue;
    }
    // A run of consecutive raised/spiking steps.
    // Single-sample dips are bridged: frame-rate conformance (e.g. 24 -> 30 fps) duplicates frames, and a duplicate's
    // zero distance would otherwise chop a dissolve into fragments.
    const hot = (k: number) => spike(k) || raised(k);
    let j = i;
    while (j + 1 < n && (hot(j + 1) || (j + 2 < n && hot(j + 2)))) j += hot(j + 1) ? 1 : 2;
    const spikes: number[] = [];
    for (let k = i; k <= j; k++) if (spike(k)) spikes.push(k);
    let dissolve = false;
    if (j > i) {
      // Gradual change over several steps: a dissolve only if the middle really is a mix of the ends.
      const start = i - 1;
      const direct = frameDistance(feats[start], feats[j]);
      if (isDissolve(feats[start], feats[Math.round((start + j) / 2)], feats[j])) {
        out.push({ kind: "dissolve", index: i, endIndex: j, score: direct, threshold: 0.25 });
        dissolve = true;
      }
    }
    // An isolated spike is a cut; a run that isn't a dissolve keeps only its spikes as cuts (e.g. a very short shot).
    if (!dissolve) for (const k of spikes) out.push({ kind: "cut", index: k, endIndex: k, score: d[k], threshold: cutTh(k) });
    i = j + 1;
  }
  return out.sort((a, b) => a.index - b.index);
}

async function featuresAt(media: AIMediaSource, times: number[], ctx: AIRunContext, from: number, to: number): Promise<FrameFeatures[]> {
  const out: FrameFeatures[] = [];
  for (let k = 0; k < times.length; k++) {
    throwIfAborted(ctx.signal);
    out.push(frameFeatures(await media.frameAt(times[k], ANALYSIS_SIDE)));
    ctx.progress(from + ((to - from) * (k + 1)) / times.length, "Reading frames");
  }
  return out;
}

export interface ShotAnalysis {
  shots: ShotItem[];
  /** Mean histogram per shot (scene grouping input). */
  signatures: Float32Array[];
  framesAnalyzed: number;
}

/** Runs detection over the clip's span; returns shots in SOURCE seconds. */
export async function analyseShots(media: AIMediaSource, params: ShotParams, ctx: AIRunContext): Promise<ShotAnalysis> {
  if (!media.hasVideo) throw new AIError("media-unavailable", "This clip has no picture to analyse.");
  const fps = Math.min(media.fps, params.analysisFps ?? (params.precision === "precise" ? media.fps : 12));
  const step = 1 / fps;
  const frameDur = 1 / media.fps;
  // Sample whole SOURCE frames (at their centres) so refinement can land on exact frames — stepping in seconds would
  // drift off frame centres whenever the analysis rate doesn't divide the source rate (12 fps over 30 fps).
  const frameCount = Math.round((media.sourceEnd - media.sourceStart) * media.fps);
  const frameTime = (f: number) => +(media.sourceStart + (f + 0.5) * frameDur).toFixed(6);
  const sampleFrames: number[] = [];
  for (let k = 0; ; k++) {
    const f = Math.floor(k * step * media.fps + 1e-6);
    if (f >= frameCount) break;
    sampleFrames.push(f);
  }
  const times = sampleFrames.map(frameTime);
  if (times.length < 2) throw new AIError("invalid-input", "The clip is too short to find shots in.");
  const feats = await featuresAt(media, times, ctx, 0, 0.8);
  let frames = feats.length;
  const raw = detectBoundaries(feats);
  // Refine cuts to the exact frame: when samples skip frames, test every frame between the two samples. A real cut
  // happens in ONE frame step; if the change is spread over the in-between frames it is gradual — collected and
  // validated as a dissolve below (or dropped: a fast pan is not a shot boundary).
  const boundaries: { time: number; kind: "cut" | "dissolve"; end?: number; score: number; threshold: number }[] = [];
  const gradual: { t0: number; t1: number; f0: FrameFeatures; f1: FrameFeatures; mid: FrameFeatures[] }[] = [];
  for (const b of raw) {
    throwIfAborted(ctx.signal);
    if (b.kind === "dissolve") {
      boundaries.push({ kind: "dissolve", time: times[b.index] - frameDur / 2, end: times[b.endIndex] + frameDur / 2, score: b.score, threshold: b.threshold });
      continue;
    }
    const t0 = times[b.index - 1];
    const t1 = times[b.index];
    let cutTime = (t0 + t1) / 2;
    const between: number[] = [];
    for (let f = sampleFrames[b.index - 1] + 1; f < sampleFrames[b.index]; f++) between.push(frameTime(f));
    if (between.length > 0) {
      const mids = await featuresAt(media, between, ctx, 0.8, 0.8);
      const seq = [feats[b.index - 1], ...mids, feats[b.index]];
      frames += between.length;
      const ts = [t0, ...between, t1];
      let best = 1;
      let bestD = -1;
      for (let k = 1; k < seq.length; k++) {
        const dk = frameDistance(seq[k - 1], seq[k]);
        if (dk > bestD) {
          bestD = dk;
          best = k;
        }
      }
      if (bestD < 0.5 * frameDistance(seq[0], seq[seq.length - 1])) {
        gradual.push({ t0, t1, f0: seq[0], f1: seq[seq.length - 1], mid: mids });
        continue;
      }
      cutTime = (ts[best - 1] + ts[best]) / 2;
    }
    boundaries.push({ kind: "cut", time: cutTime, score: b.score, threshold: b.threshold });
  }
  // Merge touching gradual spans (a dissolve longer than one sample step shows up as several), then validate.
  for (let i = 0; i < gradual.length; i++) {
    let g = gradual[i];
    const mids = [...g.mid];
    while (i + 1 < gradual.length && Math.abs(gradual[i + 1].t0 - g.t1) < frameDur / 2) {
      mids.push(gradual[i].f1, ...gradual[i + 1].mid);
      g = { ...g, t1: gradual[i + 1].t1, f1: gradual[i + 1].f1 };
      i++;
    }
    const direct = frameDistance(g.f0, g.f1);
    const mid = mids[Math.floor(mids.length / 2)] ?? g.f0;
    if (isDissolve(g.f0, mid, g.f1)) boundaries.push({ kind: "dissolve", time: g.t0, end: g.t1, score: direct, threshold: 0.25 });
  }
  boundaries.sort((a, b) => a.time - b.time);
  ctx.progress(0.9, "Building shots");
  // Shots between boundaries (a dissolve's midpoint splits the two shots).
  const cuts = boundaries.map((b) => ({ ...b, at: b.kind === "dissolve" ? (b.time + (b.end ?? b.time)) / 2 : b.time }));
  const shots: ShotItem[] = [];
  const signatures: Float32Array[] = [];
  let start = media.sourceStart;
  let transitionIn: ShotItem["transitionIn"] = "start";
  let conf = marginConfidence(1, 0, 1);
  const pushShot = (end: number) => {
    const sig = new Float32Array(HIST_BINS);
    let k = 0;
    feats.forEach((f, idx) => {
      if (times[idx] >= start && times[idx] < end) {
        for (let b = 0; b < HIST_BINS; b++) sig[b] += f.hist[b];
        k++;
      }
    });
    if (k > 0) for (let b = 0; b < HIST_BINS; b++) sig[b] /= k;
    shots.push({ kind: "shot", id: itemId("shot"), accepted: true, start: +start.toFixed(3), end: +end.toFixed(3), transitionIn, confidence: conf });
    signatures.push(sig);
  };
  for (const c of cuts) {
    if (c.at - start < frameDur) continue;
    pushShot(c.at);
    start = c.at;
    transitionIn = c.kind;
    conf = marginConfidence(c.score, c.threshold, Math.max(0.05, c.threshold));
  }
  pushShot(media.sourceEnd);
  return { shots, signatures, framesAnalyzed: frames };
}

export function groupScenes(shots: ShotItem[], signatures: Float32Array[], threshold = 0.3): SceneItem[] {
  const scenes: SceneItem[] = [];
  let current: { start: number; end: number; shotIds: string[]; sig: Float32Array; minMargin: number } | null = null;
  shots.forEach((s, i) => {
    const sig = signatures[i];
    if (current) {
      const dist = bhattacharyya(current.sig, sig);
      if (dist < threshold) {
        current.end = s.end;
        current.shotIds.push(s.id);
        current.sig = sig;
        current.minMargin = Math.min(current.minMargin, threshold - dist);
        return;
      }
      scenes.push(toScene(current, threshold));
    }
    current = { start: s.start, end: s.end, shotIds: [s.id], sig, minMargin: threshold };
  });
  if (current) scenes.push(toScene(current, threshold));
  return scenes;
}

function toScene(c: { start: number; end: number; shotIds: string[]; minMargin: number }, threshold: number): SceneItem {
  return { kind: "scene", id: itemId("scene"), accepted: true, start: c.start, end: c.end, shotIds: c.shotIds, confidence: marginConfidence(c.minMargin, 0, threshold) };
}

export const shotProvider: AIProvider<ShotParams> = {
  id: "shots.histogram",
  feature: "shot-detection",
  label: "Shot detection",
  kind: "classical-cv",
  description: "Hard cuts (adaptive outlier test) and dissolves (twin comparison + blend check) from colour histograms and thumbnails. Fast = 12 fps; Precise = every frame (also finds jump cuts within the same setup). No model.",
  needs: { video: true },
  availability: () => ({ available: true }),
  async run(req, ctx) {
    const a = await analyseShots(req.media, req.params, ctx);
    return { items: a.shots, warnings: a.shots.length === 1 ? ["No shot boundaries found — the clip looks like one continuous shot."] : [], metrics: { framesAnalyzed: a.framesAnalyzed }, params: { precision: req.params.precision ?? "fast", analysisFps: Math.min(req.media.fps, req.params.analysisFps ?? (req.params.precision === "precise" ? req.media.fps : 12)) } };
  },
};

export const sceneProvider: AIProvider<ShotParams> = {
  id: "scenes.shot-grouping",
  feature: "scene-detection",
  label: "Scene detection",
  kind: "classical-cv",
  description: "Groups detected shots into scenes by colour similarity (a jump cut stays in its scene). No model.",
  needs: { video: true },
  availability: () => ({ available: true }),
  async run(req, ctx) {
    const a = await analyseShots(req.media, req.params, ctx);
    const scenes = groupScenes(a.shots, a.signatures, req.params.sceneThreshold ?? 0.3);
    // Shots are returned too (scenes reference them by id).
    return { items: [...scenes, ...a.shots], warnings: [], metrics: { framesAnalyzed: a.framesAnalyzed, shots: a.shots.length }, params: { precision: req.params.precision ?? "fast", analysisFps: Math.min(req.media.fps, req.params.analysisFps ?? (req.params.precision === "precise" ? req.media.fps : 12)), sceneThreshold: req.params.sceneThreshold ?? 0.3 } };
  },
};
