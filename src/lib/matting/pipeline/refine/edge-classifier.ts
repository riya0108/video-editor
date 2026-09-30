import type { EdgeCategory } from "./edge-category";

/**
 * The swappable contract behind EdgeAnalysisEngine — mirrors how
 * src/lib/matting/router.ts decouples model *selection* from any one
 * MattingModel implementation. `ClassicalEdgeClassifier` (see
 * classical-edge-classifier.ts) is the only implementation today, built
 * entirely from classical signals (no model, no licensing concern — see
 * edge-signals.ts), but nothing in EdgeAnalysisEngine or this interface
 * assumes that: a future ML-based classifier can implement `classify()`
 * however it wants (run a model, call a remote service, whatever) as long
 * as it consumes this same input shape and produces this same output shape.
 * "Do not make this system dependent on one ML model" / "keep it modular so
 * a better edge classifier can be added later" are satisfied structurally
 * by this interface existing at all, not by convention.
 */
export interface EdgeClassifierInput {
  alpha: Float32Array;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** TrimapLabel-encoded (see trimap.ts) — typically buildTrimap's output, optionally already widened by Phase 3's expandUnknownAroundCandidates. */
  trimap: Uint8Array;
}

export interface EdgeClassificationMap {
  /** EdgeCategory-encoded, one entry per pixel. */
  labels: Uint8Array;
  /**
   * 0..1 per-pixel confidence in `labels`. Exactly 0 is reserved for pixels
   * the classifier didn't consider an edge region at all (deep interior
   * background/foreground, no hair signal) — distinct from a low-but-nonzero
   * confidence UNCERTAIN classification, which means "this WAS evaluated as
   * an edge region, but no category was confidently dominant". Callers that
   * want "the internal edge confidence map" (the brief's requirement)
   * should read this array directly.
   */
  confidence: Float32Array;
}

export interface EdgeClassifier {
  /** Short identifier for diagnostics/logging — e.g. "classical-v1". Not shown to end users. */
  readonly name: string;
  classify(input: EdgeClassifierInput): EdgeClassificationMap;
}
