import { useCallback, useRef, useState } from "react";
import {
  generatePersonCutouts,
  revokeCutoutFrames,
  type CutoutFrame,
  type CutoutProgress,
} from "../captions/person-cutout";
import { generateSubjectCutoutsViaMatting } from "../matting/pipeline/video-cutout";

/**
 * Manages sampled cutout frames, generated on demand (a real, potentially
 * slow, in-browser ML pass) — shared by two different callers:
 * - "person" (default): the "Behind a person" caption style, backed by the
 *   small/fast person-only selfie model.
 * - "subject": the Remove Background tool's video AI mode, backed by the
 *   router-driven matting pipeline (src/lib/matting/pipeline) so it can find
 *   any subject (hand, product, gadget, person), not just people — and,
 *   like the image path, prefers U²-Net/MODNet/selfie-segmenter over
 *   RMBG-1.4 by default (see MODEL_LICENSES.md).
 */
export function usePersonCutout(kind: "person" | "subject" = "person") {
  const [frames, setFrames] = useState<CutoutFrame[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<CutoutProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const framesRef = useRef<CutoutFrame[]>([]);
  // PHASE 14 — PERFORMANCE (cancellation). sampleTrimmedFrames checks this
  // between frames — genuinely effective (unlike ffmpeg's), since this is
  // this app's own JS loop, not a single opaque native call.
  const abortRef = useRef<AbortController | null>(null);

  const generate = useCallback(async (video: HTMLVideoElement, start: number, end: number) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setError(null);
    setProgress({ phase: "downloading", fraction: 0 });
    try {
      const generator = kind === "subject" ? generateSubjectCutoutsViaMatting : generatePersonCutouts;
      const next = await generator(video, { start, end, onProgress: setProgress, signal: controller.signal });
      // PHASE — PRODUCTION READINESS (C1). A cancelled run can still have
      // produced some frames (sampling checks the signal between frames, not
      // mid-frame) — adopting `next` here regardless of `aborted` would let
      // export proceed as if the cutout covered the whole trimmed range, when
      // it silently only covers the fraction completed before Cancel was
      // pressed. Discard the partial result instead of shipping it as if it
      // were a real, complete success.
      if (controller.signal.aborted) {
        revokeCutoutFrames(next);
        return;
      }
      revokeCutoutFrames(framesRef.current);
      framesRef.current = next;
      setFrames(next);
      if (next.length === 0) {
        setError(
          kind === "subject"
            ? "Couldn't detect a subject in this clip — try green-screen mode instead, or a clip with a clearer subject in frame."
            : "Couldn't detect a person in this clip — try a different style instead.",
        );
      }
    } catch (err) {
      console.error(err);
      setError(
        kind === "subject"
          ? "Couldn't generate the subject cutout for this clip. Try green-screen mode instead."
          : "Couldn't generate the person cutout for this clip. Try a different style instead.",
      );
    } finally {
      setIsGenerating(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [kind]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    revokeCutoutFrames(framesRef.current);
    framesRef.current = [];
    setFrames([]);
    setError(null);
  }, []);

  return { frames, isGenerating, progress, error, generate, cancel, clear };
}
