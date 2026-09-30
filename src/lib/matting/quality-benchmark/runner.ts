import { removeBackgroundFromImage } from "../pipeline";
import { DATASET_CASES, type DatasetCase, type BenchmarkCategory } from "./dataset";
import { VIDEO_CASES, type VideoDatasetCase } from "./video-dataset";
import { computeImageMetrics, temporalConsistencyError, type ImageMetrics } from "./metrics";

/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. Runs the REAL production matting
 * pipeline (src/lib/matting/pipeline/remove-background.ts) against the
 * permanent synthetic dataset (dataset.ts / video-dataset.ts) and scores
 * every case against its exact ground truth. Same principle as Phase 14's
 * performance benchmark: exercises the actual entry point a user's export
 * goes through, not an isolated model call, so results reflect what a user
 * actually gets (model selection, refinement, decontamination included).
 */

export interface ImageCaseMeasurement {
  caseId: string;
  category: BenchmarkCategory;
  subcategory: string;
  description: string;
  ok: boolean;
  error?: string;
  modelUsed?: string;
  confidence?: number;
  metrics?: ImageMetrics;
}

export interface VideoCaseMeasurement {
  caseId: string;
  category: "video";
  subcategory: string;
  description: string;
  ok: boolean;
  error?: string;
  modelUsed?: string;
  /** Mean of each still-image metric across every successfully-processed frame. */
  meanMetrics?: ImageMetrics;
  temporalConsistencyError?: number;
  framesProcessed: number;
  framesTotal: number;
}

/** In-memory-only visual artifacts for the human-review UI — deliberately NOT part of the JSON-serializable report (see quality-report.ts): canvases can't round-trip through JSON, and a persisted report should stay small enough to diff and store many versions of. */
export interface ImageCaseVisuals {
  caseId: string;
  compositeCanvas: HTMLCanvasElement;
  groundTruthAlphaCanvas: HTMLCanvasElement;
  predictedAlphaCanvas: HTMLCanvasElement | null;
  predictedForegroundCanvas: HTMLCanvasElement | null;
}

export interface QualityRunResult {
  imageMeasurements: ImageCaseMeasurement[];
  videoMeasurements: VideoCaseMeasurement[];
  visuals: Map<string, ImageCaseVisuals>;
  generatedAt: string;
}

function alphaToGrayscaleCanvas(alpha: Float32Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < alpha.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, alpha[i])) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function rgbaToCanvas(rgba: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(rgba.slice(), width, height), 0, 0);
  return canvas;
}

async function runOneImageCase(testCase: DatasetCase): Promise<{ measurement: ImageCaseMeasurement; visuals: ImageCaseVisuals }> {
  const scene = testCase.build();
  const sourceCanvas = rgbaToCanvas(scene.compositeRgba, scene.width, scene.height);
  const groundTruthAlphaCanvas = alphaToGrayscaleCanvas(scene.groundTruthAlpha, scene.width, scene.height);

  const base: ImageCaseMeasurement = {
    caseId: testCase.id,
    category: testCase.category,
    subcategory: testCase.subcategory,
    description: testCase.description,
    ok: false,
  };
  const visuals: ImageCaseVisuals = {
    caseId: testCase.id,
    compositeCanvas: sourceCanvas,
    groundTruthAlphaCanvas,
    predictedAlphaCanvas: null,
    predictedForegroundCanvas: null,
  };

  try {
    const result = await removeBackgroundFromImage(sourceCanvas, scene.width, scene.height);
    // The pipeline is defined to return alpha at exactly the requested
    // width/height (remove-background.ts resizes internally) — same-size
    // ground truth means metrics never need a resampling step of their own,
    // which would add its own error into the comparison.
    if (result.alphaWidth !== scene.width || result.alphaHeight !== scene.height) {
      throw new Error(`Pipeline returned alpha at ${result.alphaWidth}x${result.alphaHeight}, expected ${scene.width}x${scene.height}.`);
    }
    visuals.predictedAlphaCanvas = alphaToGrayscaleCanvas(result.alpha, scene.width, scene.height);
    visuals.predictedForegroundCanvas = result.foreground;
    return {
      measurement: {
        ...base,
        ok: true,
        modelUsed: result.modelUsed,
        confidence: result.confidence,
        metrics: computeImageMetrics(result.alpha, scene.groundTruthAlpha, scene.width, scene.height),
      },
      visuals,
    };
  } catch (err) {
    return { measurement: { ...base, error: err instanceof Error ? err.message : String(err) }, visuals };
  }
}

