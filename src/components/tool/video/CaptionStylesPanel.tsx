import { Palette, Scan, RefreshCw } from "lucide-react";
import ProgressBar from "../ProgressBar";
import ToolPanelSection from "../ToolPanelSection";
import CaptionStylePreview from "./CaptionStylePreview";
import { CAPTION_COLORS, CAPTION_STYLE_CATEGORIES, CAPTION_STYLE_PRESETS } from "../../../lib/captions/caption-styles";
import { TEXT_FONTS } from "../../../lib/ffmpeg/fonts";
import { MAX_TEXT_SIZE } from "./editor/FloatingTextToolbar";
import { POSITION_PRESETS, isAtPositionPreset, type TextPositionPreset } from "../../../lib/ffmpeg/text-position-presets";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";

/**
 * The caption *look* controls — style gallery, font, color, position, and
 * every extended effect (shape/glow/glitch/animation/etc). Split out of
 * CaptionsEditor so the full Video Editor can show this as its own
 * dedicated "templates" column next to the preview, matching how
 * captik.in/Submagic-style editors separate "what it says" from "how it
 * looks". The standalone Captions tool still gets the same content via
 * CaptionsEditor's own Styles tab.
 */
export default function CaptionStylesPanel({
  video,
  captions,
  personCutout,
  rangeStart = 0,
  rangeEnd,
}: {
  video: ReturnType<typeof useVideoFile>;
  captions: ReturnType<typeof useCaptions>;
  personCutout: ReturnType<typeof usePersonCutout>;
  rangeStart?: number;
  rangeEnd?: number;
}) {
  const { style, presetId, cues } = captions;
  const effectiveEnd = rangeEnd ?? video.duration;

  const handleGenerateCutout = () => {
    const el = video.videoRef.current;
    if (!el) return;
    personCutout.generate(el, rangeStart, effectiveEnd);
  };

  return (
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
        {style.karaoke && (
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.wordBox}
              onChange={(e) => captions.updateStyle({ wordBox: e.target.checked })}
              className="accent-(--color-primary-500)"
            />
            As a box (Hormozi-style)
          </label>
        )}
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
          Behind the subject
        </label>
      </div>
      {style.karaoke && cues.length > 0 && !cues.some((c) => c.words?.length) && (
        <p className="mt-2 text-caption text-(--color-text-muted)">
          These captions don&apos;t have word-level timing (typed manually, uploaded, or translated), so
          they&apos;ll export without the highlight. Auto-generate captions to enable it.
        </p>
      )}

      {/* ---- Extended effects: shape, glow, shadow, gradient, glitch, glass, motion ---- */}
      <div className="mt-5 border-t border-(--color-border) pt-4">
        <h4 className="mb-2 text-caption font-semibold text-(--color-text-muted)">Effects</h4>

        <div className="flex flex-wrap items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="text-caption text-(--color-text-muted)">Shape</span>
            <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
              {(["block", "bubble", "pill"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => captions.updateStyle({ shape: s })}
                  className={`rounded px-2.5 py-1 text-caption font-medium capitalize transition-colors ${
                    style.shape === s
                      ? "bg-primary-500 text-white"
                      : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <span>Stroke</span>
            <input
              type="range"
              min={0}
              max={10}
              value={style.strokeWidth}
              onChange={(e) => captions.updateStyle({ strokeWidth: Number(e.target.value) })}
              className="w-20 accent-(--color-primary-500)"
            />
            <span className="w-4 tabular-nums">{style.strokeWidth}</span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.glow}
              onChange={(e) => captions.updateStyle({ glow: e.target.checked })}
              className="accent-(--color-primary-500)"
            />
            Glow
            {style.glow && (
              <input
                type="color"
                value={style.glowColor}
                onChange={(e) => captions.updateStyle({ glowColor: e.target.value })}
                className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                aria-label="Glow color"
              />
            )}
          </label>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.shadow}
              onChange={(e) => captions.updateStyle({ shadow: e.target.checked })}
              className="accent-(--color-primary-500)"
            />
            Drop shadow
          </label>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.glitch}
              onChange={(e) => captions.updateStyle({ glitch: e.target.checked })}
              className="accent-(--color-primary-500)"
            />
            Glitch
          </label>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.backdropBlur}
              onChange={(e) =>
                captions.updateStyle({ backdropBlur: e.target.checked, background: true })
              }
              className="accent-(--color-primary-500)"
            />
            Liquid glass background
          </label>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={style.gradient.length > 0}
              onChange={(e) =>
                captions.updateStyle({ gradient: e.target.checked ? ["#ff2d95", "#7928ca", "#22d3ee"] : [] })
              }
              className="accent-(--color-primary-500)"
            />
            Rainbow text (Prism)
          </label>
        </div>

        <label className="mt-3 flex items-center gap-3 text-caption text-(--color-text-muted)">
          Kinetic motion
          <select
            value={style.animation}
            onChange={(e) => captions.updateStyle({ animation: e.target.value as typeof style.animation })}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
          >
            <option value="none">None</option>
            <optgroup label="Entrance">
              <option value="pop">Pop</option>
              <option value="elastic">Elastic bounce</option>
              <option value="bounce">Bounce in</option>
              <option value="drop-in">Drop in</option>
              <option value="slide-up">Slide up</option>
              <option value="blur-in">Blur focus</option>
              <option value="flip">3D flip</option>
              <option value="typewriter">Typewriter</option>
            </optgroup>
            <optgroup label="Continuous">
              <option value="wave">Wave</option>
              <option value="shake">Shake</option>
              <option value="glitch">Glitch jitter</option>
            </optgroup>
          </select>
        </label>
        <p className="mt-1.5 text-caption text-(--color-text-faint)">
          Plays per word with word-by-word highlight on, or once per caption otherwise. &quot;Wave&quot; and
          &quot;Shake&quot; loop for as long as it&apos;s on screen; the rest play once. Blur focus, 3D flip,
          typewriter, wave, and shake are preview-only — exported video approximates the others (scale/position),
          since burned-in captions can&apos;t blur, rotate, or clip.
        </p>
      </div>
    </ToolPanelSection>
  );
}
