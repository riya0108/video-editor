import { AIError, throwIfAborted } from "../errors";
import { lumaPlane, type AIFrame } from "../media";
import { itemId, type AIProvider } from "../provider";
import { conf, type Box, type TrackItem, type TrackKey } from "../types";

/**
 * OBJECT TRACKING — classical computer vision (template matching), no model.
 *
 * The user's region (or a detected object's box) in the first frame becomes a grayscale template. In each later
 * frame it is found by zero-mean NORMALIZED CROSS-CORRELATION (robust to brightness changes) inside a search window
 * around the last position. The template adapts slowly (15% blend when
 * the match is strong) to follow gradual appearance change, and every frame is ALSO scored against the original
 * template so it can't drift onto the background (normal windows are searched exhaustively; a widened lost-target
 * window searches a half-resolution level first). A match under `lostThreshold` is reported as LOST: the position is
 * held (not guessed) and the search window widens until the target is reacquired.
 *
 * Limits (documented, tested): fixed box size (no scale change), no occlusion reasoning beyond lost/reacquire, no
 * rotation. Confidence = fraction of frames found x mean match score ("agreement").
 */

export interface TrackParams {
  region: Box;
  /** Where the region was drawn (source seconds); defaults to the clip start. Tracking runs forward from here. */
  startTime?: number;
  samplesPerSecond?: number;
  label?: string;
  lostThreshold?: number;
}

const ANALYSIS_SIDE = 320;
const MAX_TEMPLATE = 48;

export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export function toGray(f: AIFrame): Gray {
  return { width: f.width, height: f.height, data: lumaPlane(f) };
}

/** Box-filter downscale by an integer factor (template/search resolution control). */
export function downscaleGray(g: Gray, factor: number): Gray {
  if (factor <= 1) return g;
  const w = Math.max(1, Math.floor(g.width / factor));
  const h = Math.max(1, Math.floor(g.height / factor));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) s += g.data[(y * factor + dy) * g.width + x * factor + dx];
      out[y * w + x] = s / (factor * factor);
    }
  return { width: w, height: h, data: out };
}

interface Template {
  w: number;
  h: number;
  data: Float32Array; // zero-mean
  norm: number;
}

function makeTemplate(g: Gray, x: number, y: number, w: number, h: number): Template {
  const data = new Float32Array(w * h);
  let mean = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mean += data[j * w + i] = g.data[(y + j) * g.width + x + i];
  mean /= w * h;
  let norm = 0;
  for (let k = 0; k < data.length; k++) {
    data[k] -= mean;
    norm += data[k] * data[k];
  }
  return { w, h, data, norm: Math.sqrt(norm) };
}

/** Zero-mean NCC of template `t` at (x, y) in `g` (-1..1; 0 for flat patches). */
export function ncc(g: Gray, t: Template, x: number, y: number): number {
  let mean = 0;
  for (let j = 0; j < t.h; j++) {
    const row = (y + j) * g.width + x;
    for (let i = 0; i < t.w; i++) mean += g.data[row + i];
  }
  mean /= t.w * t.h;
  let dot = 0;
  let norm = 0;
  for (let j = 0; j < t.h; j++) {
    const row = (y + j) * g.width + x;
    for (let i = 0; i < t.w; i++) {
      const v = g.data[row + i] - mean;
      dot += v * t.data[j * t.w + i];
      norm += v * v;
    }
  }
  const den = Math.sqrt(norm) * t.norm;
  return den > 1e-6 ? dot / den : 0;
}

/** Exhaustive NCC search over [x0..x1] x [y0..y1] (inclusive, clamped) against several templates (best score wins). */
function searchWindow(g: Gray, templates: Template[], x0: number, x1: number, y0: number, y1: number): { x: number; y: number; score: number } {
  const t = templates[0];
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(g.width - t.w, x1);
  y1 = Math.min(g.height - t.h, y1);
  let best = { x: x0, y: y0, score: -2 };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let s = -2;
      for (const tt of templates) s = Math.max(s, ncc(g, tt, x, y));
      if (s > best.score) best = { x, y, score: s };
    }
  return best;
}

