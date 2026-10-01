import { sampleTrimmedFrames, type CutoutProgress } from "../../captions/person-cutout";
import { removeBackgroundFromImage } from "../pipeline";

/**
 * MATTE COMPARISON VIEWER — video mode. Thin wrapper around the existing,
 * unmodified `sampleTrimmedFrames` (person-cutout.ts) — reuses its exact
 * sampling/seeking/cap/pipelining/cancellation behavior verbatim, the same
 * way `video-cutout.ts`'s production video AI-cutout path does, rather than
 * reimplementing any of it. The only difference from `video-cutout.ts` is
 * WHAT gets captured per sample: production only needs a PNG blob, but the
 * viewer needs the full `MattingResult` (raw alpha, source rgba, dimensions)
 * to drive every view mode — captured via `produceBlob`'s closure into a
 * side array, since `sampleTrimmedFrames`'s own return type is blob-only.
 *
 * This module does not touch `video-cutout.ts` or any production call site.
 */

export interface ViewerSample {
  /**
   * Seconds from the start of the video. `sampleTrimmedFrames` doesn't pass
   * each sample's real seek timestamp to `produceBlob` (only its index),
   * and its internal fps/cap logic (`pickCutoutSampleFps`/`capSampleTimes`)
   * isn't fully exported — duplicating that private cap logic here just to
   * recover exact timestamps would be fragile against upstream changes.
   * Since samples are pushed in strict chronological order (confirmed: at
   * most one in-flight `produceBlob` call at a time — see person-cutout.ts's
   * own doc comment), this is instead reconstructed as an EVEN spread across
   * [start, end] by final position once sampling completes — very close to
   * the real (roughly-uniform-step) timestamps for display/nearest-lookup
   * purposes, but explicitly an approximation, not a frame-exact value.
   */
  time: number;
  alpha: Float32Array;
  /** The real source frame this sample was computed from — needed for every composite view mode. */
  sourceRgba: Uint8ClampedArray;
  /** The pipeline's own decontaminated transparent cutout — used directly for the "AI Result" view. */
  foreground: HTMLCanvasElement;
  width: number;
  height: number;
  warnings: string[];
  modelUsed: string;
}

type RawSample = Omit<ViewerSample, "time">;

export async function sampleVideoMatte(
  video: HTMLVideoElement,
  {
    start,
    end,
    onProgress,
    signal,
  }: { start: number; end: number; onProgress?: (p: CutoutProgress) => void; signal?: AbortSignal },
): Promise<ViewerSample[]> {
  const raw: RawSample[] = [];

  await sampleTrimmedFrames(video, {
    start,
    end,
    onProgress,
    signal,
    produceBlob: async (canvas) => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const sourceRgba = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : new Uint8ClampedArray(canvas.width * canvas.height * 4);
      try {
        const result = await removeBackgroundFromImage(canvas, canvas.width, canvas.height, {
          onModelLoadProgress: (fraction) => onProgress?.({ phase: "downloading", fraction }),
        });
        raw.push({
          alpha: result.alpha,
          sourceRgba,
          foreground: result.foreground,
          width: canvas.width,
          height: canvas.height,
          warnings: result.warnings,
          modelUsed: result.modelUsed,
        });
      } catch {
        // Matches production's own "one bad frame doesn't fail the whole
        // clip" behavior (video-cutout.ts) — just skip this sample.
      }
      // sampleTrimmedFrames only uses this to decide whether to keep a
      // CutoutFrame; the viewer reads `raw` instead, so `null` is always
      // correct here regardless of success/failure above.
      return null;
    },
  });

  if (raw.length === 0) return [];
  const span = Math.max(0, end - start);
  return raw.map((s, i) => ({ ...s, time: start + (raw.length > 1 ? (i / (raw.length - 1)) * span : 0) }));
}

/** Picks the sample closest to (and no later than) `time` — the sample-and-hold lookup the viewer's synchronized playback uses, matching how production's own video-cutout path is actually experienced (sparse samples, held between updates) rather than pretending to recompute every frame live. Falls back to the nearest sample overall if `time` is before every sample. */
export function nearestSampleAtOrBefore(samples: ViewerSample[], time: number): ViewerSample | null {
  if (samples.length === 0) return null;
  let best = samples[0];
  for (const s of samples) {
    if (s.time <= time) best = s;
    else break;
  }
  return best;
}
