import { useRef, useState, type ChangeEvent } from "react";
import { Sparkles, Upload, Pencil, Plus, Trash2, Palette, Captions as CaptionsIcon, List } from "lucide-react";
import ProgressBar from "../ProgressBar";
import ToolPanelSection from "../ToolPanelSection";
import { CAPTION_MODELS, type CaptionModelTier } from "../../../lib/captions/auto-caption";
import { CAPTION_COLORS, CAPTION_STYLE_PRESETS } from "../../../lib/captions/caption-styles";
import { CAPTION_LANGUAGES } from "../../../lib/captions/languages";
import { formatTimecode, parseTimecode } from "../../../lib/captions/time-format";
import type { CaptionCue, CaptionPosition } from "../../../lib/captions/types";
import { TEXT_FONTS, getTextFont } from "../../../lib/ffmpeg/fonts";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";

const SOURCE_TABS: { id: "auto" | "manual" | "upload"; label: string; icon: typeof Sparkles }[] = [
  { id: "auto", label: "Auto-generate", icon: Sparkles },
  { id: "manual", label: "Type manually", icon: Pencil },
  { id: "upload", label: "Upload file", icon: Upload },
];

function TimeField({ seconds, onCommit }: { seconds: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState(formatTimecode(seconds));
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(formatTimecode(seconds))}
      onBlur={() => {
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
}: {
  video: ReturnType<typeof useVideoFile>;
  captions: ReturnType<typeof useCaptions>;
}) {
  const [modelTier, setModelTier] = useState<CaptionModelTier>("fast");
  const [language, setLanguage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { style, presetId, cues } = captions;

  const handleUploadChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) captions.handleSubtitleFile(file);
  };

  return (
    <>
      {/* ---- Source ---- */}
      <ToolPanelSection icon={CaptionsIcon} label="Captions source">
        <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => captions.setSourceMode(tab.id)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-caption font-medium transition-colors ${
                captions.sourceMode === tab.id
                  ? "bg-primary-500 text-white"
                  : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
              }`}
            >
              <tab.icon size={13} />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-4">
          {captions.sourceMode === "auto" && (
            <div className="space-y-3">
              <p className="text-body-sm text-(--color-text-muted)">
                Transcribes the video's audio fully in your browser — works with any spoken language, and nothing is
                uploaded anywhere.
              </p>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                  Quality
                  <select
                    value={modelTier}
                    onChange={(e) => setModelTier(e.target.value as CaptionModelTier)}
                    className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                  >
                    {(Object.entries(CAPTION_MODELS) as [CaptionModelTier, (typeof CAPTION_MODELS)[CaptionModelTier]][]).map(
                      ([id, m]) => (
                        <option key={id} value={id}>
                          {m.label} ({m.sizeHint})
                        </option>
                      ),
                    )}
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
                onClick={() => captions.addCue(video.videoRef.current?.currentTime ?? 0)}
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

      {/* ---- Style ---- */}
      <ToolPanelSection icon={Palette} label="Style">
        <div className="flex flex-wrap gap-2">
          {CAPTION_STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => captions.applyPreset(preset.id)}
              className={`rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
                presetId === preset.id
                  ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                  : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
              }`}
              style={{ fontFamily: getTextFont(preset.style.fontId).cssFontFamily }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
            Size
            <input
              type="range"
              min={16}
              max={100}
              value={style.fontSize}
              onChange={(e) => captions.updateStyle({ fontSize: Number(e.target.value) })}
              className="flex-1 accent-(--color-primary-500)"
            />
            <span className="w-10 text-right tabular-nums">{style.fontSize}px</span>
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
            {(["top", "center", "bottom"] as CaptionPosition[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => captions.updateStyle({ position: p })}
                className={`rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${
                  style.position === p
                    ? "bg-primary-500 text-white"
                    : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

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

        <div className="mt-4">
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
          {style.karaoke && cues.length > 0 && !cues.some((c) => c.words?.length) && (
            <p className="mt-1 text-caption text-(--color-text-muted)">
              These captions don&apos;t have word-level timing (typed manually or uploaded), so they&apos;ll
              export without the highlight. Auto-generate captions to enable it.
            </p>
          )}
        </div>
      </ToolPanelSection>

      {/* ---- Cue list ---- */}
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
                    <TimeField seconds={cue.start} onCommit={(v) => captions.updateCue(cue.id, { start: v })} />
                    <span className="text-caption text-(--color-text-faint)">to</span>
                    <TimeField seconds={cue.end} onCommit={(v) => captions.updateCue(cue.id, { end: v })} />
                  </div>
                  <textarea
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
    </>
  );
}