/** Halves a template's resolution (2x2 box average), re-zero-meaned. */
function halveTemplate(t: Template): Template {
  const w = Math.max(2, t.w >> 1);
  const h = Math.max(2, t.h >> 1);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (t.data[2 * y * t.w + 2 * x] + t.data[2 * y * t.w + 2 * x + 1] + t.data[(2 * y + 1) * t.w + 2 * x] + t.data[(2 * y + 1) * t.w + 2 * x + 1]) / 4;
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  let norm = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= mean;
    norm += data[i] * data[i];
  }
  return { w, h, data, norm: Math.sqrt(norm) };
}

/**
 * Finds the best match near (cx, cy). Small windows are searched EXHAUSTIVELY (a sparse grid would step over the
 * ~1 px-wide correlation peak of a detailed texture and lock onto a periodic false peak). Large windows (a lost
 * target) search a low-passed half-resolution pyramid level first, then refine ±2 px at full resolution.
 */
function bestMatch(g: Gray, half: Gray, templates: Template[], cx: number, cy: number, radius: number): { x: number; y: number; score: number } {
  const r = Math.ceil(radius);
  const x0 = Math.round(cx - r);
  const y0 = Math.round(cy - r);
  if ((2 * r + 1) ** 2 <= 4096) return searchWindow(g, templates, x0, x0 + 2 * r, y0, y0 + 2 * r);
  const halves = templates.map(halveTemplate);
  const c = searchWindow(half, halves, Math.floor(x0 / 2), Math.ceil((x0 + 2 * r) / 2), Math.floor(y0 / 2), Math.ceil((y0 + 2 * r) / 2));
  return searchWindow(g, templates, c.x * 2 - 2, c.x * 2 + 2, c.y * 2 - 2, c.y * 2 + 2);
}

/**
 * Pure tracker over grayscale frames (all the same size). `box` is normalized, for frame 0. Returns one key per
 * frame (normalized boxes) and which frames were lost.
 */
export function trackTemplate(frames: Gray[], box: Box, lostThreshold = 0.5): { keys: { box: Box; score: number; lost: boolean }[] } {
  if (frames.length === 0) return { keys: [] };
  const W = frames[0].width;
  const H = frames[0].height;
  const bw = Math.max(4, Math.round(box.w * W));
  const bh = Math.max(4, Math.round(box.h * H));
  // Track at a resolution where the template is at most MAX_TEMPLATE px.
  const factor = Math.max(1, Math.floor(Math.max(bw, bh) / MAX_TEMPLATE));
  const small = frames.map((f) => downscaleGray(f, factor));
  const sw = small[0].width;
  const sh = small[0].height;
  const tw = Math.max(3, Math.min(sw, Math.round(bw / factor)));
  const th = Math.max(3, Math.min(sh, Math.round(bh / factor)));
  let x = Math.max(0, Math.min(sw - tw, Math.round((box.x * W) / factor)));
  let y = Math.max(0, Math.min(sh - th, Math.round((box.y * H) / factor)));
  const original = makeTemplate(small[0], x, y, tw, th);
  let adaptive = original;
  const keys: { box: Box; score: number; lost: boolean }[] = [{ box: { x: (x * factor) / W, y: (y * factor) / H, w: (tw * factor) / W, h: (th * factor) / H }, score: 1, lost: false }];
  let vx = 0;
  let vy = 0;
  let lostRun = 0;
  // Motion gate: a match far from the predicted position must be STRONG to be believed. A loose box (a detector's
  // person box is mostly background) otherwise re-matches the empty spot the target left once it walks out of
  // frame — a mediocre score but well above `lostThreshold` — and the track would jump there instead of being lost.
  const gate = Math.max(2, 0.35 * Math.max(tw, th));
  const farThreshold = Math.max(lostThreshold, 0.85);
  for (let k = 1; k < small.length; k++) {
    const radius = Math.max(tw, th) * (lostRun > 0 ? 1.5 + lostRun : 0.75) + Math.hypot(vx, vy);
    const m = bestMatch(small[k], downscaleGray(small[k], 2), [adaptive, original], x + vx, y + vy, radius);
    const far = Math.hypot(m.x - (x + vx), m.y - (y + vy)) > gate;
    if (m.score >= (far ? farThreshold : lostThreshold)) {
      vx = 0.5 * vx + 0.5 * (m.x - x);
      vy = 0.5 * vy + 0.5 * (m.y - y);
      x = m.x;
      y = m.y;
      lostRun = 0;
      if (m.score > 0.8) {
        const cur = makeTemplate(small[k], x, y, tw, th);
        const blended = new Float32Array(cur.data.length);
        let norm = 0;
        for (let i = 0; i < blended.length; i++) {
          blended[i] = 0.85 * adaptive.data[i] + 0.15 * cur.data[i];
          norm += blended[i] * blended[i];
        }
        adaptive = { w: tw, h: th, data: blended, norm: Math.sqrt(norm) };
      }
      keys.push({ box: { x: (x * factor) / W, y: (y * factor) / H, w: (tw * factor) / W, h: (th * factor) / H }, score: m.score, lost: false });
    } else {
      lostRun++;
      vx *= 0.5;
      vy *= 0.5;
      keys.push({ box: { ...keys[keys.length - 1].box }, score: Math.max(0, m.score), lost: true });
    }
  }
  return { keys };
}

