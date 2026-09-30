import { useRef, useState } from "react";
import { runFfmpeg, FfmpegCancelledError } from "../ffmpeg/engine";
import { removeBackgroundFromImage, type ImageBgRemovalResult, type ImageBgRemovalMattingInfo } from "../media/bg-removal-image";
import { IMAGE_FORMAT_EXTENSIONS, type ImageExportFormat } from "../media/image-export";
import type { ChromaSettings, BgReplaceSettings } from "../media/bg-removal-canvas";
import {
  buildChromaRemovalCommand,
  buildAiCutoutRemovalCommand,
  type BgReplaceExportSettings,
} from "../ffmpeg/bg-removal-command";
import type { CutoutFrame, CutoutProgress } from "../captions/person-cutout";
import { MattingError } from "../matting/pipeline";

function describeError(err: unknown): string {
  if (err instanceof MattingError) {
    if (err.code === "NO_ELIGIBLE_MODEL") {
      return "No AI matting model is available for this request right now.";
    }
    return "Couldn't find a clear subject to cut out of this image — try green-screen mode instead, or a photo with a clearer subject.";
  }
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
  /** Only set for the image AI path — see src/lib/matting/pipeline. Video AI mode runs the same router-driven pipeline per sampled frame (see video-cutout.ts) but doesn't surface per-export matting info here; chroma mode never does. */
  const [matting, setMatting] = useState<ImageBgRemovalMattingInfo | null>(null);
  /** True when the user picked WebP/TIFF but this browser couldn't actually honor it and the export silently used PNG instead — see encodeCanvasForExport. */
  const [formatFellBack, setFormatFellBack] = useState(false);
  // PHASE 14 — PERFORMANCE (cancellation). Only the two ffmpeg-backed video
  // paths use this — runImage's matting inference has no cancellable API
  // (onnxruntime-web's session.run() takes no AbortSignal), and is a single
  // fast-enough call rather than a long loop, unlike video export.
  const abortRef = useRef<AbortController | null>(null);

  const start = (label: string) => {
    setIsProcessing(true);
    setError(null);
    setEnginePhase("engine");
    setEngineFraction(0);
    setRunFraction(0);
    setRunLabel(label);
    setMatting(null);
    setFormatFellBack(false);
  };

  const finish = (blob: Blob, filename: string, cutoutBlob?: Blob, mattingInfo?: ImageBgRemovalMattingInfo) => {
    setResult({ url: URL.createObjectURL(blob), blob, filename });
    if (cutoutBlob) setCutoutUrl(URL.createObjectURL(cutoutBlob));
    if (mattingInfo) setMatting(mattingInfo);
  };

  const fail = (err: unknown) => {
    console.error(err);
    setError(describeError(err));
  };

  const runImage = async (
    file: File,
    opts: { mode: "chroma" | "ai"; chroma?: ChromaSettings; replace: BgReplaceSettings; format?: ImageExportFormat },
    filenameBase: string,
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
      setFormatFellBack(res.formatFellBack);
      finish(res.blob, `${filenameBase}.${IMAGE_FORMAT_EXTENSIONS[res.format]}`, res.cutoutBlob, res.matting);
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
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const cmd = buildChromaRemovalCommand(input);
      const { blob } = await runFfmpeg({
        ...cmd,
        signal: controller.signal,
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
      if (!(err instanceof FfmpegCancelledError)) fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
      abortRef.current = null;
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
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const cmd = buildAiCutoutRemovalCommand(input);
      const { blob } = await runFfmpeg({
        ...cmd,
        signal: controller.signal,
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
      if (!(err instanceof FfmpegCancelledError)) fail(err);
    } finally {
      setIsProcessing(false);
      setEnginePhase(null);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const reset = () => {
    if (result) URL.revokeObjectURL(result.url);
    if (cutoutUrl) URL.revokeObjectURL(cutoutUrl);
    setResult(null);
    setCutoutUrl(null);
    setError(null);
    setMatting(null);
    setFormatFellBack(false);
  };

  /**
   * PHASE 12 — BACKGROUND REMOVAL UI. Lets a caller that already produced a
   * final blob itself (the AI-image REFINE/APPLY step in
   * RemoveBackgroundTool.tsx, which composites a Phase 6/11-refined alpha
   * without going through runImage's own model+composite call) still land
   * on the exact same result/ResultPanel UI as every other export path,
   * instead of that screen needing its own parallel implementation.
   */
  const finishWithBlob = (blob: Blob, filename: string, cutoutBlob?: Blob, mattingInfo?: ImageBgRemovalMattingInfo, fellBack?: boolean) => {
    setFormatFellBack(!!fellBack);
    finish(blob, filename, cutoutBlob, mattingInfo);
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
    matting,
    formatFellBack,
    runImage,
    runVideoChroma,
    runVideoAi,
    finishWithBlob,
    cancel,
    reset,
  };
}
