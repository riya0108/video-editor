import { useCallback, useState } from "react";
import { generateCaptions, type CaptionModelTier, type CaptionProgress } from "../captions/auto-caption";
import { CAPTION_STYLE_PRESETS, DEFAULT_CAPTION_STYLE } from "../captions/caption-styles";
import { isSubtitleFile, parseSubtitleText } from "../captions/subtitle-parser";
import { nextCaptionId, type CaptionCue, type CaptionStyle } from "../captions/types";

export type CaptionSourceMode = "auto" | "manual" | "upload";

export function useCaptions() {
  const [sourceMode, setSourceMode] = useState<CaptionSourceMode>("auto");
  const [cues, setCues] = useState<CaptionCue[]>([]);
  const [style, setStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [presetId, setPresetId] = useState<string>(CAPTION_STYLE_PRESETS[0].id);

  const [isGenerating, setIsGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<CaptionProgress | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const [uploadError, setUploadError] = useState<string | null>(null);

  const applyPreset = useCallback((id: string) => {
    const preset = CAPTION_STYLE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setStyle(preset.style);
  }, []);

  const updateStyle = useCallback((patch: Partial<CaptionStyle>) => {
    setPresetId("");
    setStyle((prev) => ({ ...prev, ...patch }));
  }, []);

  const addCue = useCallback((afterSeconds = 0) => {
    setCues((prev) => {
      const last = [...prev].sort((a, b) => a.start - b.start).at(-1);
      const start = last ? last.end : afterSeconds;
      return [...prev, { id: nextCaptionId(), start, end: start + 3, text: "" }].sort(
        (a, b) => a.start - b.start,
      );
    });
  }, []);

  const updateCue = useCallback((id: string, patch: Partial<CaptionCue>) => {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeCue = useCallback((id: string) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const autoGenerate = useCallback(
    async (videoFile: File, modelTier: CaptionModelTier, language: string) => {
      setIsGenerating(true);
      setGenError(null);
      setGenProgress({ phase: "downloading", fraction: 0 });
      try {
        const generated = await generateCaptions(videoFile, {
          modelTier,
          language,
          onProgress: setGenProgress,
        });
        if (generated.length === 0) {
          setGenError("No speech was detected in this video.");
        } else {
          setCues(generated);
        }
      } catch (err) {
        console.error(err);
        setGenError("Couldn't generate captions for this video. Try a different file, or enter captions manually.");
      } finally {
        setIsGenerating(false);
        setGenProgress(null);
      }
    },
    [],
  );

  const handleSubtitleFile = useCallback(async (file: File) => {
    setUploadError(null);
    if (!isSubtitleFile(file.name)) {
      setUploadError("Choose a .srt or .vtt subtitle file.");
      return;
    }
    const text = await file.text();
    const parsed = parseSubtitleText(text);
    if (parsed.length === 0) {
      setUploadError("Couldn't find any timed captions in that file.");
      return;
    }
    setCues(parsed);
  }, []);

  const reset = useCallback(() => {
    setCues([]);
    setSourceMode("auto");
    setGenError(null);
    setUploadError(null);
  }, []);

  return {
    sourceMode,
    setSourceMode,
    cues,
    setCues,
    addCue,
    updateCue,
    removeCue,
    style,
    presetId,
    applyPreset,
    updateStyle,
    isGenerating,
    genProgress,
    genError,
    autoGenerate,
    uploadError,
    handleSubtitleFile,
    reset,
  };
}
