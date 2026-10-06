import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import type { Clip } from "../../../../lib/timeline/clip";
import { formatTimecode } from "../../../../lib/timeline/time-model";
import { EASING_PRESETS, type EasingSpec } from "../../../../lib/animation/easing";
import { adjacentKeyframeFrame } from "../../../../lib/animation/keyframes";
import { getProperty } from "../../../../lib/animation/properties";
import { parseEffectPath } from "../../../../lib/effects/model";
import { getEffectDefinition } from "../../../../lib/effects/registry";
import { NumberField } from "./TransformPanel";

/**
 * KEYFRAMES PANEL (KEYFRAME_ENGINE_ARCHITECTURE.md §6) for the selected clip:
 * every animated property with its keyframes — frame (move), value (edit),
 * easing of the outgoing segment, delete — plus prev/next keyframe navigation.
 * A thin view: each change is one engine op = one undo step.
 */
export interface KeyframesPanelProps {
  clip: Clip;
  /** Absolute playhead frame. */
  frame: number;
  fps: number;
  locked: boolean;
  onSeek: (absFrame: number) => void;
  onMove: (path: string, keyframeId: string, absFrame: number) => void;
  onUpdate: (path: string, keyframeId: string, patch: { value?: number; easing?: EasingSpec }) => void;
  onRemove: (path: string, keyframeId: string) => void;
}

/** Display scale for a property's value (opacity/crop/scale shown as %). */
function display(path: string, clip?: Clip): { k: number; suffix: string; precision: number } {
  const fx = parseEffectPath(path);
  if (fx && clip) {
    const e = clip.effects?.find((x) => x.id === fx.effectId);
    const p = e && getEffectDefinition(e.type)?.params.find((q) => q.key === fx.param);
    if (p) return p.unit === "%" ? { k: 100, suffix: "%", precision: 0 } : { k: 1, suffix: p.unit === "stops" ? " st" : p.unit, precision: 2 };
  }
  if (path === "audio.volume") return { k: 100, suffix: "%", precision: 0 };
  if (path === "audio.gainDb") return { k: 1, suffix: " dB", precision: 1 };
  if (path === "visual.opacity" || path.startsWith("visual.crop.") || path.includes("scale")) return { k: 100, suffix: "%", precision: 1 };
  if (path.endsWith("rotation")) return { k: 1, suffix: "°", precision: 1 };
  return { k: 1, suffix: "px", precision: 1 };
}

/** "effects.<id>.<param>" -> "Blur · Radius" (looked up on this clip's stack). */
function effectLabel(clip: Clip, path: string): string | null {
  const parsed = parseEffectPath(path);
  if (!parsed) return null;
  const fx = clip.effects?.find((e) => e.id === parsed.effectId);
  const def = fx && getEffectDefinition(fx.type);
  return def ? `${def.label} · ${def.params.find((p) => p.key === parsed.param)?.label ?? parsed.param}` : path;
}

export default function KeyframesPanel({ clip, frame, fps, locked, onSeek, onMove, onUpdate, onRemove }: KeyframesPanelProps) {
  const tracks = clip.animation?.tracks ?? {};
  const paths = Object.keys(tracks);
  const local = frame - clip.timelineStart;
  const prev = adjacentKeyframeFrame(Object.values(tracks), local, -1);
  const next = adjacentKeyframeFrame(Object.values(tracks), local, 1);

  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface) text-caption" data-testid="keyframes-panel">
      <h2 className="flex items-center justify-between border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        Keyframes
        <span className="flex items-center gap-1 font-normal">
          <button type="button" disabled={prev === undefined} onClick={() => prev !== undefined && onSeek(clip.timelineStart + prev)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Previous keyframe" title="Previous keyframe">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={next === undefined} onClick={() => next !== undefined && onSeek(clip.timelineStart + next)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Next keyframe" title="Next keyframe">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </span>
      </h2>
      {paths.length === 0 ? (
        <p className="p-3 text-(--color-text-muted)">No animation. Click a ◆ next to a property (Transform, Effects, or Audio volume/gain) to start animating it from the playhead.</p>
      ) : (
        <div className="flex flex-col divide-y divide-(--color-border)">
          {paths.map((path) => {
            const prop = getProperty(path);
            const d = display(path, clip);
            return (
              <div key={path} className="flex flex-col gap-1.5 p-3">
                <p className="font-medium">{effectLabel(clip, path) ?? prop?.label ?? path}</p>
                {tracks[path].keyframes.map((kf) => {
                  const abs = clip.timelineStart + kf.frame;
                  const here = kf.frame === local;
                  const easingValue = kf.easing.type === "cubic-bezier" ? "cubic-bezier" : kf.easing.type;
                  return (
                    <div key={kf.id} className={`grid grid-cols-[auto_3.25rem_minmax(4rem,1fr)_minmax(0,1fr)_auto] items-end gap-1.5 rounded ${here ? "bg-amber-500/10" : ""}`} data-keyframe-id={kf.id}>
                      <button type="button" onClick={() => onSeek(abs)} className="mb-1 font-mono tabular-nums text-(--color-text-muted) underline-offset-2 hover:underline" title="Go to this keyframe">
                        {formatTimecode(abs, fps)}
                      </button>
                      <NumberField label="Frame" value={abs} precision={0} min={0} disabled={locked} onScrub={() => {}} onCommit={(n) => onMove(path, kf.id, Math.round(n))} />
                      <NumberField label="Value" value={kf.value * d.k} suffix={d.suffix} precision={d.precision} disabled={locked} onScrub={() => {}} onCommit={(n) => onUpdate(path, kf.id, { value: n / d.k })} />
                      <label className="flex flex-col gap-0.5">
                        <span className="text-(--color-text-muted)">Easing →</span>
                        <select
                          aria-label="Easing to next keyframe"
                          value={easingValue}
                          disabled={locked}
                          onChange={(e) => onUpdate(path, kf.id, { easing: { type: e.target.value } as EasingSpec })}
                          className="w-full min-w-0 rounded border border-(--color-border) bg-(--color-surface) px-1 py-1"
                        >
                          {EASING_PRESETS.map((p) => (
                            <option key={p.type} value={p.type}>
                              {p.label}
                            </option>
                          ))}
                          {easingValue === "cubic-bezier" && <option value="cubic-bezier" disabled>Custom Bézier</option>}
                        </select>
                      </label>
                      <button type="button" disabled={locked} onClick={() => onRemove(path, kf.id)} className="mb-0.5 rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40" aria-label={`Delete keyframe at ${formatTimecode(abs, fps)}`} title="Delete keyframe">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
