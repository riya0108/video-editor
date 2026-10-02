/**
 * GRAPHICS MODEL (GRAPHICS_ENGINE_ARCHITECTURE.md §1): vector shapes and SVG
 * graphics carried by `graphic` clips. Placement (position/rotation/scale/
 * anchor/opacity/crop) is the layer's ClipVisual — not duplicated here.
 * All lengths are composition pixels.
 */

/** Shared by text and graphics: a shadow in the layer's own space (rotates/scales with it). */
export interface ShadowFields {
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

export type ShapeType = "rect" | "ellipse" | "polygon" | "line" | "arrow";
export type ArrowHead = "end" | "start" | "both";

export interface ShapeSpec extends ShadowFields {
  type: ShapeType;
  width: number;
  /** Box height. For line/arrow it's derived (>= stroke and arrowhead) — their visible thickness comes from strokeWidth. */
  height: number;
  /** Closed shapes only (rect/ellipse/polygon). */
  fill: boolean;
  fillColor: string;
  stroke: boolean;
  strokeColor: string;
  strokeWidth: number;
  /** rect only. */
  cornerRadius: number;
  /** polygon only: regular polygon with a vertex at the top. */
  sides: number;
  /** arrow only. */
  arrowHead: ArrowHead;
  headSize: number;
}

export interface SvgSpec extends ShadowFields {
  /** Sanitized SVG markup, embedded in the project (see lib/graphics/svg.ts). */
  markup: string;
  /** Displayed box size (composition px). Handles edit these — the SVG is re-rasterized at the new size, never stretched from a bitmap. */
  width: number;
  height: number;
  /** The SVG's own size (from width/height or viewBox), for aspect and "reset size". */
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** Recolor every painted pixel (for single-color icons). */
  tint: boolean;
  tintColor: string;
}

const NO_SHADOW: ShadowFields = { shadow: false, shadowColor: "rgba(0,0,0,0.5)", shadowBlur: 16, shadowOffsetX: 0, shadowOffsetY: 6 };

export const DEFAULT_SHAPE: Readonly<ShapeSpec> = Object.freeze({
  type: "rect",
  width: 400,
  height: 240,
  fill: true,
  fillColor: "#6366f1",
  stroke: false,
  strokeColor: "#ffffff",
  strokeWidth: 6,
  cornerRadius: 0,
  sides: 6,
  arrowHead: "end",
  headSize: 40,
  ...NO_SHADOW,
} satisfies ShapeSpec);

export const SHAPE_LIMITS = {
  size: [1, 20000],
  strokeWidth: [0, 1000],
  cornerRadius: [0, 10000],
  sides: [3, 64],
  headSize: [2, 2000],
  shadowBlur: [0, 1000],
  shadowOffset: [-5000, 5000],
} as const;

/** Max embedded SVG size — keeps project files and per-frame rasterization bounded. */
export const SVG_MAX_BYTES = 1024 * 1024;

const clampNum = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() !== "" ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

export function normalizeShadow(r: Record<string, unknown>, d: ShadowFields = NO_SHADOW): ShadowFields {
  return {
    shadow: bool(r.shadow, d.shadow),
    shadowColor: str(r.shadowColor, d.shadowColor),
    shadowBlur: clampNum(r.shadowBlur, SHAPE_LIMITS.shadowBlur, d.shadowBlur),
    shadowOffsetX: clampNum(r.shadowOffsetX, SHAPE_LIMITS.shadowOffset, d.shadowOffsetX),
    shadowOffsetY: clampNum(r.shadowOffsetY, SHAPE_LIMITS.shadowOffset, d.shadowOffsetY),
  };
}

/** Line/arrow box thickness: enough for the stroke, the arrowhead, and a comfortable click target. */
export function lineBoxHeight(s: Pick<ShapeSpec, "type" | "strokeWidth" | "headSize">): number {
  return Math.max(s.strokeWidth, s.type === "arrow" ? s.headSize : 0, 12);
}

/**
 * The ONLY way a shape enters the model (edits, rendering, project load).
 * Never throws. Migrates v1 shapes (`fill?: string`, `stroke?: string`).
 * Unknown keys are preserved for forward compatibility.
 */
export function normalizeShapeSpec(raw: unknown): ShapeSpec {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SHAPE;
  // v1 (project format <= 3) stored fill/stroke as optional COLOR STRINGS. A string here is unambiguous, so it's migrated
  // anywhere. The other v1 rule — an ABSENT fill/stroke meant "off" — is ambiguous with a new partial spec (where absent
  // means "default"), so that part is applied only by the deserializer, for files saved before v4 (see serialize.ts).
  const legacyFill = typeof r.fill === "string" ? r.fill : undefined;
  const legacyStroke = typeof r.stroke === "string" ? r.stroke : undefined;
  const type = oneOf(r.type, ["rect", "ellipse", "polygon", "line", "arrow"] as const, d.type);
  const s: ShapeSpec = {
    ...(r as Partial<ShapeSpec>),
    type,
    width: clampNum(r.width, SHAPE_LIMITS.size, d.width),
    height: clampNum(r.height, SHAPE_LIMITS.size, d.height),
    fill: legacyFill !== undefined ? true : bool(r.fill, d.fill),
    fillColor: str(legacyFill ?? r.fillColor, d.fillColor),
    stroke: legacyStroke !== undefined ? true : bool(r.stroke, d.stroke),
    strokeColor: str(legacyStroke ?? r.strokeColor, d.strokeColor),
    strokeWidth: clampNum(r.strokeWidth, SHAPE_LIMITS.strokeWidth, d.strokeWidth),
    cornerRadius: clampNum(r.cornerRadius, SHAPE_LIMITS.cornerRadius, d.cornerRadius),
    sides: Math.round(clampNum(r.sides, SHAPE_LIMITS.sides, d.sides)),
    arrowHead: oneOf(r.arrowHead, ["end", "start", "both"] as const, d.arrowHead),
    headSize: clampNum(r.headSize, SHAPE_LIMITS.headSize, d.headSize),
    ...normalizeShadow(r),
  };
  if (type === "line" || type === "arrow") {
    // Open shapes are drawn with their stroke; a line with stroke off would be invisible and unselectable.
    s.stroke = true;
    s.fill = false;
    s.height = lineBoxHeight(s);
  }
  return s;
}

export type ShapePatch = Partial<ShapeSpec>;

export function patchShapeSpec(base: unknown, patch: ShapePatch): ShapeSpec {
  return normalizeShapeSpec({ ...normalizeShapeSpec(base), ...patch });
}

export function normalizeSvgSpec(raw: unknown): SvgSpec | null {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r.markup !== "string" || !/<svg[\s>]/i.test(r.markup) || r.markup.length > SVG_MAX_BYTES) return null;
  const iw = clampNum(r.intrinsicWidth, SHAPE_LIMITS.size, 100);
  const ih = clampNum(r.intrinsicHeight, SHAPE_LIMITS.size, 100);
  return {
    ...(r as Partial<SvgSpec>),
    markup: r.markup,
    width: clampNum(r.width, SHAPE_LIMITS.size, iw),
    height: clampNum(r.height, SHAPE_LIMITS.size, ih),
    intrinsicWidth: iw,
    intrinsicHeight: ih,
    tint: bool(r.tint, false),
    tintColor: str(r.tintColor, "#ffffff"),
    ...normalizeShadow(r),
  };
}

