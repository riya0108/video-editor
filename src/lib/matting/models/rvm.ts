import type { MattingModel, MattingModelCapabilities, MatteVideoFrameInput, MatteOutput, HealthCheckResult } from "../types";

const LICENSE_BLOCK_MESSAGE =
  "RobustVideoMatting (RVM) is GPL-3.0-licensed. Integrating its code or weights into this proprietary, closed-source codebase is a licensing violation regardless of commercial intent — this is not the kind of restriction a paid license purchase can lift (contrast RMBG-1.4's non-commercial license, which can). See MODEL_LICENSES.md. This adapter intentionally never downloads or executes any RVM code/weights; load() always throws.";

const CAPABILITIES: MattingModelCapabilities = {
  modelId: "rvm",
  modelClass: "matting",
  supportedMedia: ["video"],
  supportedSubjects: ["portrait"],
  requiredInputs: ["frame", "previous-alpha"],
  outputType: "alpha-mask",
  resolutionLimits: { nativeWidth: 512, nativeHeight: 512 },
  deviceSupport: ["webgpu", "wasm"],
  // A genuine recurrent temporal network (hidden state carried frame to
  // frame) — this is the model the diagram's "RVM / temporal" box names,
  // and the reason router.ts's scoring rewards supportsTemporal on video
  // requests. It is declared here so the router/type system can represent
  // and reason about a temporal model correctly (per this phase's explicit
  // requirement to support an RVM-shaped adapter) — NOT because this
  // adapter is actually usable. See license.copyleft below.
  supportsTemporal: true,
  license: {
    id: "GPL-3.0",
    commercialUse: false,
    redistributable: false,
    copyleft: true,
    sourceUrl: "https://github.com/PeterL1n/RobustVideoMatting",
    notes: LICENSE_BLOCK_MESSAGE,
  },
};

/**
 * Structural placeholder for RobustVideoMatting (RVM), the temporal video-
 * matting model named in the architecture diagram. GPL-3.0 (see
 * MODEL_LICENSES.md) makes it unusable in this proprietary codebase without
 * a separate legal path (isolating it as its own GPL-licensed service with
 * no linking into this app, or a different license from the authors) —
 * neither of which this plan pursues (MATTE_IMPLEMENTATION_PLAN.md section
 * 4 proposes MediaPipe Selfie Segmenter + classical temporal smoothing as
 * the license-safe stand-in instead).
 *
 * This class exists only to prove the MattingModel interface can correctly
 * represent and reject a license-blocked model (capabilities.license.copyleft
 * makes router.ts exclude it unconditionally, with no allowNonCommercial
 * override) — it deliberately contains no real inference code, downloads
 * nothing, and load() always throws. Do not "complete" this adapter without
 * first resolving the licensing question in MODEL_LICENSES.md.
 */
export class RvmAdapter implements MattingModel {
  readonly capabilities = CAPABILITIES;

  isLoaded(): boolean {
    return false;
  }

  async load(): Promise<void> {
    throw new Error(LICENSE_BLOCK_MESSAGE);
  }

  unload(): void {
    // Nothing is ever loaded — see load().
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: false, loaded: false, error: LICENSE_BLOCK_MESSAGE };
  }

  async inferVideo(_input: MatteVideoFrameInput): Promise<MatteOutput> {
    throw new Error(LICENSE_BLOCK_MESSAGE);
  }

  resetTemporalState(): void {
    // No-op — no state is ever held, since load() never succeeds.
  }
}
