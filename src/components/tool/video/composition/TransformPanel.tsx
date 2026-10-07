import { useEffect, useRef, useState } from "react";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, FlipHorizontal2, FlipVertical2, Link2, Link2Off, RotateCcw } from "lucide-react";
import type { CompositionSettings } from "../../../../lib/timeline/model";
import { applyVisualPatch, defaultClipVisual, type BlendMode, type ClipVisual, type ClipVisualPatch, type FitMode } from "../../../../lib/timeline/visual";
import {
  alignDelta,
  ANCHOR_PRESETS,
  layerSize,
  setAnchorNormalized,
  setLayerSize,
  translateVisual,
  visibleBounds,
  type Alignment,
  type BoxSize,
  type SafeZone,
} from "../../../../lib/composition";

/**
 * NUMERIC TRANSFORM CONTROLS for one layer. Every field supports:
 *  - typing: commits on Enter/blur (one undo step), Esc reverts;
 *  - ↑/↓: step by `step` (Shift x10), one undo step per press;
 *  - label scrubbing: drag the label horizontally — renders live through a
 *    draft (no history entries mid-drag) and commits ONE undo step on release.
 *
 * Width/height are box x scale; editing them changes scale, never the
 * source pixels. Changing the anchor (grid or numbers) re-solves position so
 * the layer does not move on screen.
 */

/** Grouped like Premiere/After Effects: normal, darken, lighten, contrast, inversion, component (Phase 13: full set). */
const BLEND_GROUPS: { label: string; modes: [BlendMode, string][] }[] = [
  { label: "Normal", modes: [["normal", "Normal"]] },
  { label: "Darken", modes: [["darken", "Darken"], ["multiply", "Multiply"], ["color-burn", "Color burn"]] },
  { label: "Lighten", modes: [["lighten", "Lighten"], ["screen", "Screen"], ["color-dodge", "Color dodge"], ["add", "Add (linear dodge)"]] },
  { label: "Contrast", modes: [["overlay", "Overlay"], ["soft-light", "Soft light"], ["hard-light", "Hard light"]] },
  { label: "Inversion", modes: [["difference", "Difference"], ["exclusion", "Exclusion"]] },
  { label: "Component", modes: [["hue", "Hue"], ["saturation", "Saturation"], ["color", "Color"], ["luminosity", "Luminosity"]] },
];
const FIT_MODES: FitMode[] = ["contain", "cover", "fill", "none"];
const ALIGN_BUTTONS: { a: Alignment; label: string; Icon: typeof AlignStartVertical }[] = [
  { a: "left", label: "Align left edges", Icon: AlignStartVertical },
  { a: "hcenter", label: "Align horizontal centers", Icon: AlignCenterVertical },
  { a: "right", label: "Align right edges", Icon: AlignEndVertical },
  { a: "top", label: "Align top edges", Icon: AlignStartHorizontal },
  { a: "vcenter", label: "Align vertical centers", Icon: AlignCenterHorizontal },
  { a: "bottom", label: "Align bottom edges", Icon: AlignEndHorizontal },
];

export interface TransformPanelProps {
  visual: ClipVisual;
  /** Fitted box size; null while the source's size is unknown (W/H and in-place anchor edits are then unavailable). */
  box: BoxSize | null;
  /** True for text/shapes — fit mode doesn't apply. */
  fitLocked: boolean;
  composition: CompositionSettings;
  safeZones: readonly SafeZone[];
  locked: boolean;
  onDraft: (visual: ClipVisual | null) => void;
  onCommit: (patch: ClipVisualPatch) => void;
  /** Phase 8: per-property keyframe controls (property path -> control). Omitted = no animation UI. */
  keyframes?: (path: string) => KeyframeControl;
}

const fmt = (n: number, precision: number) => String(Number(n.toFixed(precision)));

export type KeyframeState = "static" | "animated" | "key";
export interface KeyframeControl {
  state: KeyframeState;
  /** static -> start animating (key at playhead); animated -> add key at playhead; key -> remove that key. */
  onToggle: () => void;
}

