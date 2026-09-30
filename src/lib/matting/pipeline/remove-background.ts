import { rankModels } from "../router";
import { supportsImage } from "../types";
import { getSharedModelRegistry } from "../models/registry";
import { createLogger, type MattingLogger } from "./logger";
import { analyzeMedia } from "./media-analysis";
import { resizeAlphaBilinear } from "./alpha-resize";
import { refineAlphaMatte } from "./refine/pipeline";
import { decontaminate } from "./decontaminate";
import { computeQualityMetrics, computeConfidence } from "./quality-metrics";
import { computeBoundingBox } from "./bounding-box";
import { drawSourceToRgba, compositeTransparentForeground } from "./dom-io";
import { MattingError, MASK_VERSION, type MattingResult, type RemoveBackgroundOptions } from "./types";

// A "matting"-class model's native output is already fine-grained, so a
// gentler smoothing pass is enough to fix up the bilinear-upsample seams.
//
// A "segmentation"-class model's raw output can include a band of low
// (spuriously nonzero) confidence over pixels that are, in reality, 100%
// background — decontaminate.ts's suppression check catches the worst of
// this, but the guided filter's OWN radius also matters: at a larger
// radius the filter can widen that low-confidence band into a visible halo
// (a real, documented tendency of guided filtering near high-curvature
// edges, not specific to this codebase). Confirmed empirically on a real
// U²-Net run against a real photo: reducing the radius from 7 to 2 roughly
// halved the count of still-greenish output pixels near a chroma-style
// backdrop (21,984 -> 12,672 on the test image), with radius monotonically
// trading off against halo width at every value tested (7/5/3/2/1). 2 is
// the smallest radius that still does meaningful smoothing rather than an
// almost-no-op 3x3 box. These feed refineAlphaMatte's `smooth` override —
// every other Phase 2 refinement parameter (refine/pipeline.ts) stays at
// its documented default.
const REFINE_RADIUS_MATTING = 3;
const REFINE_RADIUS_SEGMENTATION = 2;
const REFINE_EPS = 1e-3;