async function runOneVideoCase(testCase: VideoDatasetCase): Promise<VideoCaseMeasurement> {
  const frames = testCase.build();
  const predAlphas: Float32Array[] = [];
  const gtAlphas: Float32Array[] = [];
  const perFrameMetrics: ImageMetrics[] = [];
  let modelUsed: string | undefined;
  let lastError: string | undefined;

  for (const frame of frames) {
    const canvas = rgbaToCanvas(frame.compositeRgba, frame.width, frame.height);
    try {
      const result = await removeBackgroundFromImage(canvas, frame.width, frame.height);
      if (result.alphaWidth !== frame.width || result.alphaHeight !== frame.height) {
        throw new Error(`Pipeline returned alpha at ${result.alphaWidth}x${result.alphaHeight}, expected ${frame.width}x${frame.height}.`);
      }
      modelUsed = result.modelUsed;
      predAlphas.push(result.alpha);
      gtAlphas.push(frame.groundTruthAlpha);
      perFrameMetrics.push(computeImageMetrics(result.alpha, frame.groundTruthAlpha, frame.width, frame.height));
    } catch (err) {
      // One bad frame doesn't fail the whole clip — mirrors this app's own
      // production video-cutout behavior (video-cutout.ts).
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const base = {
    caseId: testCase.id,
    category: "video" as const,
    subcategory: testCase.subcategory,
    description: testCase.description,
    framesProcessed: perFrameMetrics.length,
    framesTotal: frames.length,
  };

  if (perFrameMetrics.length === 0) {
    return { ...base, ok: false, error: lastError ?? "No frames processed." };
  }

  const meanMetrics: ImageMetrics = {
    sad: perFrameMetrics.reduce((s, m) => s + m.sad, 0) / perFrameMetrics.length,
    mse: perFrameMetrics.reduce((s, m) => s + m.mse, 0) / perFrameMetrics.length,
    mad: perFrameMetrics.reduce((s, m) => s + m.mad, 0) / perFrameMetrics.length,
    gradientError: perFrameMetrics.reduce((s, m) => s + m.gradientError, 0) / perFrameMetrics.length,
    connectivityError: perFrameMetrics.reduce((s, m) => s + m.connectivityError, 0) / perFrameMetrics.length,
  };

  return {
    ...base,
    ok: true,
    error: lastError,
    modelUsed,
    meanMetrics,
    // Only meaningful when every frame succeeded — a dropped frame breaks
    // the consecutive-pairs assumption temporalConsistencyError relies on.
    temporalConsistencyError: predAlphas.length === frames.length ? temporalConsistencyError(predAlphas, gtAlphas) : undefined,
  };
}

export async function runQualityBenchmark(
  onProgress?: (completed: number, total: number, label: string) => void,
): Promise<QualityRunResult> {
  const total = DATASET_CASES.length + VIDEO_CASES.length;
  let completed = 0;
  const imageMeasurements: ImageCaseMeasurement[] = [];
  const videoMeasurements: VideoCaseMeasurement[] = [];
  const visuals = new Map<string, ImageCaseVisuals>();

  for (const testCase of DATASET_CASES) {
    onProgress?.(completed, total, testCase.id);
    const { measurement, visuals: v } = await runOneImageCase(testCase);
    imageMeasurements.push(measurement);
    visuals.set(testCase.id, v);
    completed++;
  }
  for (const testCase of VIDEO_CASES) {
    onProgress?.(completed, total, testCase.id);
    videoMeasurements.push(await runOneVideoCase(testCase));
    completed++;
  }
  onProgress?.(total, total, "done");

  return { imageMeasurements, videoMeasurements, visuals, generatedAt: new Date().toISOString() };
}
