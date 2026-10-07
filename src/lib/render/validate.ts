import type { RenderPlan } from "./plan";
import type { CrossCheckIssue } from "./graph";

/**
 * RENDER VALIDATION (RENDER_ENGINE_ARCHITECTURE.md §8) — pure checks over what the encoded file actually contains
 * (read back by `probe.ts`), what the renderer drew, and the structural cross-check. A render is only reported as
 * successful when every check passes.
 */

export interface ProbedOutput {
  mimeType: string;
  video: null | {
    codec: string | null;
    width: number;
    height: number;
    frameCount: number;
    /** Presentation timestamps of every frame, seconds, ascending. */
    timestamps: number[];
    durationSec: number;
  };
  audio: null | { codec: string | null; sampleRate: number; channels: number; durationSec: number };
}

export interface RenderCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export function technicalChecks(plan: RenderPlan, p: ProbedOutput): RenderCheck[] {
  const s = plan.settings;
  const checks: RenderCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
  const v = p.video;
  add("video-track", "Video track", !!v, v ? `${v.codec ?? "unknown codec"}` : "No video track in the output.");
  if (v) {
    add("resolution", "Resolution", v.width === s.width && v.height === s.height, `${v.width}×${v.height} (expected ${s.width}×${s.height})`);
    add("frame-count", "Frame count", v.frameCount === plan.frameCount, `${v.frameCount} frames (expected ${plan.frameCount})`);
    const ts = v.timestamps;
    let worst = 0;
    for (let i = 0; i < ts.length; i++) worst = Math.max(worst, Math.abs(ts[i] - i / s.fps));
    // Container timescales round timestamps; anything under a tenth of a frame is the same frame grid.
    const onGrid = ts.length === plan.frameCount && worst < 0.1 / s.fps;
    add("fps", "Frame rate", onGrid, `${ts.length > 1 ? ((ts.length - 1) / (ts[ts.length - 1] - ts[0])).toFixed(3) : "—"} fps, every frame within ${(worst * 1000).toFixed(3)} ms of the ${s.fps} fps grid`);
    add("duration", "Duration", Math.abs(v.durationSec - plan.durationSec) < 0.5 / s.fps, `${v.durationSec.toFixed(4)} s (expected ${plan.durationSec.toFixed(4)} s)`);
  }
  if (s.audio) {
    const a = p.audio;
    add("audio-track", "Audio track", !!a, a ? `${a.codec ?? "unknown codec"}, ${a.sampleRate} Hz, ${a.channels} ch` : "Expected an audio track; the output has none.");
    if (a) {
      add("audio-format", "Audio format", a.sampleRate === s.audio.sampleRate && a.channels === s.audio.channels, `${a.sampleRate} Hz / ${a.channels} ch (expected ${s.audio.sampleRate} / ${s.audio.channels})`);
      // The audio is trimmed to the video's end with sample precision (job.ts encodeAudioExact): 1 ms covers container timescale rounding.
      const tol = 1e-3;
      add("audio-duration", "Audio duration", Math.abs(a.durationSec - plan.durationSec) <= tol, `${a.durationSec.toFixed(4)} s vs. video ${plan.durationSec.toFixed(4)} s (tolerance 1 ms)`);
    }
  } else {
    add("audio-track", "Audio track", !p.audio, p.audio ? "The output has an audio track although none was rendered." : "None (the timeline has no audible clip).");
  }
  return checks;
}

/** PSNR over RGB of two same-size RGBA buffers (alpha ignored), dB. Identical -> Infinity. */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) throw new Error("psnr: size mismatch");
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      se += d * d;
    }
    n += 3;
  }
  const mse = se / Math.max(1, n);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/** Composites RGBA over opaque black in place — what an opaque (no-alpha) encode of it shows. */
export function flattenOverBlack(rgba: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    rgba[i] = Math.round(rgba[i] * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * a);
    rgba[i + 3] = 255;
  }
  return rgba;
}

/** Minimum PSNR between a rendered frame and the same frame decoded from the file. H.264 at the default bitrate measures well above this; a wrong, shifted or missing frame measures far below. */
export const MIN_FIDELITY_PSNR = 30;

