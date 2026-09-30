import type { ImageSegmenter, ImageSource } from "@mediapipe/tasks-vision";
import { loadSelfieSegmenter, segmentPersonMask } from "../../media/selfie-segmenter";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteVideoFrameInput, MatteOutput, HealthCheckResult } from "../types";

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "mediapipe-selfie-segmenter",
  modelClass: "segmentation",
  supportedMedia: ["image", "video"],
  supportedSubjects: ["portrait"],
  requiredInputs: ["frame"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: 256, nativeHeight: 256 },
  deviceSupport: ["gpu-delegate", "cpu-delegate"],
  supportsTemporal: false,
  license: {
    id: "Apache-2.0",
    commercialUse: true,
    redistributable: true,
    sourceUrl: "https://github.com/google-ai-edge/mediapipe",
  },
};

/**
 * Wraps this app's existing, already-in-production MediaPipe selfie
 * segmenter (../../media/selfie-segmenter.ts) behind the common
 * MattingModel interface — no changes to that module. Real-time person
 * segmentation, portrait-only, Apache-2.0 (safe for commercial use, unlike
 * RMBG-1.4 — see MODEL_LICENSES.md).
 *
 * "segmentation"-class (see types.ts's ModelClass doc comment): fast and
 * license-clean, but its output is a per-pixel confidence mask, not a
 * refined alpha matte — callers must not treat it as finished, hair-capable
 * output without the refinement pipeline (MATTE_IMPLEMENTATION_PLAN.md
 * sections 7-9, not implemented in this phase).
 */
export class SelfieSegmenterAdapter implements MattingModel {
  readonly capabilities = CAPABILITIES;
  private segmenter: ImageSegmenter | null = null;
  // MediaPipe's VIDEO-mode API (the mode loadSelfieSegmenter uses) requires
  // a strictly-increasing timestamp per call, even for a "single image"
  // inference — this counter stands in for a real video clock when there
  // isn't one.
  private syntheticTimestamp = 0;

  isLoaded(): boolean {
    return this.segmenter !== null;
  }

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    // Idempotent, same rationale as the ONNX adapters (u2net.ts etc.) —
    // loadSelfieSegmenter() is itself a cached singleton promise, so this
    // is cheap even without the guard, but the guard makes the "don't
    // reload per image" contract explicit here too.
    if (this.segmenter) {
      onProgress?.(1);
      return;
    }
    onProgress?.(0);
    this.segmenter = await loadSelfieSegmenter();
    onProgress?.(1);
  }

  unload(): void {
    // loadSelfieSegmenter's underlying cache is module-level and shared with
    // other existing callers (e.g. person-cutout.ts's "occlude by person"
    // path) that expect it to stay warm across tools — this adapter only
    // drops its own reference, it does not tear down the shared instance.
    this.segmenter = null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: this.segmenter !== null, loaded: this.isLoaded(), device: "gpu-delegate" };
  }

  private runInference(input: MatteImageInput, timestampMs: number): MatteOutput {
    if (!this.segmenter) throw new Error("SelfieSegmenterAdapter: call load() before inferring.");
    // CanvasImageSource (this interface's own source type, matching the rest
    // of this app's convention) and MediaPipe's ImageSource/TexImageSource
    // differ only in SVGImageElement (in the former, not the latter) versus
    // ImageData/VideoFrame (in the latter, not the former) — this app never
    // passes an SVG element as a matting source, so the cast is safe.
    const mask = segmentPersonMask(this.segmenter, input.source as unknown as ImageSource, timestampMs);
    if (!mask) throw new Error("NO_SUBJECT");
    return {
      alpha: mask.data,
      alphaWidth: mask.width,
      alphaHeight: mask.height,
      producedBy: { modelId: this.capabilities.modelId, modelClass: this.capabilities.modelClass },
    };
  }

  async inferImage(input: MatteImageInput): Promise<MatteOutput> {
    return this.runInference(input, this.syntheticTimestamp++);
  }

  async inferVideo(input: MatteVideoFrameInput): Promise<MatteOutput> {
    return this.runInference(input, input.timestampMs);
  }
}
