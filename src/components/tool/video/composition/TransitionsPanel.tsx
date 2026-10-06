import { Play, Trash2 } from "lucide-react";
import type { TimelineModel } from "../../../../lib/timeline/model";
import type { Clip } from "../../../../lib/timeline/clip";
import { formatTimecode } from "../../../../lib/timeline/time-model";
import { EASING_PRESETS, type EasingSpec } from "../../../../lib/animation/easing";
import { maxTransitionDuration, transitionKindLabel, transitionWindow, type Transition, type TransitionAlignment } from "../../../../lib/transitions/model";
import { getTransitionDefinition, listTransitionDefinitions, type TransitionDirection } from "../../../../lib/transitions/registry";
import type { TransitionPatch } from "../../../../lib/timeline/operations";
import { NumberField } from "./TransformPanel";

/**
 * TRANSITIONS PANEL (TRANSITIONS_ARCHITECTURE.md §6). Inspector for the selected transition — type, duration,
 * alignment, direction, params, easing, enabled — generic over the transition registry (no per-type UI code). With
 * a clip selected instead, offers adding a transition in/out at its edges. Every change is one engine op = one undo step.
 */
export interface TransitionsPanelProps {
  timeline: TimelineModel;
  /** The selected transition, if any. */
  transition: Transition | null;
  /** The selected clip (for adding in/out transitions), if any. */
  clip: Clip | null;
  locked: boolean;
  onAdd: (fromClipId: string | null, toClipId: string | null) => void;
  onSelect: (transitionId: string) => void;
  onUpdate: (patch: TransitionPatch) => void;
  onRemove: () => void;
  onPreview: (start: number, end: number) => void;
}

const DIRECTION_LABEL: Record<TransitionDirection, string> = { left: "← Left", right: "→ Right", up: "↑ Up", down: "↓ Down", in: "Zoom in", out: "Zoom out" };
const ALIGN_LABEL: Record<TransitionAlignment, string> = { center: "Centered on cut", end: "Ends at cut", start: "Starts at cut" };

const selectCls = "rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-1";

