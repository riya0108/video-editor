import * as ort from "onnxruntime-web";
import { createInferenceSession, detectRuntimeDevice, releaseInferenceSession, type RuntimeDevice } from "../../ml/onnx-runtime";
import { downloadModelFileFromUrl } from "../../ml/model-cache";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteOutput, HealthCheckResult } from "../types";

// Not yet bundled — see u2net.ts's identical note and MATTE_IMPLEMENTATION_PLAN.md
// Phase 1 scope. This is a real implementation that will 404 until the
// actual weight lands here in a later phase.
const MODEL_URL = "/models/modnet.onnx";

// MODNet is fully convolutional (no fixed input size), but its own
// reference demo (demo.py) resizes so the longer side is a fixed reference
// length and both dims are multiples of 32, then normalizes to [-1,1] via
// (x - 0.5) / 0.5 per channel. A single fixed square size is used here for
// simplicity in this phase's adapter — revisit against MODNet's own
// resize-to-multiple-of-32 logic before treating this as final (flagged in
// MATTE_IMPLEMENTATION_PLAN.md section 5/17, same category of risk as
// u2net.ts's normalization note).
const INPUT_SIZE = 512;

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "modnet",
  // Trained specifically for portrait matting with boundary-aware
  // supervision — a real "matting"-class model, not just segmentation.
  modelClass: "matting",
  supportedMedia: ["image"],
  supportedSubjects: ["portrait"],
  requiredInputs: ["frame"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: INPUT_SIZE, nativeHeight: INPUT_SIZE, maxWidth: 2048, maxHeight: 2048 },
  deviceSupport: ["webgpu", "wasm"],
  supportsTemporal: false,
  license: {
    id: "Apache-2.0",
    commercialUse: true,
    redistributable: true,
    sourceUrl: "https://github.com/ZHKKKe/MODNet",
    notes:
      "Repo + released checkpoints are Apache-2.0 per MODEL_LICENSES.md. Re-verify the specific checkpoint file's provenance before bundling — several third-party re-uploads exist with unclear chain of custody.",
  },
};

function resizeToInputCanvas(source: CanvasImageSource, size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, size, size);
  return canvas;
}

/** MODNet's own preprocessing: scale to 0-1, then (x - 0.5) / 0.5 per channel, i.e. maps into [-1, 1]. */
function imageDataToNormalizedTensor(data: Uint8ClampedArray, size: number): ort.Tensor {
  const plane = size * size;
  const floatData = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    floatData[p] = (data[o] / 255 - 0.5) / 0.5;
    floatData[plane + p] = (data[o + 1] / 255 - 0.5) / 0.5;
    floatData[2 * plane + p] = (data[o + 2] / 255 - 0.5) / 0.5;
  }
  return new ort.Tensor("float32", floatData, [1, 3, size, size]);
}

/**
 * MODNet wrapper — portrait matting, Apache-2.0. Follows the same shape as
 * u2net.ts/real-esrgan.ts: self-hosted weight via model-cache.ts, shared
 * onnx-runtime.ts device detection.
 */
export class ModNetAdapter implements MattingModel {
  readonly capabilities = CAPABILITIES;
  private session: ort.InferenceSession | null = null;
  private device: RuntimeDevice | null = null;

  isLoaded(): boolean {
    return this.session !== null;
  }

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    // Idempotent — see u2net.ts's identical note.
    if (this.session) {
      onProgress?.(1);
      return;
    }
    const bytes = await downloadModelFileFromUrl(MODEL_URL, onProgress);
    this.device = await detectRuntimeDevice();
    this.session = await createInferenceSession(bytes, this.device);
  }

  unload(): void {
    if (this.session) releaseInferenceSession(this.session);
    this.session = null;
    this.device = null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: this.session !== null,
      loaded: this.isLoaded(),
      device: this.device?.provider,
    };
  }

  async inferImage(input: MatteImageInput): Promise<MatteOutput> {
    if (!this.session) throw new Error("ModNetAdapter: call load() before inferring.");

    const resized = resizeToInputCanvas(input.source, INPUT_SIZE);
    const ctx = resized.getContext("2d", { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const inputTensor = imageDataToNormalizedTensor(data, INPUT_SIZE);

    const outputs = await this.session.run({ [this.session.inputNames[0]]: inputTensor });
    const outTensor = outputs[this.session.outputNames[0]];
    const dims = outTensor.dims as number[];

    return {
      alpha: outTensor.data as Float32Array,
      alphaWidth: dims[dims.length - 1],
      alphaHeight: dims[dims.length - 2],
      producedBy: { modelId: this.capabilities.modelId, modelClass: this.capabilities.modelClass },
    };
  }

  // No inferVideo: MODNet is a still-image model. A "MODNet-V"-style
  // per-frame-plus-smoothing video path is exactly what
  // MATTE_IMPLEMENTATION_PLAN.md section 6.2/6.3 proposes building — as
  // pipeline orchestration on top of this adapter's inferImage, not as a
  // capability this adapter itself needs to claim.
}
