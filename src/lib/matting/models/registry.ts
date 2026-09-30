import type { MattingModel } from "../types";
import { SelfieSegmenterAdapter } from "./selfie-segmenter-adapter";
import { RmbgAdapter } from "./rmbg-adapter";
import { U2NetAdapter } from "./u2net";
import { RvmAdapter } from "./rvm";

/**
 * One instance of every known, USABLE adapter — the full candidate list
 * router.ts chooses from. Constructing an adapter here does not load or
 * download anything (see each adapter's constructor/load() split); this is
 * the live registry the image and video pipelines actually select from
 * (see getSharedModelRegistry() below), not a test-only fixture.
 *
 * PRODUCTION READINESS (H1): ModNetAdapter and BackgroundMattingV2Adapter are
 * deliberately NOT registered here — their weight files were never bundled
 * (both adapters' own doc comments say so), and because `modnet` scores
 * higher than `u2net` in router.ts's ranking for every image request (no
 * production caller ever sets an explicit subjectHint, so requests are
 * always "unknown", and modnet's modelClass="matting" bonus alone
 * outscores u2net's generic-fallback bonus), registering it meant EVERY
 * image request tried modnet first, always got a 404, and surfaced a
 * scary-looking "Model modnet failed" warning to ordinary end users before
 * silently falling back to u2net. Re-add either adapter once its weight
 * file is actually bundled under /public/models/ (see MODEL_LICENSES.md).
 */
export function createModelRegistry(): MattingModel[] {
  return [
    new SelfieSegmenterAdapter(),
    new RmbgAdapter(),
    new U2NetAdapter(),
    new RvmAdapter(),
  ];
}

let sharedRegistry: MattingModel[] | null = null;

/**
 * The registry the image pipeline (pipeline/remove-background.ts) actually
 * uses — a single, process-lifetime set of adapter instances, so a loaded
 * model's session/segmenter (see each adapter's isLoaded()/load() guard)
 * survives across multiple images processed in the same tab instead of being
 * reloaded from scratch every call. createModelRegistry() above stays
 * available separately for tests that want fresh, isolated instances.
 */
export function getSharedModelRegistry(): MattingModel[] {
  if (!sharedRegistry) sharedRegistry = createModelRegistry();
  return sharedRegistry;
}

/** Test-only: drops the shared registry so the next getSharedModelRegistry() call builds a fresh one. Never called from app code. */
export function resetSharedModelRegistryForTests(): void {
  sharedRegistry = null;
}