export function fidelityCheck(results: { frame: number; psnr: number }[], min = MIN_FIDELITY_PSNR): RenderCheck {
  const worst = results.reduce((w, r) => (r.psnr < w.psnr ? r : w), { frame: -1, psnr: Infinity });
  const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} dB` : "identical");
  return {
    id: "fidelity",
    label: "Encoded frames match the render",
    ok: results.length > 0 && worst.psnr >= min,
    detail: results.length === 0 ? "No frames compared." : `${results.length} checkpoint frames, worst ${fmt(worst.psnr)} at frame ${worst.frame} (minimum ${min} dB)`,
  };
}

export function structureCheck(issues: { frame: number; issues: CrossCheckIssue[] }[], framesChecked: number): RenderCheck {
  const all = issues.flatMap((f) => f.issues.map((i) => ({ frame: f.frame, ...i })));
  const byKind = new Map<string, number>();
  for (const i of all) byKind.set(i.check, (byKind.get(i.check) ?? 0) + 1);
  return {
    id: "structure",
    label: "Layers, effects, masks, mattes, keyframes, transitions, text",
    ok: all.length === 0,
    detail: all.length === 0 ? `${framesChecked} frames cross-checked against the timeline, no disagreement` : `${all.length} issue(s): ${[...byKind].map(([k, n]) => `${k} ×${n}`).join(", ")}. First: frame ${all[0].frame} — ${all[0].message}`,
  };
}

export interface RenderReport {
  ok: boolean;
  checks: RenderCheck[];
  warnings: string[];
  codec: string;
  bytes: number;
  renderMs: number;
  frameCount: number;
  durationSec: number;
}

/**
 * Offset of `decoded` relative to `reference` (samples; positive = decoded is late) by normalized cross-correlation
 * over the most energetic `windowSec` of the reference. Coarse stage: amplitude ENVELOPES (mean |x| per 8-sample
 * block, zero-mean) — smooth, so a sub-block shift can't hide the peak the way plain decimation of wideband audio
 * does. Fine stage: raw samples, ±24 around the coarse lag. `corr` is the raw normalized correlation at the best lag.
 */
export function measureLag(reference: Float32Array, decoded: Float32Array, sampleRate: number, maxLagSamples = 8192, windowSec = 1): { lag: number; corr: number; silent: boolean } {
  const win = Math.min(reference.length, Math.round(windowSec * sampleRate));
  let start = 0;
  let best = -1;
  for (let s = 0; s + win <= reference.length; s += Math.max(1, win >> 2)) {
    let e = 0;
    for (let i = s; i < s + win; i += 4) e += reference[i] * reference[i];
    if (e > best) {
      best = e;
      start = s;
    }
  }
  if (!(best > 1e-6)) return { lag: 0, corr: 0, silent: true };
  const B = 8;
  const envelope = (x: Float32Array) => {
    const out = new Float32Array(Math.ceil(x.length / B));
    for (let k = 0; k < out.length; k++) {
      let s = 0;
      for (let i = k * B; i < Math.min(x.length, (k + 1) * B); i++) s += Math.abs(x[i]);
      out[k] = s / B;
    }
    return out;
  };
  const ncc = (a: Float32Array, b: Float32Array, from: number, len: number, lag: number, zeroMean: boolean) => {
    let ma = 0;
    let mb = 0;
    if (zeroMean) {
      for (let i = from; i < from + len; i++) {
        ma += a[i];
        const j = i + lag;
        mb += j >= 0 && j < b.length ? b[j] : 0;
      }
      ma /= len;
      mb /= len;
    }
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = from; i < from + len; i++) {
      const j = i + lag;
      const x = a[i] - ma;
      const y = (j >= 0 && j < b.length ? b[j] : 0) - mb;
      dot += x * y;
      ea += x * x;
      eb += y * y;
    }
    return ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0;
  };
  const ea = envelope(reference);
  const eb = envelope(decoded);
  const k0 = Math.floor(start / B);
  const kl = Math.max(1, Math.floor(win / B));
  let coarse = 0;
  let c = -Infinity;
  for (let l = -Math.ceil(maxLagSamples / B); l <= Math.ceil(maxLagSamples / B); l++) {
    const v = ncc(ea, eb, k0, kl, l, true);
    if (v > c) {
      c = v;
      coarse = l * B;
    }
  }
  let lag = coarse;
  c = -Infinity;
  for (let l = coarse - 24; l <= coarse + 24; l++) {
    const v = ncc(reference, decoded, start, win, l, false);
    if (v > c) {
      c = v;
      lag = l;
    }
  }
  return { lag, corr: c, silent: false };
}

/** A/V sync: the decoded audio must line up with the mix to within 1 ms and have the mix's shape. */
export function audioSyncCheck(m: { lag: number; corr: number; silent: boolean }, sampleRate: number): RenderCheck {
  if (m.silent) return { id: "audio-sync", label: "Audio in sync", ok: true, detail: "The mix is silent — nothing to align." };
  const ms = (m.lag / sampleRate) * 1000;
  const ok = Math.abs(ms) <= 1 && m.corr >= 0.9;
  return { id: "audio-sync", label: "Audio in sync", ok, detail: `decoded audio ${ms >= 0 ? "+" : ""}${ms.toFixed(2)} ms vs. the mix (limit ±1 ms), correlation ${m.corr.toFixed(3)} (minimum 0.9)` };
}
