import { requireNonCommercialModels } from "../model-licensing";
import { Tensor } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";
import { createInferenceSession, detectRuntimeDevice, type RuntimeDevice } from "../ml/onnx-runtime";
import { downloadModelFile, downloadModelText } from "../ml/model-cache";
import { calculateRMS, normalizeToInt16 } from "./audio-tensor";

const REPO_ID = "nsarang/F5-TTS-ONNX";
const HOP_LENGTH = 256;
const TARGET_RMS = 0.1;

export interface F5TTSProgress {
  phase: "downloading" | "generating";
  /** 0-1 */
  fraction: number;
  message: string;
}

/**
 * Zero-shot voice cloning TTS, ported from nsarang/voice-cloning-f5-tts (MIT).
 * Runs F5-TTS's three ONNX stages (encoder → iterative transformer denoising
 * → decoder) directly with onnxruntime-web, using @huggingface/transformers's
 * Tensor for the torch-like math the original's vendored "tjs" layer provided
 * (that package is already a dependency here for Whisper captions, so this
 * reuses it instead of vendoring a second copy).
 */
export class F5TTS {
  private sessions: {
    encoder: ort.InferenceSession | null;
    transformer: ort.InferenceSession | null;
    decoder: ort.InferenceSession | null;
  } = { encoder: null, transformer: null, decoder: null };
  private vocabMap: Record<string, number> = {};
  private device: RuntimeDevice = { provider: "wasm", useFp16: false };

  async initialize(onProgress?: (p: F5TTSProgress) => void) {
    requireNonCommercialModels("Voice cloning");
    this.device = await detectRuntimeDevice();
    const transformerFile = this.device.useFp16 ? "onnx/transformer_fp16.onnx" : "onnx/transformer_fp32.onnx";

    const files = ["onnx/encoder_fp32.onnx", transformerFile, "onnx/decoder_fp32.onnx"];
    const progressPerFile = [0, 0, 0];
    const reportDownload = (i: number, fraction: number) => {
      progressPerFile[i] = fraction;
      const total = progressPerFile.reduce((a, b) => a + b, 0) / files.length;
      onProgress?.({ phase: "downloading", fraction: total, message: "Downloading voice model…" });
    };

    const [encoderBytes, transformerBytes, decoderBytes] = await Promise.all(
      files.map((f, i) => downloadModelFile(REPO_ID, f, (frac) => reportDownload(i, frac))),
    );

    this.sessions.encoder = await createInferenceSession(encoderBytes, this.device);
    this.sessions.transformer = await createInferenceSession(transformerBytes, this.device);
    this.sessions.decoder = await createInferenceSession(decoderBytes, this.device);

    const vocabText = await downloadModelText(REPO_ID, "vocab.txt");
    this.vocabMap = {};
    vocabText.split("\n").forEach((char, idx) => {
      const trimmed = char.trim();
      if (trimmed) this.vocabMap[trimmed] = idx;
    });
  }

  private tokenizeText(text: string): number[] {
    return text.split("").map((char) => this.vocabMap[char] ?? 0);
  }

