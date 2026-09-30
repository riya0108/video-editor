import * as ort from "onnxruntime-web";
import { createInferenceSession, detectRuntimeDevice, releaseInferenceSession, type RuntimeDevice } from "../../ml/onnx-runtime";
import { downloadModelFileFromUrl } from "../../ml/model-cache";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteOutput, HealthCheckResult } from "../types";

// Not yet bundled — see modnet.ts/u2net.ts's identical note. This adapter
// exists to prove the abstraction handles a two-input, known-background
// model correctly (MATTE_IMPLEMENTATION_PLAN.md section 4's "known static
// background -> background-matting-capable model" routing rule); it is not
// expected to be exercised in Phase 1, since this app's single-clip upload
// flow essentially never provides a clean background plate (see
// MATTE_IMPLEMENTATION_PLAN.md section 21's known limitations).
const MODEL_URL = "/models/background-matting-v2.onnx";
const INPUT_SIZE = 512;

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "background-matting-v2",
  modelClass: "matting",
  supportedMedia: ["image"],
  supportedSubjects: ["known-background"],
  // The defining trait of this model versus every other adapter in this
  // phase: it needs a second image (the empty background plate), not just
  // the subject frame — router.ts's isEligible treats this as a hard
  // requirement, not a preference.
  requiredInputs: ["frame", "background-plate"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: INPUT_SIZE, nativeHeight: INPUT_SIZE, maxWidth: 4096, maxHeight: 4096 },
  deviceSupport: ["webgpu", "wasm"],
  supportsTemporal: false,
  license: {
    id: "MIT",
    commercialUse: true,
    redistributable: true,
    sourceUrl: "https://github.com/PeterL1n/BackgroundMattingV2",
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

/** BackgroundMattingV2's reference implementation feeds raw 0-1 RGB (no ImageNet mean/std) for both the source and background-plate inputs. */
function imageDataToTensor(data: Uint8ClampedArray, size: number): ort.Tensor {
  const plane = size * size;
  const floatData = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const o = p * 4;
    floatData[p] = data[o] / 255;
    floatData[plane + p] = data[o + 1] / 255;
    floatData[2 * plane + p] = data[o + 2] / 255;
  }
  return new ort.Tensor("float32", floatData, [1, 3, size, size]);
}

/**
 * BackgroundMattingV2 wrapper — the only adapter in this phase that
 * requires a captured background plate (see requiredInputs above). MIT
 * licensed. Follows the same session-loading shape as modnet.ts/u2net.ts.
 */
export class BackgroundMattingV2Adapter implements MattingModel {
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
    if (!this.session) throw new Error("BackgroundMattingV2Adapter: call load() before inferring.");
    if (!input.backgroundPlate) {
      throw new Error("BackgroundMattingV2Adapter requires input.backgroundPlate — see capabilities.requiredInputs.");
    }

    const srcCanvas = resizeToInputCanvas(input.source, INPUT_SIZE);
    const bgCanvas = resizeToInputCanvas(input.backgroundPlate, INPUT_SIZE);
    const srcData = srcCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const bgData = bgCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;

    const srcTensor = imageDataToTensor(srcData, INPUT_SIZE);
    const bgTensor = imageDataToTensor(bgData, INPUT_SIZE);

    // Assumed two-input ordering (src, then background) — the exact input
    // names depend on which specific ONNX export is eventually bundled;
    // verify against that export's real input/output names before this
    // adapter is exercised for real (it isn't in Phase 1 — see MODEL_URL's
    // note above).
    const [srcName, bgName] = this.session.inputNames;
    const outputs = await this.session.run({ [srcName]: srcTensor, [bgName]: bgTensor });
    const outTensor = outputs[this.session.outputNames[0]];
    const dims = outTensor.dims as number[];

    return {
      alpha: outTensor.data as Float32Array,
      alphaWidth: dims[dims.length - 1],
      alphaHeight: dims[dims.length - 2],
      producedBy: { modelId: this.capabilities.modelId, modelClass: this.capabilities.modelClass },
    };
  }
}
