import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { Clip } from "../../../../lib/timeline/clip";
import { EFFECT_DEFINITIONS, getEffectDefinition } from "../../../../lib/effects/registry";
import { effectParamPath } from "../../../../lib/effects/model";
import { valueAt } from "../../../../lib/animation/properties";
import { NumberField, type KeyframeControl } from "./TransformPanel";

/**
 * EFFECTS PANEL (EFFECTS_ENGINE_ARCHITECTURE.md §4) for the selected layer.
 * Generic over the effect registry — no per-effect UI code. Each change is one
 * engine op (one undo step); param scrubbing previews live through `onDraft`.
 * Param fields carry ◆ keyframe toggles wired to the Phase 8 engine.
 */
export interface EffectsPanelProps {
  clip: Clip;
  /** Absolute playhead frame (fields show keyframe-evaluated values there). */
  frame: number;
  composition: { width: number; height: number };
  locked: boolean;
  onAdd: (type: string) => void;
  onRemove: (effectId: string) => void;
  onMove: (effectId: string, newIndex: number) => void;
  onToggle: (effectId: string, enabled: boolean) => void;
  onDraft: (effectId: string, params: Record<string, number> | null) => void;
  onCommit: (effectId: string, params: Record<string, number>) => void;
  keyframes: (path: string) => KeyframeControl;
}

const CATEGORY_LABEL = { color: "Color", detail: "Detail", stylize: "Stylize" } as const;

export default function EffectsPanel({ clip, frame, composition, locked, onAdd, onRemove, onMove, onToggle, onDraft, onCommit, keyframes }: EffectsPanelProps) {
  const effects = clip.effects ?? [];
  const local = frame - clip.timelineStart;

  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface) text-caption" data-testid="effects-panel">
      <h2 className="flex items-center justify-between gap-2 border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        Effects
        <select
          aria-label="Add effect"
          value=""
          disabled={locked}
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value);
            e.target.value = "";
          }}
          className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-caption font-medium"
        >
          <option value="">＋ Add effect…</option>
          {(["color", "detail", "stylize"] as const).map((cat) => (
            <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
              {EFFECT_DEFINITIONS.filter((d) => d.category === cat).map((d) => (
                <option key={d.type} value={d.type}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </h2>
      {effects.length === 0 ? (
        <p className="p-3 text-(--color-text-muted)">No effects. Effects run top to bottom, on this layer only, and never change the original media.</p>
      ) : (
        <ol className="divide-y divide-(--color-border)">
          {effects.map((fx, index) => {
            const def = getEffectDefinition(fx.type)!;
            return (
              <li key={fx.id} className={`flex flex-col gap-2 p-3 ${fx.enabled ? "" : "opacity-60"}`} data-effect-id={fx.id} data-effect-type={fx.type}>
                <div className="flex items-center gap-1.5">
                  <input type="checkbox" checked={fx.enabled} disabled={locked} onChange={(e) => onToggle(fx.id, e.target.checked)} aria-label={`Enable ${def.label}`} />
                  <span className="flex-1 font-medium">
                    {index + 1}. {fx.metadata?.label ?? def.label}
                  </span>
                  <button type="button" disabled={locked || index === 0} onClick={() => onMove(fx.id, index - 1)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Move ${def.label} up`}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={locked || index === effects.length - 1} onClick={() => onMove(fx.id, index + 1)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Move ${def.label} down`}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={locked} onClick={() => onRemove(fx.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Remove ${def.label}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {def.params.map((p) => {
                    const path = effectParamPath(fx.id, p.key);
                    const value = valueAt(clip, path, local, composition);
                    const k = p.unit === "%" ? 100 : 1;
                    return (
                      <NumberField
                        key={p.key}
                        label={`${def.label} ${p.label}`.replace(`${def.label} ${def.label}`, def.label)}
                        value={value * k}
                        step={p.step * k}
                        precision={p.unit === "%" ? 0 : 2}
                        min={p.min * k}
                        max={p.max * k}
                        suffix={p.unit === "stops" ? " st" : p.unit}
                        disabled={locked}
                        keyframe={keyframes(path)}
                        onScrub={(n) => onDraft(fx.id, n === null ? null : { [p.key]: n / k })}
                        onCommit={(n) => onCommit(fx.id, { [p.key]: n / k })}
                      />
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