/** ◆ toggle shown before an animatable field's label. Filled = keyframe at the playhead; outlined = animated; faded = static. */
export function KeyframeDiamond({ label, control, disabled }: { label: string; control: KeyframeControl; disabled?: boolean }) {
  const title = control.state === "static" ? `Animate ${label} (add first keyframe at the playhead)` : control.state === "key" ? `Remove ${label} keyframe at the playhead` : `Add ${label} keyframe at the playhead`;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault(); // inside a <label>: don't focus the input
        control.onToggle();
      }}
      aria-label={title}
      title={title}
      aria-pressed={control.state === "key"}
      data-keyframe-state={control.state}
      className="grid h-4 w-4 place-items-center disabled:opacity-40"
    >
      <svg viewBox="0 0 10 10" className={`h-2.5 w-2.5 ${control.state === "static" ? "text-(--color-text-faint)" : "text-amber-500"}`}>
        <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill={control.state === "key" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
}

export function NumberField({
  label,
  value,
  step = 1,
  precision = 1,
  suffix,
  disabled,
  min,
  max,
  onScrub,
  onCommit,
  keyframe,
}: {
  label: string;
  value: number;
  step?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  onScrub: (n: number | null) => void;
  onCommit: (n: number) => void;
  /** Keyframe toggle (Phase 8): static = hollow, animated = outlined, key at the playhead = filled. */
  keyframe?: KeyframeControl;
}) {
  const [text, setText] = useState<string | null>(null);
  const scrub = useRef<{ x: number; start: number; last: number } | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const commitText = () => {
    if (text === null) return;
    const n = Number(text);
    setText(null);
    if (text.trim() !== "" && Number.isFinite(n) && n !== Number(value.toFixed(precision))) onCommit(clamp(n));
  };

  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1">
      {keyframe && <KeyframeDiamond label={label} control={keyframe} disabled={disabled} />}
      <span
        className={`select-none text-(--color-text-muted) ${disabled ? "" : "cursor-ew-resize"}`}
        title={disabled ? undefined : "Drag to scrub (Shift = faster)"}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.preventDefault();
          scrub.current = { x: e.clientX, start: value, last: value };
          capturePointer(e);
        }}
        onPointerMove={(e) => {
          const s = scrub.current;
          if (!s) return;
          const n = clamp(s.start + Math.round((e.clientX - s.x) / 2) * step * (e.shiftKey ? 10 : 1));
          s.last = n;
          onScrub(n);
        }}
        onPointerUp={() => {
          const s = scrub.current;
          scrub.current = null;
          if (!s) return;
          onScrub(null);
          if (s.last !== s.start) onCommit(s.last);
        }}
      >
        {label}
      </span>
      </span>
      <span className="flex items-center rounded border border-(--color-border) bg-(--color-surface) focus-within:border-primary-500">
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          disabled={disabled}
          value={text ?? fmt(value, precision)}
          onFocus={(e) => {
            setText(fmt(value, precision));
            e.currentTarget.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur(); // blur commits — committing here too would push a duplicate undo step
            } else if (e.key === "Escape") {
              setText(null);
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = text !== null && Number.isFinite(Number(text)) ? Number(text) : value;
              const n = clamp(base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
              setText(fmt(n, precision));
              onCommit(n);
            }
          }}
          className="w-full min-w-0 bg-transparent px-1.5 py-1 tabular-nums outline-none disabled:opacity-50"
        />
        {suffix && <span className="pr-1.5 text-(--color-text-faint)">{suffix}</span>}
      </span>
    </label>
  );
}