// PHASE 16 — ADVERSARIAL MATTE TESTING ("extremely high resolution"). Every
// model resizes down to a small fixed input for inference (e.g. U²-Net's
// 320x320), but refinement/decontamination/compositing below all run at
// FULL source resolution, each allocating its own Float32Array/
// Uint8ClampedArray the size of the whole image — and those refinement
// passes (guided filter, decontamination) are plain JS, not WASM/GPU
// accelerated. Measured directly (adversarial test suite, see
// remove-background.adversarial.test.ts): a real 6000x6000 (36MP) run
// through the full pipeline took ~19 SECONDS. An uncapped, truly extreme
// input (a giant scan, a stitched panorama, a hostile/malformed file) can
// push memory well past what a WASM heap (hard-capped at 4GB regardless of
// device RAM) or a lower-memory device can supply, crashing the tab instead
// of failing the one request — "must fail gracefully" applies here too. 24
// megapixels (comfortably above a typical 12MP phone photo, the realistic
// case for a browser bg-removal tool) keeps worst-case latency in the same
// ballpark as that measurement while still catching truly extreme inputs
// before any allocation is attempted. This is a safety ceiling, not a
// performance target — Phase 14 already covers throughput optimization;
// making the refinement passes themselves faster is future work, not this
// guard's job.
const MAX_PIXELS = 24_000_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The full IMAGE pipeline: MEDIA ANALYSIS -> SUBJECT DETECTION -> MODEL
 * SELECTION -> INITIAL MASK/MATTE -> ALPHA REFINEMENT -> EDGE REFINEMENT ->
 * COLOUR DECONTAMINATION -> QUALITY ANALYSIS -> FINAL ALPHA -> TRANSPARENT
 * OUTPUT. Video is explicitly out of scope for this phase.
 *
 * `source` is only ever read from (via drawSourceToRgba's ctx.drawImage) —
 * never mutated, never written back to (requirements 1/2). Every
 * intermediate stage allocates a new Float32Array/Uint8ClampedArray/canvas;
 * nothing is refined or composited in place.
 *
 * Throws MattingError, and never returns a result, when no eligible model
 * could actually produce output — see the "do not claim success unless
 * inference actually succeeded" requirement. A model that IS eligible but
 * fails at load()/inferImage() time (e.g. its weight file isn't bundled
 * yet — true today for MODNet/U²-Net/BackgroundMattingV2, see the phase
 * report's known limitations) is recorded as a warning and the next
 * candidate is tried; it is never silently treated as a success.
 */
export async function removeBackgroundFromImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  options: RemoveBackgroundOptions = {},
): Promise<MattingResult> {
  const startTime = performance.now();
  const log: MattingLogger = createLogger();
  const warnings: string[] = [];

  if (width <= 0 || height <= 0) {
    throw new MattingError("ALL_MODELS_FAILED", `Invalid image dimensions: ${width}x${height}.`);
  }
  if (width * height > MAX_PIXELS) {
    throw new MattingError(
      "ALL_MODELS_FAILED",
      `Image is too large to process safely in this browser (${width}x${height} = ${(width * height / 1_000_000).toFixed(1)}MP, limit is ${MAX_PIXELS / 1_000_000}MP). Resize it first.`,
    );
  }

  // MEDIA ANALYSIS + SUBJECT DETECTION
  log.info("media-analysis", "Reading source image", { width, height });
  const rgba = drawSourceToRgba(source, width, height);
  const analysis = analyzeMedia(rgba, width, height, options.subjectHint);
  log.info("subject-detection", `Subject hint: ${analysis.subjectHint}`, {
    hasExistingAlpha: analysis.hasExistingAlpha,
  });
  if (analysis.hasExistingAlpha) {
    warnings.push("Source image already contains transparency — existing alpha is ignored, not composited with the new matte.");
  }

  // MODEL SELECTION
  // PHASE 16: `options.models` lets adversarial tests substitute mock
  // models (simulating GPU/network/OOM failures) without needing a real
  // ONNX runtime or a bundled weight file — production code never passes
  // this, so real callers always get the real shared registry.
  const registry = options.models ?? getSharedModelRegistry();
  const ranked = rankModels(registry, {
    media: "image",
    subject: analysis.subjectHint,
    allowNonCommercial: options.allowNonCommercial ?? false,
  });
  log.info("model-selection", `${ranked.length} eligible candidate(s)`, {
    candidates: ranked.map((r) => r.model.capabilities.modelId),
  });

  if (ranked.length === 0) {
    log.error("model-selection", "No eligible model for this request");
    throw new MattingError(
      "NO_ELIGIBLE_MODEL",
      "No matting model is eligible for this image (check subject hint, or set allowNonCommercial if you have a commercial RMBG-1.4 license — see MODEL_LICENSES.md).",
    );
  }

  // INITIAL MASK/MATTE — try each eligible candidate in ranked order until
  // one actually succeeds; a candidate that throws (missing weight file,
  // NO_SUBJECT, a runtime/session error) is recorded and skipped, never
  // treated as a partial success.
  let rawAlpha: Float32Array | null = null;
  let rawWidth = 0;
  let rawHeight = 0;
  let modelUsed = "";
  let requiresRefinement = false;
  // PHASE 14 — PERFORMANCE. Isolates just the model forward-pass duration
  // from the surrounding refinement/decontamination/quality-analysis work —
  // `processingTimeMs` below already covers the whole pipeline; benchmarks
  // need the two separately to tell "the model is slow" from "refinement is
  // slow" apart.
  let modelInferenceTimeMs = 0;

  for (const candidate of ranked) {
    const model = candidate.model;
    try {
      log.info("model-selection", `Trying ${model.capabilities.modelId}`);
      if (!model.isLoaded()) {
        await model.load(options.onModelLoadProgress);
      }
      if (!supportsImage(model)) {
        // Shouldn't happen — rankModels' eligibility check already requires
        // this — but never assume it silently if it somehow does.
        throw new Error("Model passed eligibility but does not implement inferImage.");
      }
      const inferenceStart = performance.now();
      const output = await model.inferImage({ source, width, height });
      modelInferenceTimeMs = performance.now() - inferenceStart;
      rawAlpha = output.alpha;
      rawWidth = output.alphaWidth;
      rawHeight = output.alphaHeight;
      modelUsed = model.capabilities.modelId;
      requiresRefinement = candidate.requiresRefinement;
      log.info("model-selection", `${model.capabilities.modelId} succeeded`, {
        rawWidth,
        rawHeight,
      });
      break;
    } catch (err) {
      const message = errorMessage(err);
      log.warn("model-selection", `${model.capabilities.modelId} failed: ${message}`);
      warnings.push(`Model "${model.capabilities.modelId}" failed (${message}); tried next candidate.`);
    }
  }

  if (!rawAlpha) {
    log.error("model-selection", "Every eligible model failed");
    throw new MattingError("ALL_MODELS_FAILED", "Every eligible matting model failed to process this image.", warnings);
  }

  // ALPHA REFINEMENT + EDGE REFINEMENT — the full Phase 2 pipeline
  // (normalization, trimap, fine-detail mask, small-hole/island cleanup,
  // edge-aware smoothing, local edge refinement, anti-aliasing — see
  // refine/pipeline.ts's doc comment for the complete list and ordering).
  // `smooth` is the only override: a "segmentation"-class model gets a
  // stronger smoothing radius than a "matting"-class one, per the note
  // above this function.
  log.info("alpha-refinement", "Resizing raw alpha to source resolution");
  let alpha = resizeAlphaBilinear(rawAlpha, rawWidth, rawHeight, width, height);
  const refineRadius = requiresRefinement ? REFINE_RADIUS_SEGMENTATION : REFINE_RADIUS_MATTING;
  log.info("alpha-refinement", "Running Phase 2 refinement pipeline", { radius: refineRadius, requiresRefinement });
  const refined = refineAlphaMatte(alpha, rgba, width, height, { smooth: { radius: refineRadius, eps: REFINE_EPS } });
  alpha = refined.alpha;
  log.info("edge-refinement", "Refinement complete", {
    holesFilled: refined.holesFilled,
    islandsRemoved: refined.islandsRemoved,
    islandsPreserved: refined.islandsPreserved,
  });
  if (refined.holesFilled > 0) warnings.push(`Filled ${refined.holesFilled} small hole(s) in the matte.`);
  if (refined.islandsRemoved > 0) warnings.push(`Removed ${refined.islandsRemoved} small disconnected speck(s) from the matte.`);

  // COLOUR DECONTAMINATION — also suppresses alpha at pixels where unmixing
  // proves there was no real foreground signal (e.g. a segmentation model's
  // low-confidence halo over pixels that are actually 100% background); see
  // decontaminate.ts's doc comment. `alpha` is reassigned to the returned,
  // post-suppression array — everything downstream (quality metrics,
  // bounding box, compositing) must see the corrected alpha, not the
  // pre-decontamination one.
  log.info("colour-decontamination", "Estimating and removing background color bleed at semi-transparent edges");
  const decontaminated = decontaminate(rgba, alpha, width, height);
  const decontaminatedRgba = decontaminated.rgba;
  alpha = decontaminated.alpha;
  log.info("colour-decontamination", `${decontaminated.pixelsDecontaminated} pixel(s) decontaminated, ${decontaminated.pixelsSuppressed} suppressed`);
  if (decontaminated.pixelsDecontaminated === 0 && decontaminated.pixelsSuppressed === 0) {
    warnings.push("No semi-transparent edge pixels found to decontaminate — the matte may be near-binary, or nothing needed correcting.");
  }

  // QUALITY ANALYSIS
  log.info("quality-analysis", "Computing quality metrics");
  const qualityMetrics = computeQualityMetrics(alpha, width, height);
  const confidence = computeConfidence(qualityMetrics);
  if (qualityMetrics.coverageFraction < 0.02 || qualityMetrics.coverageFraction > 0.98) {
    warnings.push(
      `Unusual foreground coverage (${(qualityMetrics.coverageFraction * 100).toFixed(1)}%) — this may be a failed segmentation rather than a real subject.`,
    );
  }
  if (confidence < 0.4) {
    warnings.push(`Low confidence (${confidence.toFixed(2)}) — the model's output was not clearly separated into foreground and background.`);
  }
  log.info("quality-analysis", "Done", { ...qualityMetrics, confidence });

  // FINAL ALPHA + TRANSPARENT OUTPUT
  const boundingBox = computeBoundingBox(alpha, width, height, 0.05);
  const foreground = compositeTransparentForeground(decontaminatedRgba, alpha, width, height);

  const processingTimeMs = performance.now() - startTime;
  log.info("done", `Completed in ${processingTimeMs.toFixed(0)}ms using ${modelUsed}`);

  return {
    alpha,
    alphaWidth: width,
    alphaHeight: height,
    foreground,
    boundingBox,
    confidence,
    modelUsed,
    processingTimeMs,
    modelInferenceTimeMs,
    warnings,
    qualityMetrics,
    resolution: { width, height },
    maskVersion: MASK_VERSION,
  };
}
