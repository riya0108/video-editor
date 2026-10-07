import { ChevronDown, ChevronUp, Copy, Crosshair, Loader2, Trash2, Wand2, X } from "lucide-react";
import type { Clip } from "../../../../lib/timeline/clip";
import type { MatteRef } from "../../../../lib/timeline/visual";
import { valueAt } from "../../../../lib/animation/properties";
import { maskParamPath, MASK_MODES, type MaskMode, type MaskParam, type MaskPatch, type MaskShape } from "../../../../lib/masks/model";
import type { MatteReport } from "../../../../lib/composition/matte-generation";
import { NumberField, type KeyframeControl } from "./TransformPanel";

/**
 * MASKS & MATTE PANEL (MASK_COMPOSITING_ARCHITECTURE.md §8) for the selected
 * layer. Two inputs that cut a layer's alpha, applied in this order:
 *
 *  1. MATTE — a separate alpha (or luma) source: the existing background-
 *     removal engine's result, run from here on the layer's own media.
 *  2. MASKS — vector shapes in layer space, combined top to bottom.
 *
 * Every change is one engine op (one undo step); number fields scrub live via
 * `onDraft` and carry ◆ keyframe toggles wired to the Phase 8 engine.
 * Polygon/freeform masks are drawn on the canvas (the preview's mask overlay).
 */

export type MatteStatus = "none" | "ready" | "missing";

export interface BackgroundRemovalState {
  busy: { done: number; total: number; modelFraction?: number } | null;
  error: string | null;
  report: MatteReport | null;
}

export interface MasksPanelProps {
  clip: Clip;
  frame: number;
  composition: { width: number; height: number };
  locked: boolean;
  activeMaskId: string | null;
  drawing: "polygon" | "freeform" | null;
  onActiveMask: (maskId: string | null) => void;
  onDraw: (type: "polygon" | "freeform" | null) => void;
  onAdd: (type: Exclude<MaskShape, "polygon" | "freeform">) => void;
  onRemove: (maskId: string) => void;
  onMove: (maskId: string, newIndex: number) => void;
  onDuplicate: (maskId: string) => void;
  onDraft: (maskId: string, patch: MaskPatch | null) => void;
  onCommit: (maskId: string, patch: MaskPatch) => void;
  keyframes: (path: string) => KeyframeControl;
  matte: MatteRef | undefined;
  matteStatus: MatteStatus;
  canRemoveBackground: boolean;
  bgRemoval: BackgroundRemovalState;
  onRemoveBackground: () => void;
  onCancelRemoveBackground: () => void;
  onMattePatch: (matte: MatteRef | null) => void;
}

const SHAPE_LABEL: Record<MaskShape, string> = { rectangle: "Rectangle", ellipse: "Ellipse", polygon: "Polygon", freeform: "Freeform" };
const MODE_LABEL: Record<MaskMode, string> = { add: "Add", subtract: "Subtract", intersect: "Intersect", difference: "Difference" };

/** Param fields: [param, label, display multiplier, step, precision, suffix, min, max]. Positions/sizes show as % of the layer. */
const BOX_FIELDS: [MaskParam, string, number, number, number, string, number?, number?][] = [
  ["x", "X", 100, 0.5, 1, "%"],
  ["y", "Y", 100, 0.5, 1, "%"],
  ["width", "W", 100, 0.5, 1, "%", 0.1],
  ["height", "H", 100, 0.5, 1, "%", 0.1],
  ["rotation", "Rot", 1, 1, 1, "°"],
];
const EDGE_FIELDS: [MaskParam, string, number, number, number, string, number?, number?][] = [
  ["feather", "Feather", 1, 1, 1, " px", 0, 2000],
  ["expansion", "Expansion", 1, 1, 1, " px", -2000, 2000],
  ["opacity", "Opacity", 100, 1, 0, "%", 0, 100],
];

