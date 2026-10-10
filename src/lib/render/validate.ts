import type { RenderPlan } from "./plan";
import type { CrossCheckIssue } from "./graph";

/**
 * RENDER VALIDATION (RENDER_ENGINE_ARCHITECTURE.md §8) — pure checks over what the encoded file actually contains
 * (read back by `probe.ts`), what the renderer drew, and the structural cross-check. A render is only reported as
 * successful when every check passes.
 */

export interface ProbedOutput {
  mimeType: string;
  /** Container the demuxer recognised (e.g. "MP4", "QuickTime File Format", "WebM") and its MIME type. */
  container?: string;
  containerMime?: string;
  video: null | {
    codec: string | null;
    width: number;
    height: number;
    frameCount: number;
    /** Presentation timestamps of every frame, seconds, ascending. */
    timestamps: number[];
    durationSec: number;
    /** Sum of every packet's size (bitrate = bytes × 8 / duration). */
    bytes?: number;
    canBeTransparent?: boolean;
  };
  audio: null | { codec: string | null; sampleRate: number; channels: number; durationSec: number; bytes?: number; /** End of the DECODED audio (what a player outputs), when it was decoded. */ decodedSec?: number };
}

export const CONTAINER_MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/** Average bitrate may exceed the target by this factor before the check fails (keyframes on short clips, VBR peaks). */
export const MAX_BITRATE_OVERSHOOT = 1.5;

export interface RenderCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * `encoded` = the codecs the job configured (an explicit request in the plan must equal them; the file must contain
 * them). Omitted (older callers): codecs are only checked against an explicit request.
 */
export function technicalChecks(plan: RenderPlan, p: ProbedOutput, encoded?: { video: string; audio: string | null }): RenderCheck[] {
  const s = plan.settings;
  const checks: RenderCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
  const container = s.container ?? "mp4";
  if (p.containerMime !== undefined) {
    add("container", "Container", p.containerMime === CONTAINER_MIME[container], `${p.container ?? "unknown"} (${p.containerMime}; expected ${CONTAINER_MIME[container]})`);
  }
  const v = p.video;
  add("video-track", "Video track", !!v, v ? `${v.codec ?? "unknown codec"}` : "No video track in the output.");
  const wantVideo = s.videoCodec ?? encoded?.video;
  if (v && wantVideo) add("video-codec", "Video codec", v.codec === wantVideo, `${v.codec ?? "unknown"} (expected ${wantVideo})`);
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
    if (v.bytes !== undefined) {
      const bps = (v.bytes * 8) / plan.durationSec;
      const cap = s.videoBitrate * MAX_BITRATE_OVERSHOOT;
      add("bitrate", "Video bitrate", v.bytes > 0 && bps <= cap, `${(bps / 1e6).toFixed(2)} Mbit/s average (target ${(s.videoBitrate / 1e6).toFixed(2)} Mbit/s ${s.bitrateMode === "constant" ? "CBR" : "VBR"}, limit ${(cap / 1e6).toFixed(2)})`);
    }
    if (!s.alpha && v.canBeTransparent !== undefined) add("alpha", "No alpha channel", !v.canBeTransparent, v.canBeTransparent ? "The video track carries alpha although none was requested." : "Opaque video, as requested.");
  }
  if (s.audio) {
    const a = p.audio;
    add("audio-track", "Audio track", !!a, a ? `${a.codec ?? "unknown codec"}, ${a.sampleRate} Hz, ${a.channels} ch` : "Expected an audio track; the output has none.");
    if (a) {
      const kbps = a.bytes !== undefined && a.durationSec > 0 ? ` · ${((a.bytes * 8) / a.durationSec / 1000).toFixed(0)} kbit/s measured (target ${s.audio.bitrate / 1000})` : "";
      add("audio-codec", "Audio codec", a.codec === s.audio.codec, `${a.codec ?? "unknown"} (expected ${s.audio.codec})${kbps}`);
      add("audio-format", "Audio format", a.sampleRate === s.audio.sampleRate && a.channels === s.audio.channels, `${a.sampleRate} Hz / ${a.channels} ch (expected ${s.audio.sampleRate} / ${s.audio.channels})`);
      // The audio is trimmed to the video's end with sample precision (job.ts encodeAudioExact): 1 ms covers container
      // timescale rounding. WebM can't trim a packet's tail (Mediabunny writes no DiscardPadding), so there the last
      // Opus frame may run past the video by less than one frame (20 ms) of encoder-padding silence — never short.
      const tol = 1e-3;
      const over = container === "webm" ? audioFrameSec(s.audio.codec) : 0;
      // Decoded end, bounded by the container's presentation end: Mediabunny's decoder doesn't stop at an MP4/MOV edit
      // list's end (it decoded 4.0093 s where ffmpeg plays exactly 4.0000 s), players do. Short audio is still caught.
      const d = a.decodedSec !== undefined ? Math.min(a.decodedSec, a.durationSec) : a.durationSec;
      const ok = d >= plan.durationSec - tol && d <= plan.durationSec + over + tol;
      add("audio-duration", "Audio duration", ok, `${d.toFixed(4)} s ${a.decodedSec !== undefined ? "decoded" : "(container)"} vs. video ${plan.durationSec.toFixed(4)} s (allowed ${over ? `−1 ms … +${(over * 1000 + 1).toFixed(0)} ms, WebM can't trim the last packet` : "±1 ms"})`);
    }
  } else {
    add("audio-track", "Audio track", !p.audio, p.audio ? "The output has an audio track although none was rendered." : "None (the timeline has no audible clip).");
  }
  return checks;
}