export default function TransitionsPanel({ timeline, transition, clip, locked, onAdd, onSelect, onUpdate, onRemove, onPreview }: TransitionsPanelProps) {
  const fps = timeline.frameRate;

  if (!transition) {
    if (!clip) return null;
    const list = Object.values(timeline.transitions ?? {});
    const inT = list.find((t) => t.toClipId === clip.id);
    const outT = list.find((t) => t.fromClipId === clip.id);
    const edge = (label: string, t: Transition | undefined, add: () => void) => (
      <div className="flex items-center justify-between gap-2">
        <span className="text-(--color-text-muted)">{label}</span>
        {t ? (
          <button type="button" onClick={() => onSelect(t.id)} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)">
            Edit {getTransitionDefinition(t.type)?.label ?? t.type}
          </button>
        ) : (
          <button type="button" disabled={locked} onClick={add} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40">
            ＋ Add
          </button>
        )}
      </div>
    );
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) p-3 text-caption" data-testid="transitions-panel">
        <h2 className="text-body-sm font-semibold">Transitions</h2>
        {edge("Transition in (clip start)", inT, () => onAdd(null, clip.id))}
        {edge("Transition out (clip end)", outT, () => onAdd(clip.id, null))}
        <p className="text-(--color-text-faint)">Between two clips: click ＋ where they meet on the timeline.</p>
      </section>
    );
  }

  const def = getTransitionDefinition(transition.type);
  const win = transitionWindow(timeline, transition);
  const max = maxTransitionDuration(timeline, transition);
  const kind = transitionKindLabel(transition);
  const name = (id: string | null) => {
    const c = id ? timeline.clips[id] : null;
    if (!c) return "—";
    return c.content.kind === "text" ? `“${c.content.text}”` : (c.content.source?.label ?? timeline.tracks[c.trackId]?.name ?? c.id);
  };
  const easingValue = transition.easing.type;

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-(--color-border) bg-(--color-surface) p-3 text-caption" data-testid="transitions-panel" data-transition-id={transition.id}>
      <h2 className="flex items-center justify-between text-body-sm font-semibold">
        Transition
        <span className="flex items-center gap-1 font-normal">
          {win && (
            <button type="button" onClick={() => onPreview(win.start, win.end)} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-(--color-bg-subtle)" aria-label="Preview transition" title="Play the transition with a short lead-in">
              <Play className="h-3.5 w-3.5" /> Preview
            </button>
          )}
          <button type="button" disabled={locked} onClick={onRemove} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-40" aria-label="Delete transition" title="Delete transition (restores the plain cut)">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </h2>
      <p className="text-(--color-text-muted)">
        {kind === "between" ? `${name(transition.fromClipId)} → ${name(transition.toClipId)}` : kind === "in" ? `In: ${name(transition.toClipId)}` : `Out: ${name(transition.fromClipId)}`}
        {win && ` · ${formatTimecode(win.start, fps)} → ${formatTimecode(win.end, fps)}`}
      </p>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={transition.enabled} disabled={locked} onChange={(e) => onUpdate({ enabled: e.target.checked })} aria-label="Transition enabled" />
        Enabled
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-(--color-text-muted)">Type</span>
        <select aria-label="Transition type" value={transition.type} disabled={locked} onChange={(e) => onUpdate({ type: e.target.value })} className={selectCls}>
          {listTransitionDefinitions().map((d) => (
            <option key={d.type} value={d.type}>
              {d.label}
            </option>
          ))}
        </select>
        {def && <span className="text-(--color-text-faint)">{def.description}</span>}
      </label>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Duration" value={transition.duration} precision={0} min={1} max={max} suffix=" f" disabled={locked} onScrub={() => {}} onCommit={(n) => onUpdate({ duration: Math.round(n) })} />
        <div className="flex flex-col justify-end pb-1 text-(--color-text-faint)">
          {(transition.duration / fps).toFixed(2)} s · max {max} f
        </div>
      </div>

      {kind === "between" && (
        <label className="flex flex-col gap-0.5">
          <span className="text-(--color-text-muted)">Alignment</span>
          <select aria-label="Transition alignment" value={transition.alignment} disabled={locked} onChange={(e) => onUpdate({ alignment: e.target.value as TransitionAlignment })} className={selectCls}>
            {(Object.keys(ALIGN_LABEL) as TransitionAlignment[]).map((a) => (
              <option key={a} value={a}>
                {ALIGN_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
      )}

      {def?.directions && (
        <label className="flex flex-col gap-0.5">
          <span className="text-(--color-text-muted)">Direction</span>
          <select aria-label="Transition direction" value={transition.direction} disabled={locked} onChange={(e) => onUpdate({ direction: e.target.value as TransitionDirection })} className={selectCls}>
            {def.directions.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
      )}

      {def?.params.map((p) =>
        p.kind === "color" ? (
          <label key={p.key} className="flex items-center justify-between gap-2">
            <span className="text-(--color-text-muted)">{p.label}</span>
            <input type="color" aria-label={`Transition ${p.label}`} value={String(transition.params[p.key] ?? p.default)} disabled={locked} onChange={(e) => onUpdate({ params: { [p.key]: e.target.value } })} />
          </label>
        ) : (
          <NumberField
            key={p.key}
            label={p.label}
            value={Number(transition.params[p.key] ?? p.default) * (p.unit === "%" ? 100 : 1)}
            step={p.step * (p.unit === "%" ? 100 : 1)}
            precision={p.unit === "%" ? 0 : p.step < 1 ? 1 : 0}
            min={p.min * (p.unit === "%" ? 100 : 1)}
            max={p.max * (p.unit === "%" ? 100 : 1)}
            suffix={p.unit === "x" ? "×" : p.unit}
            disabled={locked}
            onScrub={() => {}}
            onCommit={(n) => onUpdate({ params: { [p.key]: n / (p.unit === "%" ? 100 : 1) } })}
          />
        ),
      )}

      <label className="flex flex-col gap-0.5">
        <span className="text-(--color-text-muted)">Easing</span>
        <select aria-label="Transition easing" value={easingValue} disabled={locked} onChange={(e) => onUpdate({ easing: { type: e.target.value } as EasingSpec })} className={selectCls}>
          {EASING_PRESETS.map((p) => (
            <option key={p.type} value={p.type}>
              {p.label}
            </option>
          ))}
          {easingValue === "cubic-bezier" && (
            <option value="cubic-bezier" disabled>
              Custom Bézier
            </option>
          )}
        </select>
      </label>
    </section>
  );
}
