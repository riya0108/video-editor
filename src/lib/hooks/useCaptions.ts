import { useCallback, useState } from "react";
import { generateCaptions, type CaptionModelTier, type CaptionProgress } from "../captions/auto-caption";
import { CAPTION_STYLE_PRESETS, DEFAULT_CAPTION_STYLE } from "../captions/caption-styles";
import { isSubtitleFile, parseSubtitleText } from "../captions/subtitle-parser";
import { translateCues, type TranslateProgress } from "../captions/translate";
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

  const [isTranslating, setIsTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState<TranslateProgress | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

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

  /**
   * `rangeStart`/`rangeEnd` are the current trim range (or video duration if
   * untrimmed) — new cues are clamped inside it so they're never silently
   * unplayable (which looked, to users, like typing captions did nothing).
   */
  const addCue = useCallback((afterSeconds = 0, rangeStart = 0, rangeEnd = Infinity) => {
    const id = nextCaptionId();
    setCues((prev) => {
      const last = [...prev].sort((a, b) => a.start - b.start).at(-1);
      const defaultLen = 3;
      const minLen = 0.1;
      const anchor = last ? last.end : afterSeconds;
      const start = Math.min(Math.max(anchor, rangeStart), Math.max(rangeStart, rangeEnd - minLen));
      const end = Math.min(start + defaultLen, Math.max(rangeEnd, start + minLen));
      return [...prev, { id, start, end, text: "" }].sort((a, b) => a.start - b.start);
    });
    return id;
  }, []);

  const updateCue = useCallback((id: string, patch: Partial<CaptionCue>, rangeStart = 0, rangeEnd = Infinity) => {
    setCues((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        if (patch.start !== undefined || patch.end !== undefined) {
          const minLen = 0.1;
          next.start = Math.min(Math.max(next.start, rangeStart), Math.max(rangeStart, rangeEnd - minLen));
          next.end = Math.min(Math.max(next.end, next.start + minLen), Math.max(rangeEnd, next.start + minLen));
        }
        // Karaoke word-level rendering (CaptionOverlay, and the export-side
        // buildCaptionsFilter/measureKaraokeLayouts) reads word text from
        // `c.words`, not `c.text` — so editing a cue's text with word timing
        // already attached would otherwise leave the old words on screen. If
        // the word count didn't change, re-point each word's `text` at the
        // matching new word so its original per-word timing (and karaoke
        // highlight) survives a typo fix. Otherwise there's no honest way to
        // re-time invented/removed words, so word data is dropped and the
        // cue falls back to static whole-line text — same graceful
        // degradation `translate` already relies on for the same reason.
        if (patch.text !== undefined && c.words && c.words.length > 0) {
          const newWords = patch.text.trim().split(/\s+/).filter(Boolean);
          next.words =
            newWords.length === c.words.length
              ? c.words.map((w, i) => ({ ...w, text: newWords[i] }))
              : undefined;
        }
        return next;
      }),
    );
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

  const translate = useCallback(
    async (targetCode: string, sourceCode: string) => {
      setIsTranslating(true);
      setTranslateError(null);
      setTranslateProgress({ phase: "downloading", fraction: 0 });
      try {
        const translated = await translateCues(cues, targetCode, sourceCode, setTranslateProgress);
        setCues(translated);
      } catch (err) {
        console.error(err);
        setTranslateError("Couldn't translate these captions. Try again, or a different language pair.");
      } finally {
        setIsTranslating(false);
        setTranslateProgress(null);
      }
    },
    [cues],
  );

  const reset = useCallback(() => {
    setCues([]);
    setSourceMode("auto");
    setGenError(null);
    setUploadError(null);
    setTranslateError(null);
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
    isTranslating,
    translateProgress,
    translateError,
    translate,
    reset,
  };
}
