/**
 * TEXT STYLE — the typography half of a text layer (TEXT_ENGINE_ARCHITECTURE.md §1).
 * Placement (position/rotation/scale/anchor/opacity) is NOT here: it's the
 * layer's ClipVisual, shared with every other layer kind.
 *
 * Every length is in COMPOSITION pixels, so the same style lays out
 * identically at every preview scale and at export.
 */

export type FontStyle = "normal" | "italic";
export type TextAlign = "left" | "center" | "right" | "justify";
export type VerticalAlign = "top" | "middle" | "bottom";
/** point: grows with its content (wraps only at maxWidth, if set). box: fixed width (and optional fixed height); text wraps inside. */
export type TextSizing = "point" | "box";
export type TextOverflow = "visible" | "clip";

export interface TextStyle {
  /** Font registry id (e.g. "geist") or a CSS font-family. Resolved with a guaranteed generic fallback — see lib/text/font-registry.ts. */
  fontFamily: string;
  fontSize: number;
  /** 100–900. */
  fontWeight: number;
  fontStyle: FontStyle;
  color: string;

  textAlign: TextAlign;
  /** Only meaningful when the box is taller than the text (box mode with boxHeight, or maxHeight). */
  verticalAlign: VerticalAlign;
  /** Multiple of fontSize. */
  lineHeight: number;
  /** Extra space after every glyph, px (CSS letter-spacing semantics). May be negative. */
  letterSpacing: number;

  sizing: TextSizing;
  /** box mode: outer width of the text box (padding included). */
  boxWidth?: number;
  /** box mode: outer height; undefined = auto (grows with content). */
  boxHeight?: number;
  /** point mode: wrap width cap (content width, padding excluded); undefined = only manual line breaks. */
  maxWidth?: number;
  /** Caps the outer height in either mode. */
  maxHeight?: number;
  /** What happens to lines beyond a fixed height. */
  overflow: TextOverflow;

  background: boolean;
  backgroundColor: string;
  /** 0–1, multiplies the background color's own alpha. */
  backgroundOpacity: number;
  /** Inner padding between box edge and text. Applies with or without a visible background (it's part of the layout box). */
  padding: number;
  borderRadius: number;

  stroke: boolean;
  strokeColor: string;
  /** Visible outline thickness outside the glyph. */
  strokeWidth: number;

  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  /** Offsets in the layer's own space — the shadow rotates/scales with the text. */
  shadowOffsetX: number;
  shadowOffsetY: number;

  /*
   * RESERVED for later phases (not implemented; documented so new fields don't
   * collide): fill (gradient/image text), runs (per-word/per-char style spans
   * over [start,end) of `text`), fontVariations (variable-font axes),
   * textMask. normalizeTextStyle preserves unknown keys, so a project written
   * by a newer build round-trips through this one without losing them.
   */
}

export const DEFAULT_TEXT_STYLE: Readonly<TextStyle> = Object.freeze({
  fontFamily: "geist",
  fontSize: 72,
  fontWeight: 700,
  fontStyle: "normal",
  color: "#ffffff",
  textAlign: "center",
  verticalAlign: "top",
  lineHeight: 1.2,
  letterSpacing: 0,
  sizing: "point",
  overflow: "visible",
  background: false,
  backgroundColor: "#000000",
  backgroundOpacity: 0.8,
  padding: 0,
  borderRadius: 0,
  stroke: false,
  strokeColor: "#000000",
  strokeWidth: 4,
  shadow: false,
  shadowColor: "rgba(0,0,0,0.6)",
  shadowBlur: 12,
  shadowOffsetX: 0,
  shadowOffsetY: 4,
} satisfies TextStyle);

export const TEXT_LIMITS = {
  fontSize: [1, 2000],
  fontWeight: [100, 900],
  lineHeight: [0.5, 5],
  letterSpacing: [-200, 1000],
  box: [1, 20000],
  padding: [0, 2000],
  borderRadius: [0, 5000],
  strokeWidth: [0, 500],
  shadowBlur: [0, 1000],
  shadowOffset: [-5000, 5000],
} as const;

/** Text longer than this is still accepted, but the inspector warns: layout cost grows with length. */
export const TEXT_SOFT_LENGTH_LIMIT = 20000;

const clampNum = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() !== "" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}
const optBox = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? clampNum(v, TEXT_LIMITS.box, 1) : undefined);

/**
 * The ONLY way a style enters the model (edits, rendering, project load).
 * Never throws: fills defaults, migrates legacy (project v1/v2) names,
 * clamps ranges, and replaces garbage with defaults. Unknown keys are
 * preserved for forward compatibility.
 */
