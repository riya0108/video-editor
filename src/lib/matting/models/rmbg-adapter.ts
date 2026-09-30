import { loadSegmenter, type Segmenter } from "../../captions/person-cutout";
import type { MattingModel, MattingModelCapabilities, MatteImageInput, MatteOutput, HealthCheckResult } from "../types";

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "rmbg-1.4",
  modelClass: "segmentation",
  // "image" only, deliberately — see the no-inferVideo note at the bottom of
  // this file. The underlying model *is* used for video elsewhere in the
  // app today (person-cutout.ts's generateSubjectCutouts), just not through
  // a shape this interface can wrap yet.
  supportedMedia: ["image"],
  supportedSubjects: ["general", "portrait", "product"],
  requiredInputs: ["frame"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: 1024, nativeHeight: 1024 },
  deviceSupport: ["wasm"],
  supportsTemporal: false,
  license: {
    id: "BRIA RMBG-1.4 (non-commercial)",
    commercialUse: false,
    redistributable: false,
    sourceUrl: "https://huggingface.co/briaai/RMBG-1.4",
    notes:
      "Non-commercial only — commercial use requires a paid license from BRIA. See MODEL_LICENSES.md. The router excludes this model unless the caller explicitly sets allowNonCommercial, and doing so is only correct if that commercial license has actually been secured — the router cannot verify that itself.",
  },
};

/**
 * Wraps this app's existing, already-in-production RMBG-1.4 loader
 * (../../captions/person-cutout.ts's loadSegmenter) behind the common
 * interface. General-purpose ("any subject") segmentation — but NON-
 * COMMERCIAL LICENSED (see MODEL_LICENSES.md). Kept as a real adapter
 * (not deleted, not a stub) so the interface can correctly represent a
 * license-gated model, per MATTE_IMPLEMENTATION_PLAN.md's Phase 1 scope.
 * This does not change how any *existing* caller of person-cutout.ts
 * behaves — those callers don't go through this router yet (Phase 4).
 *
 * "segmentation"-class: general-purpose but not a refined alpha matte on
 * its own — see types.ts's ModelClass doc comment.
 */
export class RmbgAdapter implements MattingModel {
  readonly capabilities = CAPABILITIES;
  private segmenter: Segmenter | null = null;

  isLoaded(): boolean {
    return this.segmenter !== null;
  }

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    // Idempotent — see SelfieSegmenterAdapter's identical note.
    if (this.segmenter) {
      onProgress?.(1);
      return;
    }
    this.segmenter = await loadSegmenter((p) => onProgress?.(p.fraction));
  }

  unload(): void {
    this.segmenter = null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: this.segmenter !== null, loaded: this.isLoaded(), device: "wasm" };
  }

  async inferImage(input: MatteImageInput): Promise<MatteOutput> {
    if (!this.segmenter) throw new Error("RmbgAdapter: call load() before inferring.");
    const output = await this.segmenter(input.source);
    const mask = output[0]?.mask;
    if (!mask) throw new Error("NO_SUBJECT");
    // RawImage's mask is single-channel but stored as a Uint8Array/
    // Uint8ClampedArray, not yet the normalized 0-1 Float32Array this
    // interface returns — grayscale() first matches how person-cutout.ts's
    // existing callers already normalize it before reading .data.
    mask.grayscale();
    const alpha = Float32Array.from(mask.data, (v) => v / 255);
    return {
      alpha,
      alphaWidth: mask.width,
      alphaHeight: mask.height,
      producedBy: { modelId: this.capabilities.modelId, modelClass: this.capabilities.modelClass },
    };
  }

  // No inferVideo: person-cutout.ts's generateSubjectCutouts (RMBG-1.4's
  // existing video path) is a sample-and-cutout batch operation, not a
  // per-frame inference call this interface's inferVideo(frame) shape can
  // wrap without changing that module — left as a Phase 4 consolidation
  // item (MATTE_IMPLEMENTATION_PLAN.md section 23) rather than forced in
  // now. capabilities.supportedMedia is "image"-only above to match.
}
