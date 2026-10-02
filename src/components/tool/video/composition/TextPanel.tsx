import { useEffect, useRef } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, Bold, ClipboardCopy, ClipboardPaste, Italic, Pencil } from "lucide-react";
import { TEXT_SOFT_LENGTH_LIMIT, type TextStyle, type TextStylePatch } from "../../../../lib/timeline/text-style";
import { FONT_FACES, resolveFont } from "../../../../lib/text/font-registry";
import type { TextLayout } from "../../../../lib/composition";
import { NumberField } from "./TransformPanel";

/**
 * TYPOGRAPHY INSPECTOR (TEXT_ENGINE_ARCHITECTURE.md §1/§6). Edits a text
 * layer's TextStyle; placement (position/rotation/scale/anchor/opacity) stays
 * in TransformPanel — the generic layer controls — so there is one control
 * per model field, not two.
 *
 * Interaction contract (same as TransformPanel): scrubbing/picking renders
 * live through `onDraft` (no history), and each finished change commits ONE
 * undo step through `onCommit`.
 */
export interface TextPanelProps {
  text: string;
  style: TextStyle;
  layout: TextLayout | null;
  /** Layer opacity lives in ClipVisual; shown here too because it's part of "text color" for users — same field, not a copy. */
  opacity: number;
  locked: boolean;
  canPasteStyle: boolean;
  onDraft: (patch: TextStylePatch | null) => void;
  onCommit: (patch: TextStylePatch) => void;
  onCommitOpacity: (opacity: number) => void;
  onEditText: () => void;
  onCopyStyle: () => void;
  onPasteStyle: () => void;
}

/** Color input that previews while the native picker is open (input events) and commits once when it closes (change event). */
function ColorField({ label, value, disabled, onDraft, onCommit }: { label: string; value: string; disabled?: boolean; onDraft: (c: string | null) => void; onCommit: (c: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ onDraft, onCommit });
  latest.current = { onDraft, onCommit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onInput = () => latest.current.onDraft(el.value);
    const onChange = () => {
      latest.current.onDraft(null);
      latest.current.onCommit(el.value);
    };
    el.addEventListener("input", onInput);
    el.addEventListener("change", onChange);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("change", onChange);
    };
  }, []);
  // <input type=color> only accepts #rrggbb; anything else (rgba(), named) shows black but is preserved in the model until changed.
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : "#000000";
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-(--color-text-muted)">{label}</span>
      <input ref={ref} type="color" aria-label={label} defaultValue={hex} key={hex} disabled={disabled} className="h-7 w-full cursor-pointer rounded border border-(--color-border) bg-(--color-surface) disabled:opacity-40" />
    </label>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 font-medium">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Seg<T extends string>({ value, options, disabled, onChange, label }: { value: T; options: { v: T; label: string; Icon?: typeof AlignLeft }[]; disabled?: boolean; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-(--color-border) p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          aria-label={o.label}
          title={o.label}
          disabled={disabled}
          onClick={() => value !== o.v && onChange(o.v)}
          className={`flex flex-1 items-center justify-center rounded px-1.5 py-1 disabled:opacity-40 ${value === o.v ? "bg-primary-500/15 text-primary-600 dark:text-primary-300" : "hover:bg-(--color-bg-subtle)"}`}
        >
          {o.Icon ? <o.Icon className="h-3.5 w-3.5" /> : o.label}
        </button>
      ))}
    </div>
  );
}

