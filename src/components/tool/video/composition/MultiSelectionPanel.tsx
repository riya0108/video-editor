import { useState } from "react";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, Copy, FlipHorizontal2, FlipVertical2, Trash2 } from "lucide-react";
import type { CompositionSettings } from "../../../../lib/timeline/model";
import type { ClipVisualPatch } from "../../../../lib/timeline/visual";
import { alignMany, translateVisual, type Alignment, type ResolvedLayer, type SafeZone } from "../../../../lib/composition";

/**
 * Controls for 2+ selected layers. Every action is ONE batched edit
 * (setClipVisuals -> one undo step). Locked layers are reported and left
 * untouched rather than failing the whole batch.
 */
const ALIGN_BUTTONS: { a: Alignment; label: string; Icon: typeof AlignStartVertical }[] = [
  { a: "left", label: "Align left edges", Icon: AlignStartVertical },
  { a: "hcenter", label: "Align horizontal centers", Icon: AlignCenterVertical },
  { a: "right", label: "Align right edges", Icon: AlignEndVertical },
  { a: "top", label: "Align top edges", Icon: AlignStartHorizontal },
  { a: "vcenter", label: "Align vertical centers", Icon: AlignCenterHorizontal },
  { a: "bottom", label: "Align bottom edges", Icon: AlignEndHorizontal },
];

export interface MultiSelectionPanelProps {
  /** Resolved layers for the selection (off-screen members included). */
  layers: readonly ResolvedLayer[];
  lockedClipIds: ReadonlySet<string>;
  composition: CompositionSettings;
  safeZones: readonly SafeZone[];
  onCommit: (patches: Record<string, ClipVisualPatch>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export default function MultiSelectionPanel({ layers, lockedClipIds, composition, safeZones, onCommit, onDuplicate, onDelete }: MultiSelectionPanelProps) {
  const [target, setTarget] = useState("selection");
  const editable = layers.filter((l) => !lockedClipIds.has(l.clipId));
  const lockedCount = layers.length - editable.length;

  const align = (a: Alignment) => {
    const rect =
      target === "selection" ? "selection" : target === "canvas" ? { x: 0, y: 0, width: composition.width, height: composition.height } : safeZones.find((z) => z.label === target)?.rect;
    if (!rect) return;
    // Alignment target is computed from ALL selected (locked ones still define "the selection"), but only editable ones move.
    const deltas = alignMany(
      layers.map((l) => ({ clipId: l.clipId, bounds: l.bounds })),
      rect,
      a,
    );
    const patches: Record<string, ClipVisualPatch> = {};
    for (const l of editable) {
      const d = deltas[l.clipId];
      if (d) patches[l.clipId] = { transform: translateVisual(l.visual, d.dx, d.dy).transform };
    }
    if (Object.keys(patches).length > 0) onCommit(patches);
  };
  const forAll = (make: (l: ResolvedLayer) => ClipVisualPatch) => {
    const patches: Record<string, ClipVisualPatch> = {};
    for (const l of editable) patches[l.clipId] = make(l);
    if (Object.keys(patches).length > 0) onCommit(patches);
  };

  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface) text-caption" data-testid="multi-selection-panel">
      <h2 className="flex items-center justify-between border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        {layers.length} layers selected
        {lockedCount > 0 && <span className="font-normal text-(--color-text-muted)">{lockedCount} locked</span>}
      </h2>
      <div className="flex flex-col gap-3 p-3">
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="mb-1 text-(--color-text-muted)">Align to</legend>
          <select aria-label="Alignment target" value={target} onChange={(e) => setTarget(e.target.value)} className="mr-1 rounded border border-(--color-border) bg-(--color-surface) px-1 py-1">
            <option value="selection">Selection</option>
            <option value="canvas">Canvas</option>
            {safeZones.map((z) => (
              <option key={z.label} value={z.label}>
                {z.label}
              </option>
            ))}
          </select>
          {ALIGN_BUTTONS.map(({ a, label, Icon }) => (
            <button key={a} type="button" disabled={editable.length === 0} onClick={() => align(a)} aria-label={label} title={label} className="rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40">
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={editable.length === 0} onClick={() => forAll((l) => ({ transform: { flipX: !l.visual.transform.flipX } }))} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40">
            <FlipHorizontal2 className="h-3.5 w-3.5" /> Flip H
          </button>
          <button type="button" disabled={editable.length === 0} onClick={() => forAll((l) => ({ transform: { flipY: !l.visual.transform.flipY } }))} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40">
            <FlipVertical2 className="h-3.5 w-3.5" /> Flip V
          </button>
          <button type="button" onClick={onDuplicate} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)" title="Duplicate (⌘D)">
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </button>
          <button type="button" disabled={lockedCount > 0} onClick={onDelete} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40" title={lockedCount > 0 ? "Unlock layers to delete" : "Delete"}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
        <p className="text-(--color-text-faint)">Drag any selected layer to move them together; arrows, [ ] and H/V apply to all.</p>
      </div>
    </section>
  );
}