export const trackingProvider: AIProvider<TrackParams> = {
  id: "tracking.ncc",
  feature: "object-tracking",
  label: "Object tracking",
  kind: "classical-cv",
  description: "Follows a region (or a detected object) with normalized cross-correlation template matching; reports lost frames instead of guessing. Fixed box size. No model.",
  needs: { video: true, region: true },
  availability: () => ({ available: true }),
  async run(req, ctx) {
    const p = req.params;
    if (!p?.region || !(p.region.w > 0 && p.region.h > 0)) throw new AIError("invalid-input", "Choose a region (or a detected object) to track.");
    if (!req.media.hasVideo) throw new AIError("media-unavailable", "This clip has no picture to track in.");
    const start = Math.max(req.media.sourceStart, Math.min(req.media.sourceEnd, p.startTime ?? req.media.sourceStart));
    const rate = Math.min(req.media.fps, p.samplesPerSecond ?? 12);
    const times: number[] = [];
    for (let t = start; t < req.media.sourceEnd; t += 1 / rate) times.push(+t.toFixed(6));
    const frames: Gray[] = [];
    for (let k = 0; k < times.length; k++) {
      throwIfAborted(ctx.signal);
      frames.push(toGray(await req.media.frameAt(times[k], ANALYSIS_SIDE)));
      ctx.progress((0.8 * (k + 1)) / times.length, "Reading frames");
    }
    ctx.progress(0.85, "Tracking");
    const { keys } = trackTemplate(frames, p.region, p.lostThreshold ?? 0.5);
    const trackKeys: TrackKey[] = keys.map((k, i) => ({ time: times[i], box: k.box, score: +k.score.toFixed(3) }));
    const lostTimes = keys.flatMap((k, i) => (k.lost ? [times[i]] : []));
    const found = keys.filter((k) => !k.lost);
    const meanScore = found.length ? found.reduce((s, k) => s + k.score, 0) / found.length : 0;
    const item: TrackItem = { kind: "track", id: itemId("track"), accepted: true, label: p.label ?? "Tracked object", keys: trackKeys, lostTimes, confidence: conf((found.length / keys.length) * meanScore, "agreement") };
    const warnings = lostTimes.length ? [`Target lost in ${lostTimes.length} of ${keys.length} frames (positions held there).`] : [];
    return { items: [item], warnings, metrics: { framesAnalyzed: frames.length }, params: { region: p.region, startTime: start, samplesPerSecond: rate, lostThreshold: p.lostThreshold ?? 0.5 } };
  },
};