  /** `refAudio` must be a mono Float32Array sampled at 24kHz. */
  async inference({
    refAudio,
    refText,
    genText,
    speed = 1,
    nfeSteps = 16,
    onProgress,
  }: {
    refAudio: Float32Array;
    refText: string;
    genText: string;
    speed?: number;
    nfeSteps?: number;
    onProgress?: (p: F5TTSProgress) => void;
  }): Promise<Float32Array> {
    const { encoder, transformer, decoder } = this.sessions;
    if (!encoder || !transformer || !decoder) throw new Error("Voice model not loaded");

    let refTensor = new Tensor("float32", refAudio, [refAudio.length]);
    const refRMS = calculateRMS(refTensor);
    if (refRMS < TARGET_RMS) {
      refTensor = refTensor.div(refRMS * TARGET_RMS);
    }
    const audioTensor = normalizeToInt16(refTensor).view(1, 1, -1);

    const combinedText = `${refText} ${genText}`;
    const textTokens = this.tokenizeText(combinedText);
    const textTensor = new Tensor("int32", Int32Array.from(textTokens), [1, textTokens.length]);

    const refAudioLen = Math.trunc(refAudio.length / HOP_LENGTH);
    const duration =
      refAudioLen + Math.trunc(((refAudioLen / (refText.length + 1)) * genText.length) / speed);
    const durationTensor = new Tensor("int64", new BigInt64Array([BigInt(duration)]), [1]);

    const preprocessOutputs = await encoder.run({
      [encoder.inputNames[0]]: audioTensor.ort_tensor,
      [encoder.inputNames[1]]: textTensor.ort_tensor,
      [encoder.inputNames[2]]: durationTensor.ort_tensor,
    });

    let noise = new Tensor(preprocessOutputs[encoder.outputNames[0]]);
    let ropeCosQ = new Tensor(preprocessOutputs[encoder.outputNames[1]]);
    let ropeSinQ = new Tensor(preprocessOutputs[encoder.outputNames[2]]);
    let ropeCosK = new Tensor(preprocessOutputs[encoder.outputNames[3]]);
    let ropeSinK = new Tensor(preprocessOutputs[encoder.outputNames[4]]);
    let catMelText = new Tensor(preprocessOutputs[encoder.outputNames[5]]);
    let catMelTextDrop = new Tensor(preprocessOutputs[encoder.outputNames[6]]);
    const refSignalLen = preprocessOutputs[encoder.outputNames[7]];

    let timeStep: ort.Tensor = new ort.Tensor("int32", new Int32Array([0]), [1]);

    if (this.device.useFp16) {
      noise = noise.to("float16");
      ropeCosQ = ropeCosQ.to("float16");
      ropeSinQ = ropeSinQ.to("float16");
      ropeCosK = ropeCosK.to("float16");
      ropeSinK = ropeSinK.to("float16");
      catMelText = catMelText.to("float16");
      catMelTextDrop = catMelTextDrop.to("float16");
    }

    for (let step = 0; step < nfeSteps - 1; step++) {
      const transformerOutputs = await transformer.run({
        [transformer.inputNames[0]]: noise.ort_tensor,
        [transformer.inputNames[1]]: ropeCosQ.ort_tensor,
        [transformer.inputNames[2]]: ropeSinQ.ort_tensor,
        [transformer.inputNames[3]]: ropeCosK.ort_tensor,
        [transformer.inputNames[4]]: ropeSinK.ort_tensor,
        [transformer.inputNames[5]]: catMelText.ort_tensor,
        [transformer.inputNames[6]]: catMelTextDrop.ort_tensor,
        [transformer.inputNames[7]]: timeStep,
      });
      noise = new Tensor(transformerOutputs[transformer.outputNames[0]]);
      timeStep = transformerOutputs[transformer.outputNames[1]];

      onProgress?.({
        phase: "generating",
        fraction: (step + 1) / nfeSteps,
        message: `Generating speech… step ${step + 1}/${nfeSteps}`,
      });
    }

    if (this.device.useFp16) {
      noise = noise.to("float32");
    }

    const decodeOutputs = await decoder.run({
      [decoder.inputNames[0]]: noise.ort_tensor,
      [decoder.inputNames[1]]: refSignalLen,
    });
    const generatedSignal = new Tensor(decodeOutputs[decoder.outputNames[0]]);

    let normalized = generatedSignal.to("float32").div(32767).view(-1);
    if (refRMS < TARGET_RMS) {
      normalized = normalized.mul(refRMS / TARGET_RMS);
    }

    return normalized.data as Float32Array;
  }

  dispose() {
    for (const key of Object.keys(this.sessions) as (keyof typeof this.sessions)[]) {
      this.sessions[key]?.release().catch(() => {});
      this.sessions[key] = null;
    }
  }
}
