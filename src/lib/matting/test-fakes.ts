import type {
  MattingModel,
  MattingModelCapabilities,
  MatteImageInput,
  MatteVideoFrameInput,
  MatteOutput,
  HealthCheckResult,
} from "./types";

/**
 * Test-only helpers — not imported by any adapter or the router itself.
 * Deliberately excluded from Vitest's `include` pattern (it doesn't match
 * `*.test.ts`), so it's just a normal module other test files import from.
 */

export function makeFakeCapabilities(overrides: Partial<MattingModelCapabilities> = {}): MattingModelCapabilities {
  return {
    modelId: "fake",
    modelClass: "segmentation",
    supportedMedia: ["image"],
    supportedSubjects: ["general"],
    requiredInputs: ["frame"],
    outputType: "alpha-mask",
    resolutionLimits: { nativeWidth: 256, nativeHeight: 256 },
    deviceSupport: ["wasm"],
    supportsTemporal: false,
    license: { id: "Apache-2.0", commercialUse: true, redistributable: true, sourceUrl: "https://example.test" },
    ...overrides,
  };
}

function fakeOutput(model: MattingModel): MatteOutput {
  return {
    alpha: new Float32Array([1, 0, 0.5, 1]),
    alphaWidth: 2,
    alphaHeight: 2,
    producedBy: { modelId: model.capabilities.modelId, modelClass: model.capabilities.modelClass },
  };
}

/**
 * Minimal, fully-controllable MattingModel implementation for router/
 * interface tests — no real inference, no network, no browser APIs. Only
 * attaches inferImage/inferVideo/resetTemporalState when the given
 * capabilities actually declare support for them, mirroring the "don't
 * force every model to implement capabilities it doesn't support" rule the
 * real adapters follow (and letting a test deliberately break that rule by
 * deleting a method afterward, to verify the capability guards in types.ts
 * catch the mismatch).
 */
export class FakeMattingModel implements MattingModel {
  readonly capabilities: MattingModelCapabilities;
  inferImage?: (input: MatteImageInput) => Promise<MatteOutput>;
  inferVideo?: (input: MatteVideoFrameInput) => Promise<MatteOutput>;
  resetTemporalState?: () => void;
  private loaded = false;

  constructor(capabilities: Partial<MattingModelCapabilities> = {}) {
    this.capabilities = makeFakeCapabilities(capabilities);
    if (this.capabilities.supportedMedia.includes("image")) {
      this.inferImage = async () => fakeOutput(this);
    }
    if (this.capabilities.supportedMedia.includes("video")) {
      this.inferVideo = async () => fakeOutput(this);
    }
    if (this.capabilities.supportsTemporal) {
      this.resetTemporalState = () => {};
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    this.loaded = true;
  }

  unload(): void {
    this.loaded = false;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: this.loaded, loaded: this.loaded };
  }
}
