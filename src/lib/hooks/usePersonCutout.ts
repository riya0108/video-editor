import { useCallback, useRef, useState } from "react";
import {
  generatePersonCutouts,
  revokeCutoutFrames,
  type CutoutFrame,
  type CutoutProgress,
} from "../captions/person-cutout";

/** Manages the sampled person-cutout frames behind the "Behind a person" caption style — generation is manual (triggered from the UI) since it's a real, potentially slow, in-browser ML pass. */
export function usePersonCutout() {
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
      const next = await generatePersonCutouts(video, { start, end, onProgress: setProgress });
      revokeCutoutFrames(framesRef.current);
      framesRef.current = next;
      setFrames(next);
      if (next.length === 0) setError("Couldn't detect a person in this clip — try a different style instead.");
    } catch (err) {
      console.error(err);
      setError("Couldn't generate the person cutout for this clip. Try a different style instead.");
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  }, []);

  const clear = useCallback(() => {
    revokeCutoutFrames(framesRef.current);
    framesRef.current = [];
    setFrames([]);
    setError(null);
  }, []);

  return { frames, isGenerating, progress, error, generate, clear };
}