export default function TransformPanel({ visual, box, fitLocked, composition, safeZones, locked, onDraft, onCommit, keyframes }: TransformPanelProps) {
  const kf = (path: string) => (keyframes ? { keyframe: keyframes(path) } : {});
  const [linkSize, setLinkSize] = useState(true);
  const [alignTarget, setAlignTarget] = useState<string>("canvas");
  const t = visual.transform;
  const size = box ? layerSize(visual, box) : null;

  useEffect(() => {
    if (alignTarget !== "canvas" && !safeZones.some((z) => z.label === alignTarget)) setAlignTarget("canvas");
  }, [safeZones, alignTarget]);

  /** Wire a field: `make(n)` builds the full candidate visual from the stored one. */
  const field = (make: (n: number) => ClipVisual) => ({
    onScrub: (n: number | null) => onDraft(n === null ? null : safe(() => make(n))),
    onCommit: (n: number) => {
      const v = safe(() => make(n));
      // An unchanged value is not an edit — never push an empty undo step.
      if (v && JSON.stringify([v.transform, v.crop, v.opacity]) !== JSON.stringify([visual.transform, visual.crop, visual.opacity])) {
        onCommit({ transform: v.transform, crop: v.crop, opacity: v.opacity });
      }
    },
  });
  const setScale = (axis: "x" | "y", pct: number) => {
    const s = Math.max(0.01, pct / 100);
    if (!linkSize) return applyVisualPatch(visual, { transform: axis === "x" ? { scaleX: s } : { scaleY: s } });
    const k = s / (axis === "x" ? t.scaleX : t.scaleY);
    return applyVisualPatch(visual, { transform: { scaleX: Math.max(0.01, t.scaleX * k), scaleY: Math.max(0.01, t.scaleY * k) } });
  };
  const align = (a: Alignment) => {
    if (!box) return;
    const target = alignTarget === "canvas" ? { x: 0, y: 0, width: composition.width, height: composition.height } : safeZones.find((z) => z.label === alignTarget)?.rect;
    if (!target) return;
    const { dx, dy } = alignDelta(visibleBounds(visual, box), target, a);
    if (dx === 0 && dy === 0) return;
    onCommit({ transform: translateVisual(visual, dx, dy).transform });
  };
  const anchorActive = (ax: number, ay: number) => Math.abs(t.anchorX - ax) < 1e-6 && Math.abs(t.anchorY - ay) < 1e-6;

  return (
    <div className="flex flex-col gap-3 text-caption">
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X" value={t.x} suffix="px" disabled={locked} {...kf("visual.transform.x")} {...field((n) => applyVisualPatch(visual, { transform: { x: n } }))} />
        <NumberField label="Y" value={t.y} suffix="px" disabled={locked} {...kf("visual.transform.y")} {...field((n) => applyVisualPatch(visual, { transform: { y: n } }))} />
      </div>

      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <NumberField label="W" value={size?.width ?? 0} suffix="px" min={1} disabled={locked || !box} {...field((n) => setLayerSize(visual, box!, { width: n }, linkSize))} />
        <NumberField label="H" value={size?.height ?? 0} suffix="px" min={1} disabled={locked || !box} {...field((n) => setLayerSize(visual, box!, { height: n }, linkSize))} />
        <button
          type="button"
          onClick={() => setLinkSize((l) => !l)}
          aria-pressed={linkSize}
          aria-label={linkSize ? "Unlink width and height" : "Link width and height"}
          title={linkSize ? "Proportions locked" : "Proportions unlocked"}
          className="mb-0.5 rounded p-1.5 hover:bg-(--color-bg-subtle)"
        >
          {linkSize ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5 text-(--color-text-faint)" />}
        </button>
        <NumberField label="Scale X" value={t.scaleX * 100} suffix="%" min={1} disabled={locked} {...kf("visual.transform.scaleX")} {...field((n) => setScale("x", n))} />
        <NumberField label="Scale Y" value={t.scaleY * 100} suffix="%" min={1} disabled={locked} {...kf("visual.transform.scaleY")} {...field((n) => setScale("y", n))} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Rotation" value={t.rotation} suffix="°" step={1} disabled={locked} {...kf("visual.transform.rotation")} {...field((n) => applyVisualPatch(visual, { transform: { rotation: n } }))} />
        <NumberField label="Opacity" value={visual.opacity * 100} suffix="%" min={0} max={100} precision={0} disabled={locked} {...kf("visual.opacity")} {...field((n) => applyVisualPatch(visual, { opacity: n / 100 }))} />
      </div>

      <fieldset className="flex items-end gap-3">
        <legend className="mb-1 text-(--color-text-muted)">Anchor point</legend>
        <div className="grid grid-cols-3 gap-0.5 rounded border border-(--color-border) p-1" role="radiogroup" aria-label="Anchor preset">
          {ANCHOR_PRESETS.map(([ax, ay]) => (
            <button
              key={`${ax}-${ay}`}
              type="button"
              role="radio"
              aria-checked={anchorActive(ax, ay)}
              aria-label={`Anchor ${ay === 0 ? "top" : ay === 1 ? "bottom" : "middle"} ${ax === 0 ? "left" : ax === 1 ? "right" : "center"}`}
              disabled={locked || !box}
              onClick={() => box && onCommit({ transform: setAnchorNormalized(visual, box, ax, ay).transform })}
              className={`h-3.5 w-3.5 rounded-sm border ${anchorActive(ax, ay) ? "border-primary-500 bg-primary-500" : "border-(--color-border-strong) hover:bg-(--color-bg-subtle)"} disabled:opacity-40`}
            />
          ))}
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2">
          <NumberField label="Anchor X" value={t.anchorX * 100} suffix="%" disabled={locked || !box} {...field((n) => setAnchorNormalized(visual, box!, n / 100, t.anchorY))} />
          <NumberField label="Anchor Y" value={t.anchorY * 100} suffix="%" disabled={locked || !box} {...field((n) => setAnchorNormalized(visual, box!, t.anchorX, n / 100))} />
        </div>
      </fieldset>

      <fieldset className="grid grid-cols-4 gap-2">
        <legend className="mb-1 text-(--color-text-muted)">Crop</legend>
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <NumberField
            key={side}
            label={side[0].toUpperCase() + side.slice(1)}
            value={visual.crop[side] * 100}
            suffix="%"
            min={0}
            max={99}
            precision={1}
            step={0.5}
            disabled={locked}
            {...kf(`visual.crop.${side}`)}
            {...field((n) => applyVisualPatch(visual, { crop: { [side]: n / 100 } }))}
          />
        ))}
      </fieldset>

      <div className="flex flex-wrap items-end gap-2">
        <button type="button" disabled={locked} aria-pressed={t.flipX} onClick={() => onCommit({ transform: { flipX: !t.flipX } })} className={`flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40 ${t.flipX ? "border-primary-500 bg-primary-500/10" : "border-(--color-border) hover:bg-(--color-bg-subtle)"}`} title="Flip horizontal (H)">
          <FlipHorizontal2 className="h-3.5 w-3.5" /> Flip H
        </button>
        <button type="button" disabled={locked} aria-pressed={t.flipY} onClick={() => onCommit({ transform: { flipY: !t.flipY } })} className={`flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40 ${t.flipY ? "border-primary-500 bg-primary-500/10" : "border-(--color-border) hover:bg-(--color-bg-subtle)"}`} title="Flip vertical (V)">
          <FlipVertical2 className="h-3.5 w-3.5" /> Flip V
        </button>
        <label className="flex flex-1 flex-col gap-0.5">
          <span className="text-(--color-text-muted)">Blend</span>
          <select value={visual.blendMode} disabled={locked} onChange={(e) => onCommit({ blendMode: e.target.value as BlendMode })} aria-label="Blend mode" className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-1">
            {BLEND_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.modes.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-0.5">
          <span className="text-(--color-text-muted)">Fit</span>
          <select value={fitLocked ? "none" : visual.fit} disabled={locked || fitLocked} onChange={(e) => onCommit({ fit: e.target.value as FitMode })} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-1">
            {FIT_MODES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="mb-1 text-(--color-text-muted)">Align to</legend>
        <select aria-label="Alignment target" value={alignTarget} onChange={(e) => setAlignTarget(e.target.value)} className="mr-1 rounded border border-(--color-border) bg-(--color-surface) px-1 py-1">
          <option value="canvas">Canvas</option>
          {safeZones.map((z) => (
            <option key={z.label} value={z.label}>
              {z.label}
            </option>
          ))}
        </select>
        {ALIGN_BUTTONS.map(({ a, label, Icon }) => (
          <button key={a} type="button" disabled={locked || !box} onClick={() => align(a)} aria-label={label} title={label} className="rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40">
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </fieldset>

      <button
        type="button"
        disabled={locked}
        onClick={() => onCommit({ ...defaultClipVisual(composition.width, composition.height), matte: visual.matte ?? null })}
        className="flex items-center gap-1 self-start rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-40"
      >
        <RotateCcw className="h-3.5 w-3.5" /> Reset transform
      </button>
    </div>
  );
}

/** Pointer capture can throw (e.g. the pointer was already released); a failed capture must never abort the gesture itself. */
function capturePointer(e: React.PointerEvent<Element>) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* non-fatal */
  }
}

function safe(fn: () => ClipVisual): ClipVisual | null {
  try {
    return fn();
  } catch {
    return null; // an invalid intermediate value (e.g. scale 0 mid-typing) is ignored, not committed
  }
}
