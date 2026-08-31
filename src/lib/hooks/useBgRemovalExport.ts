import { useState } from "react";
import { runFfmpeg } from "../ffmpeg/engine";
import { removeBackgroundFromImage, type ImageBgRemovalResult } from "../media/bg-removal-image";
import type { ChromaSettings, BgReplaceSettings } from "../media/bg-removal-canvas";
import {
  buildChromaRemovalCommand,
  buildAiCutoutRemovalCommand,
  type BgReplaceExportSettings,
} from "../ffmpeg/bg-removal-command";
import type { CutoutFrame, CutoutProgress } from "../captions/person-cutout";

function describeError(err: unknown): string {
  if (err instanceof Error && err.message === "NO_SUBJECT") {
    return "Couldn't find a subject to cut out of this clip — try green-screen mode instead, or a clip with a clearer person/object in frame.";
  }
  return "Something went wrong removing the background. Try a different file, or the other mode (green screen vs. AI).";
}

/**
 * Drives every export path of the Remove Background tool — chroma-key or AI
 * cutout, image or video — behind one engine/run progress shape so it drops
 * straight into the shared ExportStatus component, same as the other tools'
 * export hooks (useFfmpegExport, useUpscaleExport).
 */
export function useBgRemovalExport() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [enginePhase, setEnginePhase] = useState<"engine" | "run" | null>(null);
  const [engineFraction, setEngineFraction] = useState(0);
  const [runFraction, setRunFraction] = useState(0);
  const [runLabel, setRunLabel] = useState("Processing…");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob; filename: string } | null>(null);
  const [cutoutUrl, setCutoutUrl] = useState<string | null>(null);

  const start = (label: string) => {
    setIsProcessing(true);
    setError(null);
    setEnginePhase("engine");
    setEngineFraction(0);
    setRunFraction(0);
    setRunLabel(label);
  };

  const finish = (blob: Blob, filename: string, cutoutBlob?: Blob) => {
    setResult({ url: URL.createObjectURL(blob), blob, filename });
    if (cutoutBlob) setCutoutUrl(URL.createObjectURL(cutoutBlob));
  };

  const fail = (err: unknown) => {
    console.error(err);
    setError(describeError(err));
  };

  const runImage = async (
    file: File,
    opts: { mode: "chroma" | "ai"; chroma?: ChromaSettings; replace: BgReplaceSettings },
    filename: string,
  ) => {
    start(opts.mode === "ai" ? "Downloading AI model…" : "Removing background…");
    try {
      const res: ImageBgRemovalResult = await removeBackgroundFromImage(file, opts, (p: CutoutProgress) => {
        if (p.phase === "downloading") {
          setEnginePhase("engine");
          setEngineFraction(p.fraction);
        } else {
          setEnginePhase("run");
          setRunLabel("Cutting out the subject…");
          setRunFraction(p.fraction);
        }
      });
      finish(res.blob, filename, res.cutoutBlob);
    } catch (err) {
      fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
    }
  };

  const runVideoChroma = async (
    input: {
      file: File;
      width: number;
      height: number;
      trimStart: number;
      trimEnd: number;
      replace: BgReplaceExportSettings;
      chroma: ChromaSettings;
    },
    filename: string,
  ) => {
    start("Removing background…");
    try {
      const cmd = buildChromaRemovalCommand(input);
      const { blob } = await runFfmpeg({
        ...cmd,
        onEngineLoad: (f) => {
          setEngineFraction(f);
          if (f >= 1) setEnginePhase("run");
        },
        onRunProgress: (f) => {
          setEnginePhase("run");
          setRunFraction(f);
        },
      });
      finish(blob, filename);
    } catch (err) {
      fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
    }
  };

  const runVideoAi = async (
    input: {
      file: File;
      width: number;
      height: number;
      trimStart: number;
      trimEnd: number;
      replace: BgReplaceExportSettings;
      cutoutFrames: CutoutFrame[];
    },
    filename: string,
  ) => {
    start("Rendering video…");
    try {
      const cmd = buildAiCutoutRemovalCommand(input);
      const { blob } = await runFfmpeg({
        ...cmd,
        onEngineLoad: (f) => {
          setEngineFraction(f);
          if (f >= 1) setEnginePhase("run");
        },
        onRunProgress: (f) => {
          setEnginePhase("run");
          setRunFraction(f);
        },
      });
      finish(blob, filename);
    } catch (err) {
      fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
    }
  };

  const reset = () => {
    if (result) URL.revokeObjectURL(result.url);
    if (cutoutUrl) URL.revokeObjectURL(cutoutUrl);
    setResult(null);
    setCutoutUrl(null);
    setError(null);
  };

  return {
    isProcessing,
    enginePhase,
    engineFraction,
    runFraction,
    runLabel,
    error,
    result,
    cutoutUrl,
    runImage,
    runVideoChroma,
    runVideoAi,
    reset,
  };
}
