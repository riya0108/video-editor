import { useState } from "react";
import { Captions, Download, Loader2, Merge, Scissors, Sparkles, Trash2, Upload } from "lucide-react";
import type { TimelineModel } from "../../../../lib/timeline/model";
import { clipTimelineEnd, type Clip } from "../../../../lib/timeline/clip";
import { formatTimecode } from "../../../../lib/timeline/time-model";
import { CAPTION_PRESETS, normalizeCaptionTrackSettings, type CaptionStyleSettings, type CaptionTrackSettings } from "../../../../lib/captions/caption-model";
import { CAPTION_LANGUAGES } from "../../../../lib/captions/languages";
import { CAPTION_MODELS, type CaptionModelTier, type CaptionProgress } from "../../../../lib/captions/auto-caption";
import { FONT_FACES } from "../../../../lib/text/font-registry";
import { NumberField } from "./TransformPanel";

/**
 * CAPTIONS PANEL (CAPTIONS_ARCHITECTURE.md §7): generate (speech-to-text on the
 * timeline's own audio), import SRT/VTT, export SRT/VTT, track styling + presets,
 * and the segment list for manual correction (text, timing, speaker, split,
 * merge, delete). A thin view: every change is one engine op = one undo step.
 */
export type GenerateOptions = { language: string; tier: CaptionModelTier; profile: "subtitle" | "short-form"; scope: "timeline" | "selection"; replace: boolean };

export interface CaptionsPanelProps {
  timeline: TimelineModel;
  frame: number;
  activeTrackId: string | null;
  selectedClipId: string | null;
  /** True when a clip with sound is selected (enables "selected clip only"). */
  hasAudioSelection: boolean;
  generating: CaptionProgress | null;
  onActiveTrack: (trackId: string) => void;
  onGenerate: (opts: GenerateOptions) => void;
  onImport: (file: File) => void;
  onExport: (trackId: string, format: "srt" | "vtt" | "vtt-words") => void;
  onPreset: (trackId: string, presetId: string) => void;
  onStyle: (trackId: string, patch: Partial<CaptionStyleSettings>) => void;
  onTrackSettings: (trackId: string, patch: Partial<Omit<CaptionTrackSettings, "style">>) => void;
  onText: (clipId: string, text: string) => void;
  onSpeaker: (clipId: string, speaker: string | null) => void;
  onTiming: (clipId: string, startFrame: number, endFrame: number) => void;
  onSelect: (clipId: string) => void;
  onDelete: (clipId: string) => void;
  onSplit: (clipId: string) => void;
  onMerge: (clipId: string) => void;
}

const sel = "rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1";
const btn = "flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40";

