import { sampleTrimmedFrames, type CutoutFrame, type CutoutProgress } from "../../captions/person-cutout";
import { removeBackgroundFromImage as runMattingPipeline } from "./remove-background";

/**
 * Video AI mode's entry point into the router-driven matting pipeline —
 * same sparse-sample-and-hold architecture generateSubjectCutouts
 * (../../captions/person-cutout.ts) already used with RMBG-1.4 directly,
 * but each sampled frame now goes through the full router (model selection
 * + alpha refinement + edge refinement + colour decontamination + quality
 * analysis) instead of calling RMBG-1.4 directly. This is what "begin with video AI
 * mode" (of the two-part request that also asked for Phase 2 refinement)
 * means concretely: video gets the same license-safe model preference and
 * quality pipeline images already have, without building the full dense
 * per-frame alpha-video architecture MATTE_IMPLEMENTATION_PLAN.md's Phase 2
 * describes (that remains future work — this reuses the existing sparse
 * sampling, it doesn't replace it).
 *
 * A frame the pipeline fails on (see removeBackgroundFromImage's MattingError
 * contract) is skipped — sampleTrimmedFrames already treats a null blob as
 * "drop this sample," so one bad frame doesn't fail the whole clip.
 */
export async function generateSubjectCutoutsViaMatting(
  video: HTMLVideoElement,
  { start, end, onProgress, signal }: { start: number; end: number; onProgress?: (p: CutoutProgress) => void; signal?: AbortSignal },
): Promise<CutoutFrame[]> {
  return sampleTrimmedFrames(video, {
    start,
    end,
    onProgress,
    signal,
    produceBlob: async (canvas) => {
      try {
        const result = await runMattingPipeline(canvas, canvas.width, canvas.height, {
          onModelLoadProgress: (fraction) => onProgress?.({ phase: "downloading", fraction }),
        });
        return await new Promise<Blob | null>((resolve) => result.foreground.toBlob((b) => resolve(b), "image/png"));
      } catch {
        // A single frame's model failure (e.g. NO_SUBJECT on a frame where
        // the subject briefly left view) shouldn't fail the whole clip —
        // sampleTrimmedFrames already drops a null blob and moves on.
        return null;
      }
    },
  });
}
