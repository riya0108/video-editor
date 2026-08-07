import { useState } from "react";
import { runFfmpeg, FfmpegRunError, type RunOptions } from "../ffmpeg/engine";

type RunInput = Omit<RunOptions, "onEngineLoad" | "onRunProgress">;

function describeError(err: unknown): string {
  if (err instanceof FfmpegRunError) {
    if (/matches no streams|Stream specifier/i.test(err.logTail)) {
      return "One of your files doesn't have an audio track, which this tool needs. Try a different file, or add audio to it first.";
    }
    if (/Invalid data found when processing input/i.test(err.logTail)) {
      return "That file doesn't look like a format we can read. Try converting it to MP4 first.";
    }
  }
  return "Something went wrong processing your file. Try a different file, or convert it to MP4 first.";
}

/**
 * Orchestrates a single ffmpeg export: engine-load progress, run progress,
 * the resulting blob, and error state. Shared by every tool so each one only
 * has to build its own ffmpeg args and call run().
 */
export function useFfmpegExport() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [enginePhase, setEnginePhase] = useState<"engine" | "run" | null>(null);
  const [engineFraction, setEngineFraction] = useState(0);
  const [runFraction, setRunFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob; filename: string } | null>(
    null,
  );

  const run = async (opts: RunInput, filename: string) => {
    setIsProcessing(true);
    setError(null);
    setEnginePhase("engine");
    setEngineFraction(0);
    setRunFraction(0);
    try {
      const { url, blob } = await runFfmpeg({
        ...opts,
        onEngineLoad: (f) => {
          setEngineFraction(f);
          if (f >= 1) setEnginePhase("run");
        },
        onRunProgress: (f) => {
          setEnginePhase("run");
          setRunFraction(f);
        },
      });
      setResult({ url, blob, filename });
    } catch (err) {
      console.error(err);
      setError(describeError(err));
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
    }
  };

  const reset = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setError(null);
  };

  return {
    isProcessing,
    enginePhase,
    engineFraction,
    runFraction,
    error,
    result,
    run,
    reset,
  };
}