export type SvgPatch = Partial<Omit<SvgSpec, "markup" | "intrinsicWidth" | "intrinsicHeight">>;

export function patchSvgSpec(base: SvgSpec, patch: SvgPatch): SvgSpec {
  return normalizeSvgSpec({ ...base, ...patch }) ?? base;
}

/** Presets offered by "Add shape" — sizes are fractions of the composition's short side, so a new shape reads the same at 16:9, 9:16 and 1:1. */
export type ShapePreset = "rect" | "rounded-rect" | "circle" | "ellipse" | "line" | "arrow" | "polygon";

export function shapePreset(preset: ShapePreset, compWidth: number, compHeight: number): ShapeSpec {
  const u = Math.min(compWidth, compHeight);
  switch (preset) {
    case "rect":
      return normalizeShapeSpec({ type: "rect", width: u * 0.4, height: u * 0.25 });
    case "rounded-rect":
      return normalizeShapeSpec({ type: "rect", width: u * 0.4, height: u * 0.25, cornerRadius: u * 0.04 });
    case "circle":
      return normalizeShapeSpec({ type: "ellipse", width: u * 0.3, height: u * 0.3, fillColor: "#f59e0b" });
    case "ellipse":
      return normalizeShapeSpec({ type: "ellipse", width: u * 0.42, height: u * 0.26, fillColor: "#10b981" });
    case "polygon":
      return normalizeShapeSpec({ type: "polygon", width: u * 0.3, height: u * 0.3, sides: 6, fillColor: "#ec4899" });
    case "line":
      return normalizeShapeSpec({ type: "line", width: u * 0.45, strokeWidth: Math.max(2, u * 0.008), strokeColor: "#ffffff" });
    case "arrow":
      return normalizeShapeSpec({ type: "arrow", width: u * 0.45, strokeWidth: Math.max(2, u * 0.01), headSize: u * 0.05, strokeColor: "#facc15" });
  }
}
