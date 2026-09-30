import type { EdgeClassifier, EdgeClassifierInput } from "./edge-classifier";
import { ClassicalEdgeClassifier } from "./classical-edge-classifier";
import { EdgeCategory, EDGE_CATEGORY_NAMES, getEdgeRefinementGuidance, type EdgeRefinementGuidance } from "./edge-category";

/**
 * EdgeAnalysisEngine — Phase 5 ("EDGE ANALYSIS"). Thin orchestration layer
 * over whichever EdgeClassifier it's given (ClassicalEdgeClassifier by
 * default): runs classification, exposes the internal edge confidence map
 * the brief asks for directly, and attaches each pixel's refinement
 * guidance so a caller doesn't have to look it up separately.
 *
 * Modularity ("keep it modular so a better edge classifier can be added
 * later"): the engine depends only on the EdgeClassifier interface, never
 * on ClassicalEdgeClassifier's concrete implementation — swap the
 * constructor argument and every method below keeps working unchanged. See
 * edge-analysis-engine.test.ts's "swappable classifier" test for a concrete
 * demonstration of this using a fake classifier.
 */
export interface EdgeAnalysisResult {
  /** EdgeCategory-encoded, one entry per pixel — see EdgeClassificationMap. */
  labels: Uint8Array;
  /** The internal edge confidence map (the brief's explicit requirement) — 0..1 per pixel, 0 meaning "not an analyzed edge region at all". */
  confidence: Float32Array;
  /** Which classifier produced this — surfaced for diagnostics/logging (e.g. to confirm a future non-default classifier is actually the one that ran). */
  classifierName: string;
  /** Pixel count per category, for quick diagnostics (e.g. "how much of this frame got flagged UNCERTAIN"). */
  pixelCountByCategory: Record<EdgeCategory, number>;
}

function countLabels(labels: Uint8Array): Record<EdgeCategory, number> {
  const counts: Record<EdgeCategory, number> = {
    [EdgeCategory.HardEdge]: 0,
    [EdgeCategory.SoftEdge]: 0,
    [EdgeCategory.Hair]: 0,
    [EdgeCategory.Fur]: 0,
    [EdgeCategory.Translucent]: 0,
    [EdgeCategory.MotionBlur]: 0,
    [EdgeCategory.Shadow]: 0,
    [EdgeCategory.Reflection]: 0,
    [EdgeCategory.Uncertain]: 0,
  };
  for (const label of labels) counts[label as EdgeCategory]++;
  return counts;
}

export class EdgeAnalysisEngine {
  constructor(private readonly classifier: EdgeClassifier = new ClassicalEdgeClassifier()) {}

  analyze(input: EdgeClassifierInput): EdgeAnalysisResult {
    const { labels, confidence } = this.classifier.classify(input);
    return {
      labels,
      confidence,
      classifierName: this.classifier.name,
      pixelCountByCategory: countLabels(labels),
    };
  }

  /** Convenience: the refinement guidance for a single pixel's assigned category — see edge-category.ts. */
  guidanceForPixel(result: EdgeAnalysisResult, index: number): EdgeRefinementGuidance {
    return getEdgeRefinementGuidance(result.labels[index] as EdgeCategory);
  }

  /** Human-readable label name for a pixel — diagnostics/logging convenience over EDGE_CATEGORY_NAMES. */
  categoryNameForPixel(result: EdgeAnalysisResult, index: number): string {
    return EDGE_CATEGORY_NAMES[result.labels[index] as EdgeCategory];
  }
}
