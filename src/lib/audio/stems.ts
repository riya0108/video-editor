import { ort, releaseInferenceSession } from "../ml/onnx-runtime";
import { downloadModelFileFromUrl } from "../ml/model-cache";
import { fft, frameCount, hann, stftRange, yieldToUi } from "./dsp";

/**
 * STEM SEPARATION — splits audio into VOCALS and ACCOMPANIMENT (music) in the browser.
 *
 * Model: Deezer's Spleeter 2-stems (MIT), as the fp16 ONNX export published by the k2-fsa/sherpa-onnx project
 * (Apache-2.0 export code). Weights are downloaded once from Hugging Face, PINNED to a commit and checked against
 * a SHA-256 before use, then kept in the browser's cache (lib/ml/model-cache.ts). See MODEL_LICENSES.md.
 *
 * Spleeter's own pipeline, reproduced here:
 *   44.1 kHz stereo -> STFT (4096-point Hann, hop 1024) -> magnitudes of the lowest 1024 bins (0–11 kHz), in
 *   512-frame (~12 s) segments -> each stem's network estimates that stem's magnitude -> soft (Wiener-style) masks
 *   v²/(v²+a²) applied to the complex spectrum; bins above 11 kHz reuse the average mask of the top band ->
 *   inverse STFT. The two stems sum back to the input.
 */

const REPO = "csukuangfj/sherpa-onnx-spleeter-2stems-fp16";
const REVISION = "93ba771920ade509f8cbd6825b1a90856c797e08";
export const STEM_MODELS = {
  vocals: { file: "vocals.fp16.onnx", sha256: "24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668", bytes: 19_681_017 },
  accompaniment: { file: "accompaniment.fp16.onnx", sha256: "d14cea55793cc531a5875f5f4da08207d1c5ab9292e8e0099a104eecb014fcc0", bytes: 19_681_024 },
} as const;
export const STEM_MODEL_INFO = { name: "Spleeter 2-stems (fp16 ONNX)", license: "MIT (model) / Apache-2.0 (ONNX export)", source: `https://huggingface.co/${REPO}/tree/${REVISION}` };

export const STEM_SAMPLE_RATE = 44100;
const N_FFT = 4096;
const HOP = 1024;
const T = 512;
const F = 1024;
/** Memory guard: separation keeps four full-length output signals in memory. */
export const MAX_STEM_SECONDS = 8 * 60;

const urlFor = (file: string) => `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let sessions: Promise<{ vocals: ort.InferenceSession; accompaniment: ort.InferenceSession }> | null = null;

async function loadSessions(onProgress: (f: number) => void): Promise<{ vocals: ort.InferenceSession; accompaniment: ort.InferenceSession }> {
  const got = { vocals: 0, accompaniment: 0 };
  const total = STEM_MODELS.vocals.bytes + STEM_MODELS.accompaniment.bytes;
  const report = () => onProgress((got.vocals + got.accompaniment) / total);
  const fetchOne = async (k: keyof typeof STEM_MODELS) => {
    const m = STEM_MODELS[k];
    const bytes = await downloadModelFileFromUrl(urlFor(m.file), (f) => {
      got[k] = f * m.bytes;
      report();
    });
    if ((await sha256(bytes)) !== m.sha256) throw new Error(`The downloaded ${k} model doesn't match its published checksum — not using it.`);
    return bytes;
  };
  const [vb, ab] = await Promise.all([fetchOne("vocals"), fetchOne("accompaniment")]);
  // WASM on the main thread (no worker proxy): the proxied session creation was observed to never resolve in
  // Chromium here (for every model, not just this one), while direct creation takes ~0.4 s and each 12 s block
  // runs in ~0.3 s per stem — the pipeline yields between blocks so the UI keeps painting progress.
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
  const create = (bytes: Uint8Array) => ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The separation model didn't start. Reload the page and try again (another AI tool may be holding the runtime).")), 60_000));
  // One at a time: the WASM backend rejects overlapping calls ("Session already started").
  const [vocals, accompaniment] = await Promise.race([(async () => [await create(vb), await create(ab)] as const)(), timeout]);
  return { vocals, accompaniment };
}

/** Frees the models (≈ 40 MB of WASM heap). */
export async function unloadStemModels(): Promise<void> {
  const s = sessions;
  sessions = null;
  if (!s) return;
  const { vocals, accompaniment } = await s.catch(() => ({ vocals: null, accompaniment: null }));
  if (vocals) releaseInferenceSession(vocals);
  if (accompaniment) releaseInferenceSession(accompaniment);
}

export interface StemProgress {
  phase: "downloading" | "separating";
  fraction: number;
}

/** Runs both stem networks on one [2, 1, 512, 1024] magnitude block; returns their [2, 1, 512, 1024] outputs. */
export type StemRunner = (x: Float32Array) => Promise<{ vocals: Float32Array; accompaniment: Float32Array }>;

/**
 * Separates stereo (or mono) audio already at 44.1 kHz. Returns both stems, stereo, same length as the input.
 */
