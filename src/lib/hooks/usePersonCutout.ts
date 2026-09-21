import { useCallback, useRef, useState } from "react";
import {
  generatePersonCutouts,
  generateSubjectCutouts,
  revokeCutoutFrames,
  type CutoutFrame,
  type CutoutProgress,
} from "../captions/person-cutout";

/**
 * Manages sampled cutout frames, generated on demand (a real, potentially
 * slow, in-browser ML pass) — shared by two different callers:
 * - "person" (default): the "Behind a person" caption style, backed by the
 *   small/fast person-only selfie model.
 * - "subject": the Remove Background tool's video AI mode, backed by
 *   RMBG-1.4 so it can find any subject (hand, product, gadget, person),
 *   not just people.
 */
export function usePersonCutout(kind: "person" | "subject" = "person") {
  const [frames, setFrames] = useState<CutoutFrame[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<CutoutProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const framesRef = useRef<CutoutFrame[]>([]);

  const generate = useCallback(async (video: HTMLVideoElement, start: number, end: number) => {
    setIsGenerating(true);
    setError(null);
    setProgress({ phase: "downloading", fraction: 0 });
    try {
      const generator = kind === "subject" ? generateSubjectCutouts : generatePersonCutouts;
      const next = await generator(video, { start, end, onProgress: setProgress });
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
    }
  }, [kind]);

  const clear = useCallback(() => {
    revokeCutoutFrames(framesRef.current);
    framesRef.current = [];
    setFrames([]);
    setError(null);
  }, []);

  return { frames, isGenerating, progress, error, generate, clear };
}