export function normalizeTextStyle(raw: unknown): TextStyle {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TEXT_STYLE;

  // v2 -> v3 migrations
  const legacyItalic = typeof r.italic === "boolean" ? (r.italic ? "italic" : "normal") : undefined;
  const legacyAlign = r.align;
  const legacyBackground = typeof r.backgroundColor === "string" && r.background === undefined ? true : undefined;
  const legacyStroke = typeof r.strokeColor === "string" && r.stroke === undefined && typeof r.strokeWidth === "number" && r.strokeWidth > 0 ? true : undefined;

  const { italic: _i, align: _a, ...rest } = r; // drop legacy keys once migrated
  const sizing = oneOf(r.sizing, ["point", "box"] as const, d.sizing);
  const style: TextStyle = {
    ...(rest as Partial<TextStyle>),
    fontFamily: str(r.fontFamily, d.fontFamily),
    fontSize: clampNum(r.fontSize, TEXT_LIMITS.fontSize, d.fontSize),
    fontWeight: Math.round(clampNum(r.fontWeight, TEXT_LIMITS.fontWeight, d.fontWeight) / 100) * 100,
    fontStyle: oneOf(r.fontStyle ?? legacyItalic, ["normal", "italic"] as const, d.fontStyle),
    color: str(r.color, d.color),
    textAlign: oneOf(r.textAlign ?? legacyAlign, ["left", "center", "right", "justify"] as const, d.textAlign),
    verticalAlign: oneOf(r.verticalAlign, ["top", "middle", "bottom"] as const, d.verticalAlign),
    lineHeight: clampNum(r.lineHeight, TEXT_LIMITS.lineHeight, d.lineHeight),
    letterSpacing: clampNum(r.letterSpacing, TEXT_LIMITS.letterSpacing, d.letterSpacing),
    sizing,
    overflow: oneOf(r.overflow, ["visible", "clip"] as const, d.overflow),
    background: bool(r.background ?? legacyBackground, d.background),
    backgroundColor: str(r.backgroundColor, d.backgroundColor),
    backgroundOpacity: clampNum(r.backgroundOpacity, [0, 1], typeof r.backgroundColor === "string" && r.backgroundOpacity === undefined ? 1 : d.backgroundOpacity),
    padding: clampNum(r.padding, TEXT_LIMITS.padding, d.padding),
    borderRadius: clampNum(r.borderRadius, TEXT_LIMITS.borderRadius, d.borderRadius),
    stroke: bool(r.stroke ?? legacyStroke, d.stroke),
    strokeColor: str(r.strokeColor, d.strokeColor),
    strokeWidth: clampNum(r.strokeWidth, TEXT_LIMITS.strokeWidth, d.strokeWidth),
    shadow: bool(r.shadow, d.shadow),
    shadowColor: str(r.shadowColor, d.shadowColor),
    shadowBlur: clampNum(r.shadowBlur, TEXT_LIMITS.shadowBlur, d.shadowBlur),
    shadowOffsetX: clampNum(r.shadowOffsetX, TEXT_LIMITS.shadowOffset, d.shadowOffsetX),
    shadowOffsetY: clampNum(r.shadowOffsetY, TEXT_LIMITS.shadowOffset, d.shadowOffsetY),
  };
  const boxWidth = optBox(r.boxWidth);
  const boxHeight = optBox(r.boxHeight);
  const maxWidth = optBox(r.maxWidth);
  const maxHeight = optBox(r.maxHeight);
  delete style.boxWidth;
  delete style.boxHeight;
  delete style.maxWidth;
  delete style.maxHeight;
  if (boxWidth !== undefined) style.boxWidth = boxWidth;
  if (boxHeight !== undefined) style.boxHeight = boxHeight;
  if (maxWidth !== undefined) style.maxWidth = maxWidth;
  if (maxHeight !== undefined) style.maxHeight = maxHeight;
  // A box needs a width; fall back to point sizing rather than an unusable box.
  if (style.sizing === "box" && style.boxWidth === undefined) style.sizing = "point";
  return style;
}

/** Applies a partial patch then normalizes. `null` on an optional dimension removes it (e.g. boxHeight: null -> auto height). */
export type TextStylePatch = { [K in keyof TextStyle]?: TextStyle[K] | null };

export function patchTextStyle(base: TextStyle | undefined, patch: TextStylePatch): TextStyle {
  const merged: Record<string, unknown> = { ...normalizeTextStyle(base), ...patch };
  for (const k of Object.keys(patch) as (keyof TextStyle)[]) if (patch[k] === null) delete merged[k];
  return normalizeTextStyle(merged);
}

/** Every typographic length, scaled by k — what a corner-handle resize does to text (glyphs re-laid-out, never stretched). */
export function scaleTypography(style: TextStyle, k: number): TextStyle {
  const s = (v: number | undefined) => (v === undefined ? undefined : v * k);
  return patchTextStyle(style, {
    fontSize: style.fontSize * k,
    letterSpacing: style.letterSpacing * k,
    padding: style.padding * k,
    borderRadius: style.borderRadius * k,
    strokeWidth: style.strokeWidth * k,
    shadowBlur: style.shadowBlur * k,
    shadowOffsetX: style.shadowOffsetX * k,
    shadowOffsetY: style.shadowOffsetY * k,
    boxWidth: s(style.boxWidth),
    boxHeight: s(style.boxHeight),
    maxWidth: s(style.maxWidth),
    maxHeight: s(style.maxHeight),
  });
}
