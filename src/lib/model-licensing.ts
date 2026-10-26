/**
 * MODEL LICENSING GATE. Some models this site can run are licensed for NON-COMMERCIAL use only
 * (see MODEL_LICENSES.md and /licenses):
 *
 *   NLLB-200 (caption translation)  — CC-BY-NC-4.0, Meta
 *   F5-TTS   (voice cloning)        — CC-BY-NC-4.0 weights (trained on the Emilia dataset)
 *   RMBG-1.4 (gated matting adapter) — BRIA non-commercial license
 *
 * They're OFF unless the deployment sets PUBLIC_ALLOW_NONCOMMERCIAL_MODELS=true — which is only correct for a
 * genuinely non-commercial deployment, or one that holds commercial licenses from the model owners. A free site
 * run by a business can still count as commercial use; get legal advice before turning this on.
 */
export const NONCOMMERCIAL_MODELS_ENABLED = import.meta.env.PUBLIC_ALLOW_NONCOMMERCIAL_MODELS === "true";

export class ModelLicenseError extends Error {
  constructor(feature: string) {
    super(`${feature} uses a model licensed for non-commercial use only, so it's turned off on this site.`);
    this.name = "ModelLicenseError";
  }
}

export function requireNonCommercialModels(feature: string): void {
  if (!NONCOMMERCIAL_MODELS_ENABLED) throw new ModelLicenseError(feature);
}
