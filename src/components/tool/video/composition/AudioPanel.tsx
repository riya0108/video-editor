import { AudioLines, Volume2, VolumeX } from "lucide-react";
import type { Clip } from "../../../../lib/timeline/clip";
import { isTrimmableContent, clipDurationFrames } from "../../../../lib/timeline/clip";
import { AUDIO_ROLES, clipAudioOf, linearToDb, type AudioRole, type FadeCurve } from "../../../../lib/audio/model";
import type { AudioSourceStatus } from "../../../../lib/audio/source-store";
import type { ClipAudioPatch } from "../../../../lib/timeline/operations";
import { NumberField, type KeyframeControl } from "./TransformPanel";

/**
 * AUDIO PANEL (AUDIO_ENGINE_ARCHITECTURE.md §7) for the selected clip that carries sound (audio clip, or a video's
 * soundtrack): role, mute, volume (with keyframe automation), gain, fades + curve, peak normalization, and the
 * source's decode status (so missing / unsupported / corrupted audio is explained, never silent).
 */
export interface AudioPanelProps {
  clip: Clip;
  /** Absolute playhead frame. */
  frame: number;
  fps: number;
  locked: boolean;
  status: AudioSourceStatus | { state: "missing" };
  /** Measured peak of the clip's source range (dBFS), when the source is decoded. */
  peakDb: number | null;
  /** Volume at the playhead (keyframe-evaluated). */
  volumeAtPlayhead: number;
  gainAtPlayhead: number;
  onChange: (patch: ClipAudioPatch) => void;
  onNormalize: (targetDb: number) => void;
  keyframes: (path: string) => KeyframeControl;
}

const CURVES: { value: FadeCurve; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "equal-power", label: "Equal power" },
  { value: "s-curve", label: "S-curve" },
];

const sel = "rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1";

export default function AudioPanel({ clip, fps, locked, status, peakDb, volumeAtPlayhead, gainAtPlayhead, onChange, onNormalize, keyframes }: AudioPanelProps) {
  const a = clipAudioOf(clip);
  const isVideo = clip.content.kind !== "audio";
  const durSec = clipDurationFrames(clip) / fps;
  const label = isTrimmableContent(clip.content) ? (clip.content.source.label ?? clip.content.source.sourceId) : "";
  const statusLine = (() => {
    switch (status.state) {
      case "ready":
        return `${status.channels === 1 ? "Mono" : "Stereo"} · ${(status.sampleRate / 1000).toFixed(1)} kHz · ${status.durationSec.toFixed(1)} s source${status.warning ? ` — ⚠ ${status.warning}` : ""}`;
      case "loading":
        return "Decoding audio…";
      case "no-audio":
        return "This video has no soundtrack.";
      case "missing":
        return `Missing audio: “${label}” isn't loaded in this session. Re-add the file to relink it — the clip plays silent until then.`;
      case "error":
        return status.message;
    }
  })();
  const problem = status.state === "missing" || status.state === "error";

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-(--color-border) bg-(--color-surface) p-3 text-caption" data-testid="audio-panel">
      <h2 className="flex items-center justify-between text-body-sm font-semibold">
        <span className="flex items-center gap-1.5">
          <AudioLines className="h-4 w-4" /> {isVideo ? "Video sound" : "Audio"}
        </span>
        <button
          type="button"
          disabled={locked}
          onClick={() => onChange({ muted: !a.muted })}
          className={`flex items-center gap-1 rounded px-1.5 py-1 font-normal hover:bg-(--color-bg-subtle) ${a.muted ? "text-danger-600" : ""}`}
          aria-label={a.muted ? "Unmute clip" : "Mute clip"}
          aria-pressed={a.muted}
        >
          {a.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />} {a.muted ? "Muted" : "Mute"}
        </button>
      </h2>
      <p className={problem ? "rounded bg-danger-500/10 px-2 py-1 text-danger-700 dark:text-danger-300" : "text-(--color-text-muted)"} role={problem ? "alert" : undefined} data-audio-status={status.state}>
        {statusLine}
      </p>

      <label className="flex flex-col gap-0.5">
        <span className="text-(--color-text-muted)">Role</span>
        <select aria-label="Audio role" value={a.role ?? (isVideo ? "original" : "music")} disabled={locked} onChange={(e) => onChange({ role: e.target.value as AudioRole })} className={sel}>
          {AUDIO_ROLES.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Volume" value={volumeAtPlayhead * 100} step={1} precision={0} min={0} max={200} suffix="%" disabled={locked} keyframe={keyframes("audio.volume")} onScrub={() => {}} onCommit={(n) => onChange({ volume: n / 100 })} />
        <NumberField label="Gain" value={gainAtPlayhead} step={0.5} precision={1} min={-60} max={24} suffix=" dB" disabled={locked} keyframe={keyframes("audio.gainDb")} onScrub={() => {}} onCommit={(n) => onChange({ gainDb: n })} />
        <NumberField label="Fade in" value={a.fadeInFrames / fps} step={0.1} precision={2} min={0} max={durSec} suffix=" s" disabled={locked} onScrub={() => {}} onCommit={(n) => onChange({ fadeInFrames: Math.round(n * fps) })} />
        <NumberField label="Fade out" value={a.fadeOutFrames / fps} step={0.1} precision={2} min={0} max={durSec} suffix=" s" disabled={locked} onScrub={() => {}} onCommit={(n) => onChange({ fadeOutFrames: Math.round(n * fps) })} />
      </div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-(--color-text-muted)">Fade curve</span>
        <select aria-label="Fade curve" value={a.fadeCurve} disabled={locked} onChange={(e) => onChange({ fadeCurve: e.target.value as FadeCurve })} className={sel}>
          {CURVES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1 border-t border-(--color-border) pt-2">
        <span className="flex items-center justify-between">
          <span className="text-(--color-text-muted)">Peak {peakDb === null ? "—" : Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dBFS` : "silent"}</span>
          {a.normalize && (
            <span data-testid="normalize-readout">
              Normalized to {a.normalize.targetDb} dB ({a.normalize.gainDb >= 0 ? "+" : ""}
              {a.normalize.gainDb.toFixed(1)} dB)
            </span>
          )}
        </span>
        <span className="flex gap-1.5">
          <button type="button" disabled={locked || peakDb === null || !Number.isFinite(peakDb)} onClick={() => onNormalize(-1)} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40">
            Normalize to −1 dB
          </button>
          {a.normalize && (
            <button type="button" disabled={locked} onClick={() => onChange({ normalize: null })} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40">
              Remove
            </button>
          )}
        </span>
        <span className="text-(--color-text-faint)">Level at playhead (before fades): {(() => {
          const db = linearToDb(volumeAtPlayhead) + gainAtPlayhead + (a.normalize?.gainDb ?? 0);
          return Number.isFinite(db) ? `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB` : "−∞ dB";
        })()}</span>
      </div>
    </section>
  );
}