/** Length of one encoded audio frame (Opus as encoded by WebCodecs: 20 ms; AAC: 1024 samples at 48 kHz). */
export function audioFrameSec(codec: string): number {
  return codec === "opus" ? 0.02 : 1024 / 48000;
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

/** PSNR of the alpha channels of two same-size RGBA buffers, dB. Identical -> Infinity. */
export function alphaPsnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) throw new Error("alphaPsnr: size mismatch");
  let se = 0;
  for (let i = 3; i < a.length; i += 4) {
    const d = a[i] - b[i];
    se += d * d;
  }
  const mse = se / Math.max(1, a.length / 4);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/** Alpha output: the track must be marked transparent, and the decoded alpha of every checkpoint must match the render's. */
export function alphaCheck(p: ProbedOutput, results: { frame: number; psnr: number }[], min = MIN_FIDELITY_PSNR): RenderCheck {
  const worst = results.reduce((w, r) => (r.psnr < w.psnr ? r : w), { frame: -1, psnr: Infinity });
  const marked = !!p.video?.canBeTransparent;
  const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} dB` : "identical");
  return {
    id: "alpha",
    label: "Alpha channel",
    ok: marked && results.length > 0 && worst.psnr >= min,
    detail: !marked ? "The video track isn't marked as transparent: the alpha channel was lost." : results.length === 0 ? "No frames compared." : `track transparent; decoded alpha of ${results.length} checkpoint frames, worst ${fmt(worst.psnr)} at frame ${worst.frame} (minimum ${min} dB)`,
  };
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

/**
 * Floor for a CODEC-LIMITED checkpoint (Phase 20, P1-1): content whose fine detail no lossy codec keeps — the Dissolve
 * transition's per-pixel dither, heavy grain — decodes 21–26 dB from its render even at 40 Mbit/s although the right
 * frame was encoded. Such a frame passes when it is at least this close AND matches its own render at least as well
 * as the renders of the frames either side of it (a shifted or wrong frame matches a neighbour better). Measured: correct
 * dither-dissolve frames 22–23 dB and best-matching; shifted frames lose to their neighbour; black/garbage < 15 dB.
 */
export const CODEC_LIMITED_MIN_PSNR = 20;

export interface FidelityResult {
  frame: number;
  /** Decoded frame vs its own render. */
  psnr: number;
  /** Decoded frame vs the closer of the renders of frames k-1 / k+1 (absent at a timeline edge with no neighbour captured). */
  neighborPsnr?: number;
}

/**
 * `expected`: how many checkpoints should have been compared; fewer (e.g. decoding broke off) fails the check.
 * Every checkpoint must reach `min`, or be codec-limited (see CODEC_LIMITED_MIN_PSNR); and at least half must reach
 * `min` outright, so a global problem (wrong colour matrix, a starved bitrate) can't pass as "codec-limited".
 */
export function fidelityCheck(results: FidelityResult[], min = MIN_FIDELITY_PSNR, expected = results.length): RenderCheck {
  const worst = results.reduce((w, r) => (r.psnr < w.psnr ? r : w), { frame: -1, psnr: Infinity } as FidelityResult);
  const fmt = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} dB` : "identical");
  const clean = results.filter((r) => r.psnr >= min);
  const limited = results.filter((r) => r.psnr < min && r.psnr >= CODEC_LIMITED_MIN_PSNR && r.neighborPsnr !== undefined && r.psnr >= r.neighborPsnr);
  const bad = results.filter((r) => r.psnr < min && !limited.includes(r));
  const ok = results.length > 0 && results.length >= expected && bad.length === 0 && clean.length * 2 >= results.length;
  let detail = results.length === 0 ? "No frames compared." : `${results.length}${results.length < expected ? ` of ${expected}` : ""} checkpoint frames, worst ${fmt(worst.psnr)} at frame ${worst.frame} (minimum ${min} dB)`;
  if (results.length > 0 && limited.length > 0) detail += `; ${limited.length} high-detail frame(s) below ${min} dB (lowest ${fmt(Math.min(...limited.map((r) => r.psnr)))}) still match their own frame best — codec-limited detail such as a dither dissolve or grain, not a wrong frame`;
  if (bad.length > 0) {
    const b = bad[0];
    detail += `; frame ${b.frame} ${b.psnr < CODEC_LIMITED_MIN_PSNR ? `is only ${fmt(b.psnr)}` : `matches a neighbouring frame better (${fmt(b.neighborPsnr ?? NaN)}) than itself`}`;
  } else if (results.length > 0 && clean.length * 2 < results.length) detail += `; only ${clean.length} of ${results.length} reach ${min} dB`;
  return { id: "fidelity", label: "Encoded frames match the render", ok, detail };
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
/**
 * The loudest `windowSec` window of `reference` (searched on a grid of window/4), where measureLag correlates. Returned
 * with the grid step so a caller can cut a slice that starts ON the grid (see lagSlice) and get identical results.
 */