export default function TextPanel({ text, style, layout, opacity, locked, canPasteStyle, onDraft, onCommit, onCommitOpacity, onEditText, onCopyStyle, onPasteStyle }: TextPanelProps) {
  const font = resolveFont(style);
  const face = font.face;
  const num = (key: keyof TextStyle, toModel: (n: number) => number = (n) => n) => ({
    onScrub: (n: number | null) => onDraft(n === null ? null : ({ [key]: toModel(n) } as TextStylePatch)),
    onCommit: (n: number) => onCommit({ [key]: toModel(n) } as TextStylePatch),
  });
  const color = (key: "color" | "backgroundColor" | "strokeColor" | "shadowColor") => ({
    onDraft: (c: string | null) => onDraft(c === null ? null : ({ [key]: c } as TextStylePatch)),
    onCommit: (c: string) => onCommit({ [key]: c } as TextStylePatch),
  });
  const box = style.sizing === "box";

  return (
    <div className="flex flex-col gap-3 text-caption" data-testid="text-panel">
      <div className="flex items-center gap-2">
        <button type="button" disabled={locked} onClick={onEditText} className="flex flex-1 items-center gap-1.5 truncate rounded-md border border-(--color-border) px-2 py-1.5 text-left hover:bg-(--color-bg-subtle) disabled:opacity-40" title="Edit text on canvas (double-click or Enter)">
          <Pencil className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{text || <em className="text-(--color-text-faint)">empty</em>}</span>
        </button>
        <button type="button" onClick={onCopyStyle} className="rounded p-1.5 hover:bg-(--color-bg-subtle)" aria-label="Copy text style" title="Copy text style">
          <ClipboardCopy className="h-3.5 w-3.5" />
        </button>
        <button type="button" disabled={locked || !canPasteStyle} onClick={onPasteStyle} className="rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40" aria-label="Paste text style" title="Paste text style">
          <ClipboardPaste className="h-3.5 w-3.5" />
        </button>
      </div>
      {text.length > TEXT_SOFT_LENGTH_LIMIT && <p className="rounded bg-warning-500/10 px-2 py-1 text-warning-700 dark:text-warning-300">Very long text ({text.length.toLocaleString()} characters) — editing may be slow.</p>}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Font</legend>
        <select
          aria-label="Font family"
          value={face?.id ?? "__custom__"}
          disabled={locked}
          onChange={(e) => onCommit({ fontFamily: e.target.value })}
          className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-1"
        >
          {!face && <option value="__custom__">{style.fontFamily} (not bundled)</option>}
          {FONT_FACES.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.cssFamily }}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2">
          <NumberField label="Size" value={style.fontSize} suffix="px" min={1} max={2000} disabled={locked} {...num("fontSize")} />
          <label className="flex flex-col gap-0.5">
            <span className="text-(--color-text-muted)">Weight</span>
            <select aria-label="Font weight" value={style.fontWeight} disabled={locked} onChange={(e) => onCommit({ fontWeight: Number(e.target.value) })} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-1">
              {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                <option key={w} value={w}>
                  {w}
                  {face && !face.weights.includes(w) ? " (n/a)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={locked} aria-pressed={style.fontWeight >= 700} onClick={() => onCommit({ fontWeight: style.fontWeight >= 700 ? 400 : 700 })} className={`mb-0.5 rounded p-1.5 disabled:opacity-40 ${style.fontWeight >= 700 ? "bg-primary-500/15" : "hover:bg-(--color-bg-subtle)"}`} aria-label="Bold" title="Bold">
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={locked} aria-pressed={style.fontStyle === "italic"} onClick={() => onCommit({ fontStyle: style.fontStyle === "italic" ? "normal" : "italic" })} className={`mb-0.5 rounded p-1.5 disabled:opacity-40 ${style.fontStyle === "italic" ? "bg-primary-500/15" : "hover:bg-(--color-bg-subtle)"}`} aria-label="Italic" title="Italic">
            <Italic className="h-3.5 w-3.5" />
          </button>
        </div>
        {font.warnings.length > 0 && (
          <p className="text-(--color-text-faint)" data-testid="font-warning">
            {font.warnings.join(" ")}
          </p>
        )}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 font-medium">Color</legend>
        <ColorField label="Text color" value={style.color} disabled={locked} {...color("color")} />
        <NumberField label="Layer opacity" value={opacity * 100} suffix="%" min={0} max={100} precision={0} disabled={locked} onScrub={() => {}} onCommit={(n) => onCommitOpacity(n / 100)} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Alignment</legend>
        <div className="grid grid-cols-[3fr_2fr] gap-2">
          <Seg
            label="Horizontal alignment"
            value={style.textAlign}
            disabled={locked}
            onChange={(v) => onCommit({ textAlign: v })}
            options={[
              { v: "left", label: "Align left", Icon: AlignLeft },
              { v: "center", label: "Align center", Icon: AlignCenter },
              { v: "right", label: "Align right", Icon: AlignRight },
              { v: "justify", label: "Justify", Icon: AlignJustify },
            ]}
          />
          <Seg
            label="Vertical alignment"
            value={style.verticalAlign}
            disabled={locked}
            onChange={(v) => onCommit({ verticalAlign: v })}
            options={[
              { v: "top", label: "Align top", Icon: AlignVerticalJustifyStart },
              { v: "middle", label: "Align middle", Icon: AlignVerticalJustifyCenter },
              { v: "bottom", label: "Align bottom", Icon: AlignVerticalJustifyEnd },
            ]}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Layout</legend>
        <Seg
          label="Text box mode"
          value={style.sizing}
          disabled={locked}
          onChange={(v) => onCommit(v === "box" ? { sizing: "box", boxWidth: style.boxWidth ?? Math.round(layout?.width ?? 600) } : { sizing: "point" })}
          options={[
            { v: "point", label: "Auto width" },
            { v: "box", label: "Fixed box" },
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Box width" value={box ? style.boxWidth ?? 0 : layout?.width ?? 0} suffix="px" min={1} disabled={locked || !box} {...num("boxWidth")} />
          <NumberField label={box && style.boxHeight === undefined ? "Box height (auto)" : "Box height"} value={box ? style.boxHeight ?? layout?.height ?? 0 : layout?.height ?? 0} suffix="px" min={1} disabled={locked || !box} {...num("boxHeight")} />
          <NumberField label="Line height" value={style.lineHeight} step={0.05} precision={2} min={0.5} max={5} disabled={locked} {...num("lineHeight")} />
          <NumberField label="Letter spacing" value={style.letterSpacing} suffix="px" step={0.5} disabled={locked} {...num("letterSpacing")} />
        </div>
        {box && (
          <div className="flex flex-wrap items-center gap-3">
            {style.boxHeight !== undefined && (
              <button type="button" disabled={locked} onClick={() => onCommit({ boxHeight: null })} className="underline disabled:opacity-40">
                Auto height
              </button>
            )}
            <label className="flex items-center gap-1">
              Overflow
              <select aria-label="Overflow" value={style.overflow} disabled={locked} onChange={(e) => onCommit({ overflow: e.target.value as TextStyle["overflow"] })} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5">
                <option value="visible">Grow box</option>
                <option value="clip">Clip</option>
              </select>
            </label>
            {layout?.overflowed && <span className="text-warning-600" data-testid="overflow-warning">Text is clipped</span>}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">
          <Toggle label="Background" checked={style.background} disabled={locked} onChange={(v) => onCommit({ background: v })} />
        </legend>
        <div className={`grid grid-cols-2 gap-2 ${style.background ? "" : "opacity-50"}`}>
          <ColorField label="BG color" value={style.backgroundColor} disabled={locked} {...color("backgroundColor")} />
          <NumberField label="BG opacity" value={style.backgroundOpacity * 100} suffix="%" min={0} max={100} precision={0} disabled={locked} {...num("backgroundOpacity", (n) => n / 100)} />
          <NumberField label="Padding" value={style.padding} suffix="px" min={0} disabled={locked} {...num("padding")} />
          <NumberField label="Radius" value={style.borderRadius} suffix="px" min={0} disabled={locked} {...num("borderRadius")} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">
          <Toggle label="Stroke" checked={style.stroke} disabled={locked} onChange={(v) => onCommit({ stroke: v })} />
        </legend>
        <div className={`grid grid-cols-2 gap-2 ${style.stroke ? "" : "opacity-50"}`}>
          <ColorField label="Stroke color" value={style.strokeColor} disabled={locked} {...color("strokeColor")} />
          <NumberField label="Stroke width" value={style.strokeWidth} suffix="px" min={0} step={0.5} disabled={locked} {...num("strokeWidth")} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">
          <Toggle label="Shadow" checked={style.shadow} disabled={locked} onChange={(v) => onCommit({ shadow: v })} />
        </legend>
        <div className={`grid grid-cols-2 gap-2 ${style.shadow ? "" : "opacity-50"}`}>
          <ColorField label="Shadow color" value={style.shadowColor} disabled={locked} {...color("shadowColor")} />
          <NumberField label="Shadow blur" value={style.shadowBlur} suffix="px" min={0} disabled={locked} {...num("shadowBlur")} />
          <NumberField label="Shadow X" value={style.shadowOffsetX} suffix="px" disabled={locked} {...num("shadowOffsetX")} />
          <NumberField label="Shadow Y" value={style.shadowOffsetY} suffix="px" disabled={locked} {...num("shadowOffsetY")} />
        </div>
      </fieldset>
    </div>
  );
}