export async function separateStems(input: readonly Float32Array[], onProgress: (p: StemProgress) => void, signal?: AbortSignal): Promise<{ vocals: Float32Array[]; accompaniment: Float32Array[] }> {
  if (input[0].length / STEM_SAMPLE_RATE > MAX_STEM_SECONDS) throw new Error(`Stem separation handles up to ${MAX_STEM_SECONDS / 60} minutes at a time — trim or split the clip first.`);
  onProgress({ phase: "downloading", fraction: 0 });
  sessions ??= loadSessions((f) => onProgress({ phase: "downloading", fraction: f }));
  let models: Awaited<typeof sessions>;
  try {
    models = await sessions;
  } catch (e) {
    sessions = null;
    throw e;
  }
  const runner: StemRunner = async (x) => {
    const feeds = { x: new ort.Tensor("float32", x, [2, 1, T, F]) };
    const vr = await models.vocals.run(feeds);
    const ar = await models.accompaniment.run(feeds);
    return { vocals: vr.y.data as Float32Array, accompaniment: ar.y.data as Float32Array };
  };
  return separateWith(input, runner, (f) => onProgress({ phase: "separating", fraction: f }), signal);
}

/** The model-agnostic pipeline (STFT -> networks -> masks -> inverse STFT); `runner` supplies the networks. */
export async function separateWith(input: readonly Float32Array[], runner: StemRunner, onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ vocals: Float32Array[]; accompaniment: Float32Array[] }> {
  const chans = input.length >= 2 ? [input[0], input[1]] : [input[0], input[0]];
  const length = chans[0].length;
  const frames = frameCount(length, HOP);
  const bins = N_FFT / 2 + 1;
  const win = hann(N_FFT);
  const outLen = length + N_FFT + HOP;
  const vOut = [new Float32Array(outLen), new Float32Array(outLen)];
  const aOut = [new Float32Array(outLen), new Float32Array(outLen)];
  const norm = new Float32Array(outLen);
  const fr = new Float32Array(N_FFT);
  const fi = new Float32Array(N_FFT);
  const eps = 1e-10;

  for (let t0 = 0; t0 < frames; t0 += T) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const t1 = Math.min(frames, t0 + T);
    const specs = chans.map((c) => stftRange(c, N_FFT, HOP, t0, t1));
    const n = t1 - t0;
    const x = new Float32Array(2 * T * F);
    for (let c = 0; c < 2; c++)
      for (let f = 0; f < n; f++)
        for (let k = 0; k < F; k++) {
          const i = f * bins + k;
          x[c * T * F + f * F + k] = Math.hypot(specs[c].re[i], specs[c].im[i]);
        }
    const { vocals: v, accompaniment: a } = await runner(x);

    for (let c = 0; c < 2; c++) {
      const s = specs[c];
      for (let f = 0; f < n; f++) {
        // Soft masks for 0..F; the band above reuses the mean mask of the top 128 bins.
        const mv = new Float32Array(bins);
        let topSum = 0;
        for (let k = 0; k < F; k++) {
          const vv = v[c * T * F + f * F + k] ** 2;
          const aa = a[c * T * F + f * F + k] ** 2;
          mv[k] = (vv + eps / 2) / (vv + aa + eps);
          if (k >= F - 128) topSum += mv[k];
        }
        const ext = topSum / 128;
        for (let k = F; k < bins; k++) mv[k] = ext;
        // Two syntheses (vocals, accompaniment) of this frame.
        for (const [mask, out] of [
          [mv, vOut[c]],
          [null, aOut[c]],
        ] as const) {
          for (let k = 0; k < bins; k++) {
            const m = mask ? mask[k] : 1 - mv[k];
            fr[k] = s.re[f * bins + k] * m;
            fi[k] = s.im[f * bins + k] * m;
          }
          for (let k = 1; k < N_FFT / 2; k++) {
            fr[N_FFT - k] = fr[k];
            fi[N_FFT - k] = -fi[k];
          }
          fft(fr, fi, true);
          const start = (t0 + f) * HOP;
          for (let i = 0; i < N_FFT && start + i < outLen; i++) out[start + i] += (fr[i] / N_FFT) * win[i];
        }
        if (c === 0) {
          const start = (t0 + f) * HOP;
          for (let i = 0; i < N_FFT && start + i < outLen; i++) norm[start + i] += win[i] * win[i];
        }
      }
    }
    onProgress(t1 / frames);
    await yieldToUi();
  }

  const pad = N_FFT / 2;
  const finish = (out: Float32Array) => {
    const y = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const nn = norm[i + pad];
      y[i] = nn > 1e-8 ? out[i + pad] / nn : 0;
    }
    return y;
  };
  return { vocals: vOut.map(finish), accompaniment: aOut.map(finish) };
}

/** High-quality resample to 44.1 kHz with Web Audio (browser only). */
export async function resampleTo44k(channels: readonly Float32Array[], sampleRate: number): Promise<Float32Array[]> {
  if (sampleRate === STEM_SAMPLE_RATE) return [...channels];
  const n = Math.ceil((channels[0].length * STEM_SAMPLE_RATE) / sampleRate);
  const ctx = new OfflineAudioContext(channels.length, n, STEM_SAMPLE_RATE);
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i));
}
