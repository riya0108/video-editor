import { useRef, useState } from "react";
import { upscaleImageFile, upscaleVideoFile, type VideoUpscaleProgress, type VideoUpscaleQuality } from "../upscale/upscale-media";
import type { UpscaleProgress } from "../upscale/real-esrgan";

function describeError(): string {
  return "Something went wrong upscaling your file. Try a different file, or a smaller target resolution.";
}

/** Formats a remaining-time estimate the way a person would say it — never finer than a second, never more than one unit pair. */
function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/**
 * Tracks how long the *current* progress phase has been running versus how
 * far it's gotten, so it can extrapolate a remaining-time estimate. Reset
 * whenever the phase key changes, since e.g. per-tile upscaling and final
 * encoding progress at wildly different rates and averaging across them
 * would make the estimate worse, not better.
 */
function useEtaTracker() {
  const trackerRef = useRef<{ key: string; start: number; startFraction: number } | null>(null);
  const [etaLabel, setEtaLabel] = useState<string | null>(null);

  const update = (key: string, fraction: number) => {
    const now = performance.now();
    const tracker = trackerRef.current;
    if (!tracker || tracker.key !== key) {
      trackerRef.current = { key, start: now, startFraction: fraction };
      setEtaLabel(null);
      return;
    }
    const elapsedMs = now - tracker.start;
    const progressDelta = fraction - tracker.startFraction;
    // Need a little real progress within this phase before extrapolating —
    // otherwise a fresh phase reports a wildly noisy (or infinite) estimate.
    if (progressDelta < 0.02 || elapsedMs < 500) return;
    const remainingMs = (elapsedMs / progressDelta) * (1 - fraction);
    setEtaLabel(remainingMs > 500 ? formatEta(remainingMs / 1000) : null);
  };

  const clear = () => {
    trackerRef.current = null;
    setEtaLabel(null);
  };

  return { etaLabel, update, clear };
}

/**
 * Drives the AI super-resolution upscale tool: mirrors useFfmpegExport's
 * engine/run progress shape (so it drops straight into ExportStatus) but
 * calls the real-ESRGAN pipeline instead of a single ffmpeg run, since that
 * pipeline reports a model-download phase plus per-frame progress rather
 * than one ffmpeg progress event.
 */
export function useUpscaleExport() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [enginePhase, setEnginePhase] = useState<"engine" | "run" | null>(null);
  const [engineFraction, setEngineFraction] = useState(0);
  const [runFraction, setRunFraction] = useState(0);
  const [runLabel, setRunLabel] = useState("Upscaling…");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob; filename: string } | null>(null);
  const eta = useEtaTracker();

  const start = () => {
    setIsProcessing(true);
    setError(null);
    setEnginePhase("engine");
    setEngineFraction(0);
    setRunFraction(0);
    setRunLabel("Upscaling…");
    eta.clear();
  };

  const finish = (blob: Blob, filename: string) => {
    setResult({ url: URL.createObjectURL(blob), blob, filename });
  };

  const fail = (err: unknown) => {
    console.error(err);
    setError(describeError());
  };

  const runImage = async (file: File, targetW: number, targetH: number, filename: string) => {
    start();
    try {
      const blob = await upscaleImageFile(file, targetW, targetH, (p: UpscaleProgress) => {
        if (p.phase === "downloading") {
          setEnginePhase("engine");
          setEngineFraction(p.fraction);
        } else {
          setEnginePhase("run");
          setRunLabel("Upscaling…");
          setRunFraction(p.fraction);
          eta.update(p.phase, p.fraction);
        }
      });
      finish(blob, filename);
    } catch (err) {
      fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
      eta.clear();
    }
  };

  const runVideo = async (
    file: File,
    targetW: number,
    targetH: number,
    quality: VideoUpscaleQuality,
    filename: string,
  ) => {
    start();
    try {
      const blob = await upscaleVideoFile(file, targetW, targetH, quality, (p: VideoUpscaleProgress) => {
        if (p.phase === "engine") {
          setEnginePhase("engine");
          setEngineFraction(p.fraction);
        } else if (p.phase === "extracting") {
          setEnginePhase("run");
          setRunLabel("Reading video frames…");
          setRunFraction(0);
        } else if (p.phase === "upscaling") {
          setEnginePhase("run");
          setRunLabel(`Upscaling frame ${p.frameIndex}/${p.frameCount}…`);
          setRunFraction(p.fraction);
          eta.update(p.phase, p.fraction);
        } else if (p.phase === "encoding") {
          setEnginePhase("run");
          setRunLabel("Encoding final video…");
          setRunFraction(p.fraction);
        }
      });
      finish(blob, filename);
    } catch (err) {
      fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
      eta.clear();
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
    runLabel,
    etaLabel: eta.etaLabel,
    error,
    result,
    runImage,
    runVideo,
    reset,
  };
}
