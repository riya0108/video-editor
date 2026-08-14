import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Sparkles,
  Upload,
  Pencil,
  Plus,
  Trash2,
  Palette,
  Captions as CaptionsIcon,
  List,
  Scan,
  RefreshCw,
  Languages,
  ArrowRightLeft,
} from "lucide-react";
import ProgressBar from "../ProgressBar";
import ToolPanelSection from "../ToolPanelSection";
import CaptionStylePreview from "./CaptionStylePreview";
import { CAPTION_MODELS, type CaptionModelTier } from "../../../lib/captions/auto-caption";
import { CAPTION_COLORS, CAPTION_STYLE_CATEGORIES, CAPTION_STYLE_PRESETS } from "../../../lib/captions/caption-styles";
import { CAPTION_LANGUAGES } from "../../../lib/captions/languages";
import { NLLB_LANGUAGES } from "../../../lib/captions/nllb-languages";
import { formatTimecode, parseTimecode } from "../../../lib/captions/time-format";
import type { CaptionCue } from "../../../lib/captions/types";
import { TEXT_FONTS } from "../../../lib/ffmpeg/fonts";
import { MAX_TEXT_SIZE } from "./editor/FloatingTextToolbar";
import { POSITION_PRESETS, isAtPositionPreset, type TextPositionPreset } from "../../../lib/ffmpeg/text-position-presets";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";
import type { usePersonCutout } from "../../../lib/hooks/usePersonCutout";

const SOURCE_TABS: { id: "auto" | "manual" | "upload"; label: string; icon: typeof Sparkles }[] = [
  { id: "auto", label: "Auto-generate", icon: Sparkles },
  { id: "manual", label: "Type manually", icon: Pencil },
  { id: "upload", label: "Upload file", icon: Upload },
];

const PANEL_TABS: { id: "edit" | "styles"; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "styles", label: "Styles" },
];

function TimeField({ seconds, onCommit }: { seconds: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState(formatTimecode(seconds));
  const [focused, setFocused] = useState(false);

  // Keep the field in sync with external changes (e.g. dragging the segment
  // on the timeline) as long as the user isn't actively typing in it.
  useEffect(() => {
    if (!focused) setDraft(formatTimecode(seconds));
  }, [seconds, focused]);

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        setFocused(true);
        setDraft(formatTimecode(seconds));
      }}
      onBlur={() => {
        setFocused(false);
        const parsed = parseTimecode(draft);
        if (parsed === null) {
          setDraft(formatTimecode(seconds));
          return;
        }
        onCommit(parsed);
        setDraft(formatTimecode(parsed));
      }}
      className="w-16 shrink-0 rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1 text-center text-caption tabular-nums outline-none focus:border-primary-400"
    />
  );
}

