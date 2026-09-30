import { useState } from "react";
import { removeBackgroundFromImage, MattingError, type MattingResult } from "../matting/pipeline";

/**
 * PHASE 12 — BACKGROUND REMOVAL UI. Runs ONLY the matte-generation stage
 * (model selection + Phase 2-4 alpha refinement/decontamination — see
 * src/lib/matting/pipeline/remove-background.ts) for a still image, without
 * compositing it onto any replacement background. This is the concrete
 * "separate MATTE GENERATION from COMPOSITING" split for this tool: the
 * result (`MattingResult`, including the raw alpha) feeds
 * useMatteRefinement.ts's REFINE step and, ultimately, whatever background
 * the user picks — the model never runs again after this call, no matter
 * how many times the preview background or brush edits change.
 *
 * Chroma-key mode and video (both still handled by useBgRemovalExport.ts's
 * existing runImage/runVideoChroma/runVideoAi) don't go through this at
 * all — chroma is already a precise, instant per-pixel key with no model to
 * separate from anything, and per-frame video refinement is a
 * fundamentally different (and much larger) interactive UI problem this
 * phase doesn't attempt.
 */
function describeMatteError(err: unknown): string {
  if (err instanceof MattingError) {
    if (err.code === "NO_ELIGIBLE_MODEL") return "No AI matting model is available for this request right now.";
    return "Couldn't find a clear subject to cut out of this image — try green-screen mode instead, or a photo with a clearer subject.";
  }
  return "Something went wrong analyzing this image. Try a different file, or green-screen mode.";
}

export function useAiImageMatte() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MattingResult | null>(null);

  const generate = async (source: HTMLImageElement, width: number, height: number) => {
    setIsProcessing(true);
    setError(null);
    setProgress(0);
    try {
      const res = await removeBackgroundFromImage(source, width, height, {
        onModelLoadProgress: (fraction) => setProgress(fraction),
      });
      setResult(res);
    } catch (err) {
      setError(describeMatteError(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
    setProgress(0);
  };

  return { isProcessing, progress, error, result, generate, reset };
}