export default function MasksPanel(p: MasksPanelProps) {
  const { clip, frame, composition, locked } = p;
  const masks = clip.masks ?? [];
  const local = frame - clip.timelineStart;
  const btn = "flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40";

  const field = (maskId: string, [param, label, k, step, precision, suffix, min, max]: (typeof BOX_FIELDS)[number]) => {
    const path = maskParamPath(maskId, param);
    return (
      <NumberField
        key={param}
        label={label}
        value={valueAt(clip, path, local, composition) * k}
        step={step}
        precision={precision}
        suffix={suffix}
        min={min}
        max={max}
        disabled={locked}
        keyframe={p.keyframes(path)}
        onScrub={(n) => p.onDraft(maskId, n === null ? null : { [param]: n / k })}
        onCommit={(n) => p.onCommit(maskId, { [param]: n / k })}
      />
    );
  };

  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface) text-caption" data-testid="masks-panel">
      <h2 className="border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">Masks &amp; matte</h2>

      {/* MATTE INPUT */}
      <div className="flex flex-col gap-2 border-b border-(--color-border) p-3" data-testid="matte-section">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Matte</span>
          <span className="text-(--color-text-muted)" data-matte-status={p.matteStatus}>
            {p.matteStatus === "none" ? "None" : p.matteStatus === "ready" ? (p.matte?.sourceId.startsWith("bgmatte:") ? "Background removed" : "External matte") : "Matte media missing"}
          </span>
        </div>
        {p.canRemoveBackground && (
          <div className="flex flex-wrap items-center gap-2">
            {p.bgRemoval.busy ? (
              <>
                <span className="flex flex-1 items-center gap-1.5 text-(--color-text-muted)" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {p.bgRemoval.busy.modelFraction !== undefined && p.bgRemoval.busy.modelFraction < 1 ? `Loading model ${Math.round(p.bgRemoval.busy.modelFraction * 100)}%` : `Removing background — frame ${Math.min(p.bgRemoval.busy.done + 1, p.bgRemoval.busy.total)} of ${p.bgRemoval.busy.total}`}
                </span>
                <button type="button" className={btn} onClick={p.onCancelRemoveBackground}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
              </>
            ) : (
              <button type="button" className={btn} disabled={locked} onClick={p.onRemoveBackground} data-testid="remove-background">
                <Wand2 className="h-3.5 w-3.5" /> {p.matteStatus === "none" ? "Remove background" : p.matteStatus === "missing" ? "Regenerate matte" : "Re-run background removal"}
              </button>
            )}
          </div>
        )}
        {p.bgRemoval.error && <p className="text-red-600 dark:text-red-400">{p.bgRemoval.error}</p>}
        {p.bgRemoval.report && p.matteStatus === "ready" && (
          <p className="text-(--color-text-muted)" data-testid="matte-report">
            {p.bgRemoval.report.framesMatted} frame{p.bgRemoval.report.framesMatted === 1 ? "" : "s"} matted
            {p.bgRemoval.report.framesFailed ? `, ${p.bgRemoval.report.framesFailed} skipped (held)` : ""} · {p.bgRemoval.report.modelsUsed.join(", ")} · confidence {Math.round(p.bgRemoval.report.meanConfidence * 100)}%
          </p>
        )}
        {p.matte && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={p.matte.invert} disabled={locked} onChange={(e) => p.onMattePatch({ ...p.matte!, invert: e.target.checked })} />
              Invert (keep background)
            </label>
            <label className="flex items-center gap-1.5">
              Channel
              <select value={p.matte.channel ?? "alpha"} disabled={locked} onChange={(e) => p.onMattePatch({ ...p.matte!, channel: e.target.value as "alpha" | "luma" })} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label="Matte channel">
                <option value="alpha">Alpha</option>
                <option value="luma">Luma</option>
              </select>
            </label>
            {(p.matte.channel ?? "alpha") === "alpha" && !p.matte.invert && (
              <label className="flex items-center gap-1.5" title="Unmix the old background's color out of soft edges (removes green/background fringes)">
                <input type="checkbox" checked={!!p.matte.decontaminate} disabled={locked} onChange={(e) => p.onMattePatch({ ...p.matte!, decontaminate: e.target.checked })} />
                Clean edges
              </label>
            )}
            <button type="button" className={btn} disabled={locked} onClick={() => p.onMattePatch(null)}>
              <Trash2 className="h-3.5 w-3.5" /> Remove matte
            </button>
          </div>
        )}
      </div>

      {/* MASKS */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-(--color-border) p-3" role="toolbar" aria-label="Add mask">
        <span className="mr-1 font-medium">Add mask</span>
        {(["rectangle", "ellipse"] as const).map((t) => (
          <button key={t} type="button" className={btn} disabled={locked} onClick={() => p.onAdd(t)}>
            {SHAPE_LABEL[t]}
          </button>
        ))}
        {(["polygon", "freeform"] as const).map((t) => (
          <button key={t} type="button" className={`${btn} ${p.drawing === t ? "border-primary-500 bg-primary-500/10" : ""}`} aria-pressed={p.drawing === t} disabled={locked} onClick={() => p.onDraw(p.drawing === t ? null : t)} title={t === "polygon" ? "Click points on the canvas; click the first point or press Enter to close" : "Drag on the canvas to draw"}>
            {SHAPE_LABEL[t]}
          </button>
        ))}
      </div>
      {p.drawing && (
        <p className="border-b border-(--color-border) bg-primary-500/5 px-3 py-2" role="status">
          {p.drawing === "polygon" ? "Click on the canvas to place points. Click the first point or press Enter to close; Backspace removes the last point; Esc cancels." : "Drag on the canvas to draw the mask; release to finish. Esc cancels."}
        </p>
      )}

      {masks.length === 0 ? (
        <p className="p-3 text-(--color-text-muted)">No masks. Masks cut this layer only, follow its transform, and never change the original media.</p>
      ) : (
        <ol className="divide-y divide-(--color-border)">
          {masks.map((m, index) => {
            const active = p.activeMaskId === m.id;
            const name = m.name ?? `${SHAPE_LABEL[m.type]} ${index + 1}`;
            return (
              <li key={m.id} className={`flex flex-col gap-2 p-3 ${m.enabled ? "" : "opacity-60"} ${active ? "bg-primary-500/5" : ""}`} data-mask-id={m.id} data-mask-type={m.type}>
                <div className="flex items-center gap-1.5">
                  <input type="checkbox" checked={m.enabled} disabled={locked} onChange={(e) => p.onCommit(m.id, { enabled: e.target.checked })} aria-label={`Enable ${name}`} />
                  <button type="button" className={`flex flex-1 items-center gap-1 truncate text-left font-medium ${active ? "text-primary-600 dark:text-primary-300" : ""}`} onClick={() => p.onActiveMask(active ? null : m.id)} aria-pressed={active} title="Edit this mask on the canvas">
                    <Crosshair className="h-3.5 w-3.5 shrink-0" /> {name}
                  </button>
                  <button type="button" disabled={locked || index === 0} onClick={() => p.onMove(m.id, index - 1)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Move ${name} up`}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={locked || index === masks.length - 1} onClick={() => p.onMove(m.id, index + 1)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Move ${name} down`}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={locked} onClick={() => p.onDuplicate(m.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Duplicate ${name}`}>
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={locked} onClick={() => p.onRemove(m.id)} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label={`Remove ${name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    Mode
                    <select value={m.mode} disabled={locked} onChange={(e) => p.onCommit(m.id, { mode: e.target.value as MaskMode })} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5" aria-label={`${name} mode`}>
                      {MASK_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {MODE_LABEL[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={m.inverted} disabled={locked} onChange={(e) => p.onCommit(m.id, { inverted: e.target.checked })} />
                    Invert
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">{EDGE_FIELDS.map((f) => field(m.id, f))}</div>
                {active && (
                  <div className="grid grid-cols-3 gap-2" data-testid="mask-box-fields">
                    {BOX_FIELDS.map((f) => field(m.id, f))}
                    {m.type === "rectangle" && field(m.id, ["roundness", "Round", 100, 1, 0, "%", 0, 50])}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