/** Controls only — see CaptionsPreview for the live video + burned-in caption preview that goes in the shared preview column. */
export default function CaptionsEditor({
  video,
  captions,
  personCutout,
  rangeStart = 0,
  rangeEnd,
}: {
  video: ReturnType<typeof useVideoFile>;
  captions: ReturnType<typeof useCaptions>;
  personCutout: ReturnType<typeof usePersonCutout>;
  /** Trim range (seconds) the person-cutout sampler should cover. Defaults to the whole clip. */
  rangeStart?: number;
  rangeEnd?: number;
}) {
  const [tab, setTab] = useState<"edit" | "styles">("edit");
  const [modelTier, setModelTier] = useState<CaptionModelTier>("fast");
  const [language, setLanguage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cueTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [pendingFocusCueId, setPendingFocusCueId] = useState<string | null>(null);
  const [translateSource, setTranslateSource] = useState("eng_Latn");
  const [translateTarget, setTranslateTarget] = useState("spa_Latn");

  const { style, presetId, cues } = captions;
  const effectiveEnd = rangeEnd ?? video.duration;

  // After adding a cue, jump straight to typing it instead of leaving the
  // user to scroll down and hunt for the new row themselves.
  useEffect(() => {
    if (!pendingFocusCueId) return;
    const el = cueTextareaRefs.current[pendingFocusCueId];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus();
    }
    setPendingFocusCueId(null);
  }, [pendingFocusCueId, cues]);

  const handleUploadChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) captions.handleSubtitleFile(file);
  };

  const handleGenerateCutout = () => {
    const el = video.videoRef.current;
    if (!el) return;
    personCutout.generate(el, rangeStart, effectiveEnd);
  };

  return (
    <>
      {/* ---- Edit / Styles tabs — mirrors the two-tab layout most caption
          tools use: everything about *what* the captions say lives under
          Edit, everything about *how* they look lives under Styles. ---- */}
      <div className="mb-4 flex gap-1 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-1">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`flex-1 rounded-md px-3 py-1.5 text-body-sm font-semibold transition-colors ${
              tab === t.id
                ? "bg-primary-500 text-white shadow-sm"
                : "text-(--color-text-muted) hover:bg-(--color-surface) hover:text-(--color-text)"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "edit" && (
        <>
          {/* ---- Source ---- */}
          <ToolPanelSection icon={CaptionsIcon} label="Captions source">
            <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
              {SOURCE_TABS.map((sourceTab) => (
                <button
                  key={sourceTab.id}
                  type="button"
                  onClick={() => captions.setSourceMode(sourceTab.id)}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-caption font-medium transition-colors ${
                    captions.sourceMode === sourceTab.id
                      ? "bg-primary-500 text-white"
                      : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  <sourceTab.icon size={13} />
                  {sourceTab.label}
                </button>
              ))}
            </div>

            <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-4">
              {captions.sourceMode === "auto" && (
                <div className="space-y-3">
                  <p className="text-body-sm text-(--color-text-muted)">
                    Transcribes the video's audio fully in your browser — works with any spoken language, and nothing
                    is uploaded anywhere.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                      Quality
                      <select
                        value={modelTier}
                        onChange={(e) => setModelTier(e.target.value as CaptionModelTier)}
                        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                      >
                        {(
                          Object.entries(CAPTION_MODELS) as [CaptionModelTier, (typeof CAPTION_MODELS)[CaptionModelTier]][]
                        ).map(([id, m]) => (
                          <option key={id} value={id}>
                            {m.label} ({m.sizeHint})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                      Spoken language
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                      >
                        {CAPTION_LANGUAGES.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={!video.file || captions.isGenerating}
                    onClick={() => video.file && captions.autoGenerate(video.file, modelTier, language)}
                    className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Sparkles size={15} />
                    {captions.isGenerating ? "Generating…" : "Generate captions"}
                  </button>
                  {captions.genProgress && (
                    <ProgressBar
                      label={captions.genProgress.phase === "downloading" ? "Downloading speech model…" : "Transcribing…"}
                      fraction={captions.genProgress.fraction}
                    />
                  )}
                  {captions.genError && <p className="text-body-sm text-danger-600">{captions.genError}</p>}
                </div>
              )}

              {captions.sourceMode === "manual" && (
                <div className="space-y-3">
                  <p className="text-body-sm text-(--color-text-muted)">
                    Add a line, set when it starts and ends, and type what it should say.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const id = captions.addCue(
                        video.videoRef.current?.currentTime ?? rangeStart,
                        rangeStart,
                        effectiveEnd,
                      );
                      setPendingFocusCueId(id);
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-surface)"
                  >
                    <Plus size={15} />
                    Add caption
                  </button>
                </div>
              )}

              {captions.sourceMode === "upload" && (
                <div className="space-y-3">
                  <p className="text-body-sm text-(--color-text-muted)">Upload an existing .srt or .vtt subtitle file.</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-surface)"
                  >
                    <Upload size={15} />
                    Choose subtitle file
                  </button>
                  <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="sr-only" onChange={handleUploadChange} />
                  {captions.uploadError && <p className="text-body-sm text-danger-600">{captions.uploadError}</p>}
                </div>
              )}
            </div>
          </ToolPanelSection>

          {/* ---- Cue list ---- right under the source controls, so adding/generating a
              caption and typing it happen in the same glance instead of a scroll away. */}
          <ToolPanelSection icon={List} label={`${cues.length} caption${cues.length === 1 ? "" : "s"}`}>
            {cues.length > 0 && (
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => captions.setCues([])}
                  className="text-caption text-(--color-text-muted) hover:text-danger-600"
                >
                  Clear all
                </button>
              </div>
            )}
            {cues.length === 0 ? (
              <p className="rounded-lg border border-dashed border-(--color-border) px-4 py-6 text-center text-body-sm text-(--color-text-muted)">
                No captions yet — generate, type, or upload some above.
              </p>
            ) : (
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {[...cues]
                  .sort((a, b) => a.start - b.start)
                  .map((cue: CaptionCue) => (
                    <div
                      key={cue.id}
                      className="flex items-start gap-2 rounded-md border border-(--color-border) bg-(--color-surface) p-2"
                    >
                      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
                        <TimeField
                          seconds={cue.start}
                          onCommit={(v) => captions.updateCue(cue.id, { start: v }, rangeStart, effectiveEnd)}
                        />
                        <span className="text-caption text-(--color-text-faint)">to</span>
                        <TimeField
                          seconds={cue.end}
                          onCommit={(v) => captions.updateCue(cue.id, { end: v }, rangeStart, effectiveEnd)}
                        />
                      </div>
                      <textarea
                        ref={(el) => {
                          cueTextareaRefs.current[cue.id] = el;
                        }}
                        value={cue.text}
                        onChange={(e) => captions.updateCue(cue.id, { text: e.target.value })}
                        rows={2}
                        placeholder="Caption text…"
                        className="flex-1 resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
                      />
                      <button
                        type="button"
                        aria-label="Delete caption"
                        onClick={() => captions.removeCue(cue.id)}
                        className="shrink-0 rounded p-1.5 text-(--color-text-muted) hover:bg-danger-50 hover:text-danger-600 dark:hover:bg-danger-950/40"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </ToolPanelSection>

          {/* ---- Translate ---- rewrites every cue's text into another
              language with an in-browser NLLB-200 model — same fully-local
              approach as auto-generate's Whisper model above. ---- */}
          <ToolPanelSection icon={Languages} label="Translate">
            {cues.length === 0 ? (
              <p className="text-body-sm text-(--color-text-muted)">Add some captions above first.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-body-sm text-(--color-text-muted)">
                  Rewrites every caption's text into another language, right in your browser. Timing stays the same;
                  word-by-word highlight timing can't carry over to the new wording, so it falls back to whole-line
                  display for translated cues.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                    From
                    <select
                      value={translateSource}
                      onChange={(e) => setTranslateSource(e.target.value)}
                      className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                    >
                      {NLLB_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label="Swap languages"
                    onClick={() => {
                      setTranslateSource(translateTarget);
                      setTranslateTarget(translateSource);
                    }}
                    className="mt-4 shrink-0 rounded-md border border-(--color-border) p-1.5 text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)"
                  >
                    <ArrowRightLeft size={14} />
                  </button>
                  <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                    To
                    <select
                      value={translateTarget}
                      onChange={(e) => setTranslateTarget(e.target.value)}
                      className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                    >
                      {NLLB_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  disabled={captions.isTranslating}
                  onClick={() => captions.translate(translateTarget, translateSource)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Languages size={15} />
                  {captions.isTranslating ? "Translating…" : "Translate captions"}
                </button>
                {captions.translateProgress && (
                  <ProgressBar
                    label={
                      captions.translateProgress.phase === "downloading"
                        ? "Downloading translation model (one-time)…"
                        : "Translating…"
                    }
                    fraction={captions.translateProgress.fraction}
                  />
                )}
                {captions.translateError && <p className="text-body-sm text-danger-600">{captions.translateError}</p>}
              </div>
            )}
          </ToolPanelSection>
        </>
      )}

      {tab === "styles" && (
        <ToolPanelSection icon={Palette} label="Style">
          <div className="space-y-5">
            {CAPTION_STYLE_CATEGORIES.map((category) => {
              const presets = CAPTION_STYLE_PRESETS.filter((p) => p.category === category);
              if (presets.length === 0) return null;
              return (
                <div key={category}>
                  <h4 className="mb-2 text-caption font-semibold text-(--color-text-muted)">{category}</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {presets.map((preset) => (
                      <CaptionStylePreview
                        key={preset.id}
                        preset={preset}
                        active={presetId === preset.id}
                        onClick={() => captions.applyPreset(preset.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ---- Content-aware: behind a person ---- */}
          {style.occludeByPerson && (
            <div className="mt-5 rounded-lg border border-primary-200 bg-primary-50 p-4 dark:border-primary-900 dark:bg-primary-950/30">
              <div className="flex items-center gap-2 font-semibold">
                <Scan size={15} />
                Content-aware: behind a person
              </div>
              <p className="mt-1.5 text-body-sm text-(--color-text-muted)">
                Runs an in-browser AI model that cuts the person out of each sampled frame, so the caption can sit
                behind them. This processes locally and can take a little while — nothing is uploaded.
              </p>
              <button
                type="button"
                disabled={!video.file || personCutout.isGenerating}
                onClick={handleGenerateCutout}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {personCutout.frames.length > 0 ? <RefreshCw size={15} /> : <Scan size={15} />}
                {personCutout.isGenerating
                  ? "Detecting person…"
                  : personCutout.frames.length > 0
                    ? "Regenerate cutout"
                    : "Detect person"}
              </button>
              {personCutout.progress && (
                <div className="mt-3">
                  <ProgressBar
                    label={personCutout.progress.phase === "downloading" ? "Downloading segmentation model…" : "Analyzing frames…"}
                    fraction={personCutout.progress.fraction}
                  />
                </div>
              )}
              {personCutout.error && <p className="mt-2 text-body-sm text-danger-600">{personCutout.error}</p>}
              {!personCutout.isGenerating && personCutout.frames.length > 0 && (
                <p className="mt-2 text-caption text-(--color-text-muted)">
                  {personCutout.frames.length} frames sampled — showing in the preview. Regenerate if you change the
                  trim range.
                </p>
              )}
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
              Font
              <select
                value={style.fontId}
                onChange={(e) => captions.updateStyle({ fontId: e.target.value })}
                className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
              >
                {TEXT_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 items-center gap-3 text-caption text-(--color-text-muted)">
              Size
              <input
                type="range"
                min={16}
                max={MAX_TEXT_SIZE}
                value={style.fontSize}
                onChange={(e) => captions.updateStyle({ fontSize: Number(e.target.value) })}
                className="min-w-0 flex-1 accent-(--color-primary-500)"
              />
              <span className="w-10 shrink-0 text-right tabular-nums">{style.fontSize}px</span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-2">
              <span className="text-caption text-(--color-text-muted)">Text</span>
              {CAPTION_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Text color ${c}`}
                  onClick={() => captions.updateStyle({ color: c })}
                  className={`h-6 w-6 rounded-full border-2 ${style.color === c ? "border-primary-500" : "border-(--color-border)"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={style.color}
                onChange={(e) => captions.updateStyle({ color: e.target.value })}
                className="h-6 w-6 cursor-pointer rounded border border-(--color-border) bg-transparent"
                aria-label="Custom text color"
              />
            </div>

            <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
              {(["top", "center", "bottom"] as TextPositionPreset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => captions.updateStyle(POSITION_PRESETS[p])}
                  className={`rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${
                    isAtPositionPreset(style.x, style.y, p)
                      ? "bg-primary-500 text-white"
                      : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-caption text-(--color-text-muted)">
            Or drag the caption directly in the preview to place it anywhere.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.uppercase}
                onChange={(e) => captions.updateStyle({ uppercase: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              UPPERCASE
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.background}
                onChange={(e) => captions.updateStyle({ background: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              Background box
              {style.background && (
                <input
                  type="color"
                  value={style.backgroundColor}
                  onChange={(e) => captions.updateStyle({ backgroundColor: e.target.value })}
                  className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                  aria-label="Background color"
                />
              )}
            </label>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.outline}
                onChange={(e) => captions.updateStyle({ outline: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              Outline
              {style.outline && (
                <input
                  type="color"
                  value={style.outlineColor}
                  onChange={(e) => captions.updateStyle({ outlineColor: e.target.value })}
                  className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                  aria-label="Outline color"
                />
              )}
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.karaoke}
                onChange={(e) => captions.updateStyle({ karaoke: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              Word-by-word highlight
              {style.karaoke && (
                <input
                  type="color"
                  value={style.highlightColor}
                  onChange={(e) => captions.updateStyle({ highlightColor: e.target.value })}
                  className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                  aria-label="Highlight color"
                />
              )}
            </label>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.fade}
                onChange={(e) => captions.updateStyle({ fade: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              Fade in/out
            </label>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <input
                type="checkbox"
                checked={style.occludeByPerson}
                onChange={(e) => captions.updateStyle({ occludeByPerson: e.target.checked })}
                className="accent-(--color-primary-500)"
              />
              Behind a person
            </label>
          </div>
          {style.karaoke && cues.length > 0 && !cues.some((c) => c.words?.length) && (
            <p className="mt-2 text-caption text-(--color-text-muted)">
              These captions don&apos;t have word-level timing (typed manually, uploaded, or translated), so
              they&apos;ll export without the highlight. Auto-generate captions to enable it.
            </p>
          )}
        </ToolPanelSection>
      )}
    </>
  );
}
