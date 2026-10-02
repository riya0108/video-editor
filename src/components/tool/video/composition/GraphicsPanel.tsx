import type { ShapeSpec, SvgSpec, ShapePatch, SvgPatch, ArrowHead } from "../../../../lib/timeline/shape-style";
import { NumberField } from "./TransformPanel";
import { ColorField, Seg, Toggle } from "./TextPanel";

/**
 * GRAPHICS INSPECTOR (GRAPHICS_ENGINE_ARCHITECTURE.md §4). Edits a graphic's
 * own spec (shape or SVG); placement (position/rotation/scale/anchor/opacity)
 * stays in TransformPanel — one control per model field.
 *
 * Same contract as the text inspector: scrubbing/picking previews live through
 * `onDraft` (no history); each finished change is ONE undo step via `onCommit`.
 */
type Props =
  | { kind: "shape"; spec: ShapeSpec; locked: boolean; onDraft: (p: ShapePatch | null) => void; onCommit: (p: ShapePatch) => void }
  | { kind: "svg"; spec: SvgSpec; locked: boolean; onDraft: (p: SvgPatch | null) => void; onCommit: (p: SvgPatch) => void };

const SHAPE_LABEL: Record<ShapeSpec["type"], string> = { rect: "Rectangle", ellipse: "Ellipse", polygon: "Polygon", line: "Line", arrow: "Arrow" };

export default function GraphicsPanel(props: Props) {
  const { locked } = props;
  const num = <K extends string>(key: K, toModel: (n: number) => number = (n) => n) => ({
    onScrub: (n: number | null) => (props.onDraft as (p: Record<string, number> | null) => void)(n === null ? null : { [key]: toModel(n) }),
    onCommit: (n: number) => (props.onCommit as (p: Record<string, number>) => void)({ [key]: toModel(n) }),
  });
  const color = (key: string) => ({
    onDraft: (c: string | null) => (props.onDraft as (p: Record<string, string> | null) => void)(c === null ? null : { [key]: c }),
    onCommit: (c: string) => (props.onCommit as (p: Record<string, string>) => void)({ [key]: c }),
  });
  const commit = (p: Record<string, unknown>) => (props.onCommit as (p: Record<string, unknown>) => void)(p);
  const s = props.spec;

  return (
    <div className="flex flex-col gap-3 text-caption" data-testid="graphics-panel">
      <p className="font-medium">{props.kind === "shape" ? SHAPE_LABEL[props.spec.type] : "SVG graphic"}</p>

      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 font-medium">Size</legend>
        <NumberField label="Graphic width" value={s.width} suffix="px" min={1} disabled={locked} {...num("width")} />
        {props.kind === "shape" && (props.spec.type === "line" || props.spec.type === "arrow") ? (
          <NumberField label="Thickness (stroke)" value={props.spec.strokeWidth} suffix="px" min={1} disabled={locked} {...num("strokeWidth")} />
        ) : (
          <NumberField label="Graphic height" value={s.height} suffix="px" min={1} disabled={locked} {...num("height")} />
        )}
        {props.kind === "svg" && (
          <button
            type="button"
            disabled={locked}
            onClick={() => commit({ width: props.spec.intrinsicWidth, height: props.spec.intrinsicHeight })}
            className="col-span-2 justify-self-start underline disabled:opacity-40"
          >
            Reset to original size ({Math.round(props.spec.intrinsicWidth)}×{Math.round(props.spec.intrinsicHeight)})
          </button>
        )}
      </fieldset>

      {props.kind === "shape" && props.spec.type === "rect" && <NumberField label="Corner radius" value={props.spec.cornerRadius} suffix="px" min={0} disabled={locked} {...num("cornerRadius")} />}
      {props.kind === "shape" && props.spec.type === "polygon" && <NumberField label="Sides" value={props.spec.sides} precision={0} min={3} max={64} disabled={locked} {...num("sides", Math.round)} />}
      {props.kind === "shape" && props.spec.type === "arrow" && (
        <div className="grid grid-cols-2 items-end gap-2">
          <Seg<ArrowHead>
            label="Arrowheads"
            value={props.spec.arrowHead}
            disabled={locked}
            onChange={(v) => commit({ arrowHead: v })}
            options={[
              { v: "start", label: "←" },
              { v: "end", label: "→" },
              { v: "both", label: "↔" },
            ]}
          />
          <NumberField label="Head size" value={props.spec.headSize} suffix="px" min={2} disabled={locked} {...num("headSize")} />
        </div>
      )}

      {props.kind === "shape" && props.spec.type !== "line" && props.spec.type !== "arrow" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1">
            <Toggle label="Fill" checked={props.spec.fill} disabled={locked} onChange={(v) => commit({ fill: v })} />
          </legend>
          <div className={props.spec.fill ? "" : "opacity-50"}>
            <ColorField label="Fill color" value={props.spec.fillColor} disabled={locked} {...color("fillColor")} />
          </div>
        </fieldset>
      )}

      {props.kind === "shape" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1">
            {props.spec.type === "line" || props.spec.type === "arrow" ? (
              <span className="font-medium">Stroke</span>
            ) : (
              <Toggle label="Stroke" checked={props.spec.stroke} disabled={locked} onChange={(v) => commit({ stroke: v })} />
            )}
          </legend>
          <div className={`grid grid-cols-2 gap-2 ${props.spec.stroke ? "" : "opacity-50"}`}>
            <ColorField label="Stroke color" value={props.spec.strokeColor} disabled={locked} {...color("strokeColor")} />
            <NumberField label="Stroke width" value={props.spec.strokeWidth} suffix="px" min={0} step={0.5} disabled={locked} {...num("strokeWidth")} />
          </div>
        </fieldset>
      )}

      {props.kind === "svg" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1">
            <Toggle label="Recolor (tint)" checked={props.spec.tint} disabled={locked} onChange={(v) => commit({ tint: v })} />
          </legend>
          <div className={props.spec.tint ? "" : "opacity-50"}>
            <ColorField label="Tint color" value={props.spec.tintColor} disabled={locked} {...color("tintColor")} />
          </div>
          <p className="text-(--color-text-faint)">Tint replaces every color — best for single-color icons.</p>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1">
          <Toggle label="Shadow" checked={s.shadow} disabled={locked} onChange={(v) => commit({ shadow: v })} />
        </legend>
        <div className={`grid grid-cols-2 gap-2 ${s.shadow ? "" : "opacity-50"}`}>
          <ColorField label="Shadow color" value={s.shadowColor} disabled={locked} {...color("shadowColor")} />
          <NumberField label="Shadow blur" value={s.shadowBlur} suffix="px" min={0} disabled={locked} {...num("shadowBlur")} />
          <NumberField label="Shadow X" value={s.shadowOffsetX} suffix="px" disabled={locked} {...num("shadowOffsetX")} />
          <NumberField label="Shadow Y" value={s.shadowOffsetY} suffix="px" disabled={locked} {...num("shadowOffsetY")} />
        </div>
      </fieldset>
    </div>
  );
}