export default function CaptionsPanel(p: CaptionsPanelProps) {
  const { timeline, frame } = p;
  const fps = timeline.frameRate;
  const captionTracks = timeline.trackIds.filter((id) => timeline.tracks[id].kind === "caption");
  const trackId = p.activeTrackId && timeline.tracks[p.activeTrackId]?.kind === "caption" ? p.activeTrackId : (captionTracks[0] ?? null);
  const track = trackId ? timeline.tracks[trackId] : null;
  const settings = track ? (track.caption ?? normalizeCaptionTrackSettings({})) : null;
  const s = settings?.style;
  const [gen, setGen] = useState<GenerateOptions>({ language: "", tier: "fast", profile: "subtitle", scope: "timeline", replace: false });
  const clips: Clip[] = track ? track.clipIds.map((id) => timeline.clips[id]) : [];
  const speakers = [...new Set(clips.map((c) => (c.content as { speaker?: string }).speaker).filter((x): x is string => !!x))];

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-(--color-border) bg-(--color-surface) p-3 text-caption" data-testid="captions-panel">
      <h2 className="flex items-center gap-1.5 text-body-sm font-semibold">
        <Captions className="h-4 w-4" /> Captions
        {captionTracks.length > 1 && trackId && (
          <select aria-label="Caption track" value={trackId} onChange={(e) => p.onActiveTrack(e.target.value)} className={`ml-auto font-normal ${sel}`}>
            {captionTracks.map((id) => (
              <option key={id} value={id}>
                {timeline.tracks[id].name}
              </option>
            ))}
          </select>
        )}
      </h2>

      {/* GENERATE */}
      <div className="flex flex-col gap-1.5 rounded-lg bg-(--color-bg-subtle) p-2">
        <div className="grid grid-cols-2 gap-1.5">
          <select aria-label="Caption language" value={gen.language} onChange={(e) => setGen({ ...gen, language: e.target.value })} className={sel}>
            {CAPTION_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <select aria-label="Speech model" value={gen.tier} onChange={(e) => setGen({ ...gen, tier: e.target.value as CaptionModelTier })} className={sel}>
            {(Object.keys(CAPTION_MODELS) as CaptionModelTier[]).map((t) => (
              <option key={t} value={t}>
                {CAPTION_MODELS[t].label} ({CAPTION_MODELS[t].sizeHint})
              </option>
            ))}
          </select>
          <select aria-label="Caption pacing" value={gen.profile} onChange={(e) => setGen({ ...gen, profile: e.target.value as GenerateOptions["profile"] })} className={sel}>
            <option value="subtitle">Subtitles (up to 2 lines)</option>
            <option value="short-form">Short-form (few words)</option>
          </select>
          <select aria-label="Audio to caption" value={gen.scope} onChange={(e) => setGen({ ...gen, scope: e.target.value as GenerateOptions["scope"] })} className={sel}>
            <option value="timeline">Whole timeline audio</option>
            <option value="selection" disabled={!p.hasAudioSelection}>
              Selected clip only
            </option>
          </select>
        </div>
        {track && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={gen.replace} onChange={(e) => setGen({ ...gen, replace: e.target.checked })} /> Replace “{track.name}” instead of adding a new track
          </label>
        )}
        <button type="button" disabled={!!p.generating} onClick={() => p.onGenerate(gen)} className="flex items-center justify-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-60">
          {p.generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {p.generating ? `${p.generating.phase === "downloading" ? "Downloading model" : "Transcribing"}… ${Math.round(p.generating.fraction * 100)}%` : "Generate captions"}
        </button>
        <div className="flex flex-wrap gap-1.5">
          <label className={`${btn} cursor-pointer`}>
            <Upload className="h-3.5 w-3.5" /> Import SRT/VTT
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              className="sr-only"
              aria-label="Import subtitles"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) p.onImport(f);
                e.target.value = "";
              }}
            />
          </label>
          {trackId && (
            <>
              <button type="button" className={btn} onClick={() => p.onExport(trackId, "srt")} disabled={clips.length === 0}>
                <Download className="h-3.5 w-3.5" /> SRT
              </button>
              <button type="button" className={btn} onClick={() => p.onExport(trackId, "vtt")} disabled={clips.length === 0}>
                <Download className="h-3.5 w-3.5" /> VTT
              </button>
              <button type="button" className={btn} onClick={() => p.onExport(trackId, "vtt-words")} disabled={clips.length === 0} title="WebVTT with per-word timestamps (karaoke)">
                <Download className="h-3.5 w-3.5" /> VTT + words
              </button>
            </>
          )}
        </div>
      </div>

      {track && s && trackId && (
        <>
          {/* STYLE */}
          <div className="flex flex-col gap-2 border-t border-(--color-border) pt-2">
            <label className="flex items-center justify-between gap-2">
              <span className="text-(--color-text-muted)">Preset</span>
              <select aria-label="Caption preset" value={settings?.presetId ?? ""} disabled={track.locked} onChange={(e) => e.target.value && p.onPreset(trackId, e.target.value)} className={sel}>
                <option value="">Custom</option>
                {CAPTION_PRESETS.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 flex items-center justify-between gap-2">
                <span className="text-(--color-text-muted)">Font</span>
                <select aria-label="Caption font" value={s.fontFamily} disabled={track.locked} onChange={(e) => p.onStyle(trackId, { fontFamily: e.target.value })} className={sel}>
                  {FONT_FACES.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField label="Size" value={s.fontSize} min={8} max={400} precision={0} suffix="px" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { fontSize: n })} />
              <NumberField label="Weight" value={s.fontWeight} min={100} max={900} step={100} precision={0} disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { fontWeight: n })} />
              <ColorRow label="Text color" value={s.color} disabled={track.locked} onChange={(v) => p.onStyle(trackId, { color: v })} />
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={s.uppercase} disabled={track.locked} onChange={(e) => p.onStyle(trackId, { uppercase: e.target.checked })} /> UPPERCASE
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" aria-label="Caption stroke" checked={s.stroke} disabled={track.locked} onChange={(e) => p.onStyle(trackId, { stroke: e.target.checked })} /> Stroke
              </label>
              <span className="flex items-center gap-1">
                <input type="color" aria-label="Stroke color" value={s.strokeColor.slice(0, 7)} disabled={track.locked || !s.stroke} onChange={(e) => p.onStyle(trackId, { strokeColor: e.target.value })} />
                <NumberField label="Stroke width" value={s.strokeWidth} min={0} max={40} precision={0} suffix="px" disabled={track.locked || !s.stroke} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { strokeWidth: n })} />
              </span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" aria-label="Caption background" checked={s.background} disabled={track.locked} onChange={(e) => p.onStyle(trackId, { background: e.target.checked })} /> Background
              </label>
              <span className="flex items-center gap-1">
                <input type="color" aria-label="Background color" value={s.backgroundColor.slice(0, 7)} disabled={track.locked || !s.background} onChange={(e) => p.onStyle(trackId, { backgroundColor: e.target.value })} />
                <NumberField label="Opacity" value={s.backgroundOpacity * 100} min={0} max={100} precision={0} suffix="%" disabled={track.locked || !s.background} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { backgroundOpacity: n / 100 })} />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-(--color-text-muted)">Alignment</span>
              <span className="flex gap-1" role="group" aria-label="Caption alignment">
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} type="button" aria-pressed={s.textAlign === a} disabled={track.locked} onClick={() => p.onStyle(trackId, { textAlign: a })} className={`rounded px-2 py-1 ${s.textAlign === a ? "bg-(--color-text) text-(--color-bg)" : "border border-(--color-border)"}`}>
                    {a}
                  </button>
                ))}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="X" value={s.x * 100} min={0} max={100} precision={0} suffix="%" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { x: n / 100 })} />
              <NumberField label="Y" value={s.y * 100} min={0} max={100} precision={0} suffix="%" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { y: n / 100 })} />
              <NumberField label="Max width" value={s.maxWidth * 100} min={10} max={100} precision={0} suffix="%" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onStyle(trackId, { maxWidth: n / 100 })} />
            </div>
            <label className="flex items-center justify-between gap-2">
              <span className="text-(--color-text-muted)">Anchor (grows from)</span>
              <select aria-label="Caption anchor" value={s.anchor} disabled={track.locked} onChange={(e) => p.onStyle(trackId, { anchor: e.target.value as CaptionStyleSettings["anchor"] })} className={sel}>
                <option value="bottom">Bottom</option>
                <option value="middle">Middle</option>
                <option value="top">Top</option>
              </select>
            </label>
            {speakers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-(--color-text-muted)">Speaker colors</span>
                {speakers.map((sp) => (
                  <label key={sp} className="flex items-center gap-1">
                    <input
                      type="color"
                      aria-label={`Color for ${sp}`}
                      value={(settings?.speakerColors?.[sp] ?? s.color).slice(0, 7)}
                      disabled={track.locked}
                      onChange={(e) => p.onTrackSettings(trackId, { speakerColors: { ...settings?.speakerColors, [sp]: e.target.value } })}
                    />
                    {sp}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* SEGMENTS */}
          <div className="flex flex-col gap-1 border-t border-(--color-border) pt-2">
            <span className="text-(--color-text-muted)">
              {clips.length} caption{clips.length === 1 ? "" : "s"} — edit text, timing and speaker; double-click a caption on the canvas to edit it in place.
            </span>
            <ol className="flex max-h-96 flex-col gap-1 overflow-y-auto pr-1" data-testid="caption-segments">
              {clips.map((c, i) => {
                const content = c.content as { text?: string; speaker?: string; words?: unknown[] };
                const end = clipTimelineEnd(c);
                const active = frame >= c.timelineStart && frame < end;
                const selected = p.selectedClipId === c.id;
                return (
                  <li key={c.id} data-caption-id={c.id} className={`flex flex-col gap-1 rounded-md border p-1.5 ${selected ? "border-primary-400" : active ? "border-amber-400/70" : "border-(--color-border)"}`}>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => p.onSelect(c.id)} className="font-mono tabular-nums text-(--color-text-muted) hover:underline" title="Select and go to this caption">
                        #{i + 1} {formatTimecode(c.timelineStart, fps)}
                      </button>
                      <span className="ml-auto flex items-center gap-0.5">
                        <button type="button" disabled={track.locked || !(frame > c.timelineStart && frame < end)} onClick={() => p.onSplit(c.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Split caption ${i + 1} at playhead`} title="Split at playhead">
                          <Scissors className="h-3 w-3" />
                        </button>
                        <button type="button" disabled={track.locked || i === clips.length - 1} onClick={() => p.onMerge(c.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Merge caption ${i + 1} with next`} title="Merge with next">
                          <Merge className="h-3 w-3" />
                        </button>
                        <button type="button" disabled={track.locked} onClick={() => p.onDelete(c.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Delete caption ${i + 1}`}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      <NumberField label="Start" value={c.timelineStart / fps} step={0.1} precision={2} min={0} suffix="s" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onTiming(c.id, Math.round(n * fps), end)} />
                      <NumberField label="End" value={end / fps} step={0.1} precision={2} min={0} suffix="s" disabled={track.locked} onScrub={() => {}} onCommit={(n) => p.onTiming(c.id, c.timelineStart, Math.round(n * fps))} />
                      <label className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-(--color-text-muted)">Speaker</span>
                        <input
                          key={`${c.id}-${content.speaker ?? ""}`}
                          defaultValue={content.speaker ?? ""}
                          disabled={track.locked}
                          aria-label={`Speaker of caption ${i + 1}`}
                          placeholder="—"
                          onBlur={(e) => e.target.value.trim() !== (content.speaker ?? "") && p.onSpeaker(c.id, e.target.value.trim() || null)}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          className="min-w-0 rounded border border-(--color-border) bg-(--color-surface) px-1 py-1"
                        />
                      </label>
                    </div>
                    <textarea
                      key={`${c.id}-${content.text}`}
                      defaultValue={content.text}
                      rows={Math.min(3, Math.max(1, Math.ceil((content.text?.length ?? 0) / 38)))}
                      disabled={track.locked}
                      aria-label={`Text of caption ${i + 1}`}
                      onFocus={() => !selected && p.onSelect(c.id)}
                      onBlur={(e) => {
                        const v = e.target.value;
                        if (v !== content.text) p.onText(c.id, v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          (e.target as HTMLTextAreaElement).blur();
                        }
                      }}
                      className="w-full resize-y rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1"
                    />
                    {content.words && <span className="text-[10px] text-(--color-text-faint)">{content.words.length} timed words</span>}
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      )}
      {!track && <p className="text-(--color-text-muted)">No captions yet. Generate them from the timeline's audio, or import an SRT/VTT file.</p>}
    </section>
  );
}

function ColorRow({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-(--color-text-muted)">{label}</span>
      <input type="color" aria-label={`Caption ${label.toLowerCase()}`} value={value.slice(0, 7)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
