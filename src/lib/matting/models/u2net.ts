import * as ort from "onnxruntime-web";
import { createInferenceSession, releaseInferenceSession, type RuntimeDevice } from "../../ml/onnx-runtime";
import { downloadModelFileFromUrl } from "../../ml/model-cache";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteOutput, HealthCheckResult } from "../types";

// Bundled at this path (see MODEL_LICENSES.md and public/models/LICENSES/ for
// provenance) — downloaded from https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx,
// an unmodified ONNX export of the official U²-Net "portable" checkpoint
// (~4.5MB, Apache-2.0).
const MODEL_URL = "/models/u2netp.onnx";

// Verified against the real bundled weight: this graph's MaxPool layers use
// ceil_mode=1 (a real architectural detail of U²-Net's encoder), which
// onnxruntime-web's WebGPU backend rejects outright ("using ceil() in shape
// computation is not yet supported for MaxPool" — confirmed live in-browser,
// and a known upstream limitation: microsoft/onnxruntime#20938). WASM has no
// such restriction. Same category of fix as src/lib/upscale/real-esrgan.ts's
// WASM-only pin for its own, different WebGPU incompatibility — pin here too
// rather than let WebGPU-capable browsers hit a hard failure on every image.
const DEVICE: RuntimeDevice = { provider: "wasm", useFp16: false };

// U²-Net's own reference implementation (data_loader.py's RescaleT +
// ToTensorLab(flag=0)) trains/evaluates at a fixed 320x320 input with
// ImageNet mean/std normalization — this must match whatever the actual
// bundled ONNX export expects. Flagged explicitly (MATTE_IMPLEMENTATION_PLAN.md
// section 5/17) as something to verify once a real weight file is chosen:
// some ONNX exports bake normalization into the graph itself, in which case
// this app-side normalization would double-apply and silently corrupt output.
const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "u2net",
  // Salient-object segmentation, not a boundary-refined matting network —
  // see types.ts's ModelClass doc comment and this repo's own warning
  // ("do not use U²-Net as though it were automatically a high-quality
  // alpha matting solution").
  modelClass: "segmentation",
  supportedMedia: ["image"],
  supportedSubjects: ["general", "product"],
  requiredInputs: ["frame"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: INPUT_SIZE, nativeHeight: INPUT_SIZE },
  // WASM only — see DEVICE's doc comment above for the confirmed WebGPU incompatibility.
  deviceSupport: ["wasm"],
  supportsTemporal: false,
  license: {
    id: "Apache-2.0",
    commercialUse: true,
    redistributable: true,
    sourceUrl: "https://github.com/xuebinqin/U-2-Net",
    notes: "Proposed replacement for RMBG-1.4 (non-commercial) in the general/product segmentation role — see MODEL_LICENSES.md.",
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

// PRODUCTION READINESS (C2): exported (only) so this normalization/layout
// math — the exact class of bug ("wrong constant, wrong channel order, wrong
// axis") that can silently corrupt every output while every existing test
// still passes, since no test previously touched real adapter math at all —
// has direct unit coverage. See u2net.test.ts.
export function imageDataToNormalizedTensor(data: Uint8ClampedArray, size: number): ort.Tensor {
  const plane = size * size;
  const floatData = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    floatData[p] = (data[o] / 255 - MEAN[0]) / STD[0];
    floatData[plane + p] = (data[o + 1] / 255 - MEAN[1]) / STD[1];
    floatData[2 * plane + p] = (data[o + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor("float32", floatData, [1, 3, size, size]);
}

/** Matches the reference implementation's normPRED (main.py): min-max normalize the raw saliency map to 0-1 rather than assuming the graph's own output is already well-scaled. */
export function normalizePrediction(data: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - min) / range;
  return out;
}

/**
 * U²-Net wrapper — the Apache-2.0 "swap in for RMBG-1.4" general/product
 * segmentation model (MODEL_LICENSES.md, MATTE_IMPLEMENTATION_PLAN.md Phase
 * 1). Follows real-esrgan.ts's shape: self-hosted ONNX weight, downloaded/
 * cached via model-cache.ts, run through the shared onnx-runtime.ts session
 * creation — pinned to WASM (see DEVICE above) rather than using
 * detectRuntimeDevice()'s usual WebGPU-first behavior.
 */
export class U2NetAdapter implements MattingModel {
  readonly capabilities = CAPABILITIES;
  private session: ort.InferenceSession | null = null;

  isLoaded(): boolean {
    return this.session !== null;
  }

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    // Idempotent: repeated calls (e.g. one per image processed) must not
    // re-download or re-create the session — "models are not repeatedly
    // loaded for every image" (MATTE_IMPLEMENTATION_PLAN.md section 16).
    if (this.session) {
      onProgress?.(1);
      return;
    }
    const bytes = await downloadModelFileFromUrl(MODEL_URL, onProgress);
    this.session = await createInferenceSession(bytes, DEVICE);
  }

  unload(): void {
    if (this.session) releaseInferenceSession(this.session);
    this.session = null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: this.session !== null,
      loaded: this.isLoaded(),
      device: DEVICE.provider,
    };
  }

  async inferImage(input: MatteImageInput): Promise<MatteOutput> {
    if (!this.session) throw new Error("U2NetAdapter: call load() before inferring.");

    const resized = resizeToInputCanvas(input.source, INPUT_SIZE);
    const ctx = resized.getContext("2d", { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const inputTensor = imageDataToNormalizedTensor(data, INPUT_SIZE);

    const outputs = await this.session.run({ [this.session.inputNames[0]]: inputTensor });
    const outTensor = outputs[this.session.outputNames[0]];
    const alpha = normalizePrediction(outTensor.data as Float32Array);
    const dims = outTensor.dims as number[];

    return {
      alpha,
      alphaWidth: dims[dims.length - 1],
      alphaHeight: dims[dims.length - 2],
      producedBy: { modelId: this.capabilities.modelId, modelClass: this.capabilities.modelClass },
    };
  }

  // No inferVideo: U²-Net is a per-image salient-object model with no video-
  // specific handling anywhere in this app yet — running it per-frame would
  // be architecturally straightforward (same shape as inferImage, called in
  // a decode loop) but is explicitly pipeline/integration work deferred to
  // MATTE_IMPLEMENTATION_PLAN.md's Phase 2, not this abstraction-layer phase.
}