export function loudestWindow(reference: Float32Array, sampleRate: number, windowSec = 1): { start: number; win: number; step: number; energy: number } {
  const win = Math.min(reference.length, Math.round(windowSec * sampleRate));
  const step = Math.max(1, win >> 2);
  let start = 0;
  let best = -1;
  for (let s = 0; s + win <= reference.length; s += step) {
    let e = 0;
    for (let i = s; i < s + win; i += 4) e += reference[i] * reference[i];
    if (e > best) {
      best = e;
      start = s;
    }
  }
  return { start, win, step, energy: best };
}

/**
 * The sample range [from, to) that measureLag actually reads for this reference: from the loudest window, a whole
 * second plus the maximum lag either side, starting on the window grid. measureLag over just this range of the mix and
 * of the decoded audio returns exactly what it returns over the whole signals — so an export's sync check needs one
 * second of decoded audio, not the full track (Phase 20, P1-2: memory on long exports).
 */
export function lagSlice(reference: Float32Array, sampleRate: number, maxLagSamples = 8192, windowSec = 1): { from: number; to: number } {
  const { start, win, step } = loudestWindow(reference, sampleRate, windowSec);
  const margin = maxLagSamples + 64 + sampleRate;
  const from = Math.max(0, start - Math.ceil(margin / step) * step);
  const to = Math.min(reference.length, start + win + margin);
  return { from, to };
}

export function measureLag(reference: Float32Array, decoded: Float32Array, sampleRate: number, maxLagSamples = 8192, windowSec = 1): { lag: number; corr: number; silent: boolean } {
  const { start, win, energy: best } = loudestWindow(reference, sampleRate, windowSec);
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
