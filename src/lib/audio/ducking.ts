import { clipTimelineEnd } from "../timeline/clip";
import type { TimelineModel } from "../timeline/model";
import { addKeyframe, removeKeyframe } from "../timeline/operations";
import { valueAt } from "../animation/properties";

/**
 * AUTO-DUCKING — music dips under speech, automatically.
 *
 * 1. `speechRegions` finds where the VOICE (the timeline's speech tracks, mixed) is active: 20 ms RMS frames above
 *    an adaptive threshold (10 dB over the recording's own noise floor, never below -45 dBFS), with a hang time so
 *    words don't flutter, and short gaps merged so the music doesn't bob between words.
 * 2. `applyDucking` writes ordinary gain keyframes (audio.gainDb) on each music clip: down by `duckDb` during speech,
 *    with an attack before and a release after. One undo step via engine.transact; the keyframes are visible and
 *    editable in the Motion tab like any other.
 */

const FRAME_SEC = 0.02;

export function speechRegions(mono: Float32Array, sampleRate: number, opts: { minGapSec?: number; hangSec?: number; minSpeechSec?: number } = {}): [number, number][] {
  const { minGapSec = 0.6, hangSec = 0.2, minSpeechSec = 0.25 } = opts;
  const hop = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const n = Math.floor(mono.length / hop);
  if (n === 0) return [];
  const level = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += mono[i] * mono[i];
    level[f] = 10 * Math.log10(Math.max(1e-12, s / hop));
  }
  const sorted = [...level].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const threshold = Math.max(-45, floor + 10);
  const hang = Math.round(hangSec / FRAME_SEC);
  const regions: [number, number][] = [];
  let start = -1;
  let lastActive = -1;
  for (let f = 0; f < n; f++) {
    if (level[f] > threshold) {
      if (start < 0) start = f;
      lastActive = f;
    } else if (start >= 0 && f - lastActive > hang) {
      regions.push([start * FRAME_SEC, (lastActive + 1 + hang) * FRAME_SEC]);
      start = -1;
    }
  }
  if (start >= 0) regions.push([start * FRAME_SEC, Math.min(n, lastActive + 1 + hang) * FRAME_SEC]);
  // Merge gaps shorter than minGapSec; drop blips shorter than minSpeechSec.
  const merged: [number, number][] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minGapSec) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged.filter(([s, e]) => e - s >= minSpeechSec).map(([s, e]) => [+s.toFixed(3), +e.toFixed(3)]);
}

export interface DuckingOptions {
  /** How far the music drops under speech, dB (negative). */
  duckDb: number;
  attackSec: number;
  releaseSec: number;
}

export const DEFAULT_DUCKING: DuckingOptions = { duckDb: -12, attackSec: 0.3, releaseSec: 0.8 };

const GAIN = "audio.gainDb";

/** Writes ducking gain keyframes on each music clip for speech regions given in TIMELINE seconds. Replaces earlier gain automation on those clips. */
export function applyDucking(timeline: TimelineModel, musicClipIds: string[], regions: [number, number][], opts: DuckingOptions = DEFAULT_DUCKING): { timeline: TimelineModel; ducked: number } {
  const fps = timeline.frameRate;
  let tl = timeline;
  let ducked = 0;
  for (const id of musicClipIds) {
    const clip0 = tl.clips[id];
    if (!clip0) continue;
    // Resting gain: the clip's level before any earlier automation.
    const keys0 = clip0.animation?.tracks[GAIN]?.keyframes ?? [];
    const base = keys0.length ? keys0[0].value : valueAt(clip0, GAIN, 0, tl.composition);
    for (const k of [...keys0].sort((a, b) => a.frame - b.frame)) tl = removeKeyframe(tl, id, GAIN, k.id);
    const clip = tl.clips[id];
    const s0 = clip.timelineStart;
    const len = clipTimelineEnd(clip) - s0;
    const att = Math.max(1, Math.round(opts.attackSec * fps));
    const rel = Math.max(1, Math.round(opts.releaseSec * fps));
    // Regions in clip-local frames, merged when the release of one would overlap the attack of the next.
    const local: [number, number][] = [];
    for (const [a, b] of regions) {
      const ls = Math.round(a * fps) - s0;
      const le = Math.round(b * fps) - s0;
      if (le <= 0 || ls >= len) continue;
      const last = local[local.length - 1];
      if (last && ls - att <= last[1] + rel) last[1] = Math.max(last[1], le);
      else local.push([ls, le]);
    }
    if (local.length === 0) continue;
    const low = base + opts.duckDb;
    const points = new Map<number, number>();
    const put = (f: number, v: number) => {
      const fr = Math.min(len - 1, Math.max(0, f));
      if (!points.has(fr)) points.set(fr, v);
    };
    for (const [ls, le] of local) {
      put(ls - att, ls - att <= 0 ? low : base);
      put(ls, low);
      put(le, low);
      put(le + rel, le + rel >= len - 1 ? low : base);
    }
    for (const [f, v] of [...points].sort((a, b) => a[0] - b[0])) tl = addKeyframe(tl, id, GAIN, s0 + f, v, { type: "ease-in-out" });
    ducked++;
  }
  return { timeline: tl, ducked };
}
