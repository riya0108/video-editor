import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { separateWith, STEM_MODELS } from "./stems";

/**
 * REAL-MODEL EVAL (skipped unless STEMS_MODEL_DIR points at the downloaded Spleeter ONNX files and STEMS_SPEECH at
 * 44.1 kHz stereo f32le speech): mixes real speech with synthetic music and checks that each stem recovers its own
 * source — a measured separation number, not a listening impression.
 */
const dir = process.env.STEMS_MODEL_DIR;
const speechPath = process.env.STEMS_SPEECH;

describe.skipIf(!dir || !speechPath)("stem separation (real Spleeter model)", () => {
  it("puts the speech in the vocals stem and the music in the accompaniment stem", async () => {
    const ort = createRequire(import.meta.url)("onnxruntime-node");
    const [vs, as] = await Promise.all([ort.InferenceSession.create(`${dir}/${STEM_MODELS.vocals.file}`), ort.InferenceSession.create(`${dir}/${STEM_MODELS.accompaniment.file}`)]);
    const raw = new Float32Array(readFileSync(speechPath!).buffer.slice(0));
    const n = raw.length / 2;
    const speech = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      speech[0][i] = raw[2 * i];
      speech[1][i] = raw[2 * i + 1];
    }
    // Music: a sustained chord with a kick drum every 0.5 s.
    const sr = 44100;
    const music = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const chord = [220, 277.18, 329.63, 440].reduce((s, f) => s + Math.sin(2 * Math.PI * f * t) * 0.05, 0);
      const k = (t % 0.5) / 0.5;
      const kick = Math.exp(-k * 30) * Math.sin(2 * Math.PI * 60 * t) * 0.4;
      music[0][i] = music[1][i] = chord + kick;
    }
    const mix = [0, 1].map((c) => speech[c].map((v, i) => v + music[c][i]));
    const out = await separateWith(
      mix,
      async (x) => {
        const feeds = { x: new ort.Tensor("float32", x, [2, 1, 512, 1024]) };
        const [v, a] = await Promise.all([vs.run(feeds), as.run(feeds)]);
        return { vocals: v.y.data as Float32Array, accompaniment: a.y.data as Float32Array };
      },
      () => {},
    );
    // SDR-style improvement: how much closer each stem is to its true source than the raw mix is.
    const sdr = (est: Float32Array, ref: Float32Array) => {
      let num = 0;
      let den = 0;
      for (let i = 0; i < ref.length; i++) {
        num += ref[i] ** 2;
        den += (ref[i] - est[i]) ** 2;
      }
      return 10 * Math.log10(num / Math.max(1e-12, den));
    };
    const vocalsGain = sdr(out.vocals[0], speech[0]) - sdr(mix[0], speech[0]);
    const musicGain = sdr(out.accompaniment[0], music[0]) - sdr(mix[0], music[0]);
    console.log(`SDR improvement — vocals: ${vocalsGain.toFixed(1)} dB, accompaniment: ${musicGain.toFixed(1)} dB`);
    expect(vocalsGain).toBeGreaterThan(3);
    expect(musicGain).toBeGreaterThan(3);
    // Stems sum back to the mix.
    let err = 0;
    for (let i = 4096; i < n - 4096; i++) err = Math.max(err, Math.abs(out.vocals[0][i] + out.accompaniment[0][i] - mix[0][i]));
    expect(err).toBeLessThan(1e-3);
  }, 120_000);
});
