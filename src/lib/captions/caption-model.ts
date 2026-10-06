import { DEFAULT_TEXT_STYLE, normalizeTextStyle, type TextStyle } from "../timeline/text-style";
import { defaultClipVisual, type ClipVisual } from "../timeline/visual";

/**
 * CAPTIONS MODEL (CAPTIONS_ARCHITECTURE.md §2).
 *
 * A caption track (Track.kind "caption") holds one CLIP per caption segment, so
 * every existing timeline operation (move, trim, split, delete, duplicate,
 * snapping, undo, transitions, effects, keyframes) applies to captions as-is.
 * The track carries the shared look (CaptionTrackSettings); a segment carries
 * its text, optional speaker and optional per-word timing. At render time a
 * segment becomes an ordinary TEXT layer — the Text Engine lays it out and
 * draws it; nothing here rasterizes text.
 */

/** Word times are kept at millisecond precision (subtitle precision) — no float noise accumulates through edits. */
export const ms = (sec: number) => Math.round(sec * 1000) / 1000;

/** A timed word. Seconds RELATIVE TO THE CAPTION CLIP'S START (so moving a caption moves its words). */
export interface CaptionWordTiming {
  text: string;
  start: number;
  end: number;
}

export type CaptionAnchor = "top" | "middle" | "bottom";

/** Shared caption look for a track. Lengths in composition px; position as a fraction of the frame. */
export interface CaptionStyleSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  uppercase: boolean;
  textAlign: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  stroke: boolean;
  strokeColor: string;
  strokeWidth: number;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  padding: number;
  borderRadius: number;
  shadow: boolean;
  /** Anchor point position, 0..1 of the composition. */
  x: number;
  y: number;
  /** Which edge of the caption box sits on (x, y): bottom-anchored captions grow upward when they wrap. */
  anchor: CaptionAnchor;
  /** Wrap width, fraction of the composition width. */
  maxWidth: number;
  /**
   * RESERVED (future, not rendered yet): word highlighting / animated captions / kinetic typography read these.
   * Kept in the model so projects written now round-trip into the builds that render them.
   */
  highlightColor?: string;
  animation?: string;
}

export interface CaptionTrackSettings {
  style: CaptionStyleSettings;
  /** Preset the style was last set from (UI hint; the style itself is the truth). */
  presetId?: string;
  /** BCP-47-ish language tag of the captions (exported in VTT header metadata). */
  language?: string;
  /** Optional color per speaker name — overrides style.color for that speaker's segments. */
  speakerColors?: Record<string, string>;
}

export const DEFAULT_CAPTION_STYLE_SETTINGS: Readonly<CaptionStyleSettings> = Object.freeze({
  fontFamily: "geist",
  fontSize: 56,
  fontWeight: 700,
  italic: false,
  color: "#ffffff",
  uppercase: false,
  textAlign: "center",
  lineHeight: 1.2,
  letterSpacing: 0,
  stroke: false,
  strokeColor: "#000000",
  strokeWidth: 4,
  background: true,
  backgroundColor: "#000000",
  backgroundOpacity: 0.7,
  padding: 14,
  borderRadius: 8,
  shadow: false,
  x: 0.5,
  y: 0.9,
  anchor: "bottom",
  maxWidth: 0.8,
} satisfies CaptionStyleSettings);

// ---------------------------------------------------------------------------
// PRESETS
// ---------------------------------------------------------------------------

export interface CaptionPreset {
  id: string;
  label: string;
  style: CaptionStyleSettings;
}

const P = (id: string, label: string, patch: Partial<CaptionStyleSettings>): CaptionPreset => ({ id, label, style: { ...DEFAULT_CAPTION_STYLE_SETTINGS, ...patch } });

export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  P("classic", "Classic subtitle", {}),
  P("outline", "Clean outline", { background: false, stroke: true, strokeWidth: 5, fontWeight: 700 }),
  P("cinema", "Cinema yellow", { background: false, stroke: true, strokeWidth: 3, color: "#facc15", fontSize: 50, fontWeight: 600 }),
  P("boxed", "Boxed white", { color: "#0f172a", backgroundColor: "#ffffff", backgroundOpacity: 1, borderRadius: 12, fontWeight: 800 }),
  P("creator", "Big & bold", { fontFamily: "anton", fontSize: 96, uppercase: true, background: false, stroke: true, strokeWidth: 8, y: 0.62, anchor: "middle", maxWidth: 0.7, fontWeight: 400 }),
  P("news", "News lower third", { textAlign: "left", x: 0.06, y: 0.86, anchor: "bottom", backgroundColor: "#1d4ed8", backgroundOpacity: 0.95, borderRadius: 0, maxWidth: 0.6, fontSize: 48 }),
  P("top", "Top caption", { y: 0.08, anchor: "top" }),
  P("karaoke-ready", "Karaoke-ready", { background: false, stroke: true, strokeWidth: 6, fontSize: 72, uppercase: true, highlightColor: "#facc15", fontWeight: 900 }),
];

export function getCaptionPreset(id: string): CaptionPreset | undefined {
  return CAPTION_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const color = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Complete, clamped caption style from untrusted/partial data. */
export function normalizeCaptionStyle(raw: unknown): CaptionStyleSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CAPTION_STYLE_SETTINGS;
  const out: CaptionStyleSettings = {
    fontFamily: typeof r.fontFamily === "string" && r.fontFamily.trim() ? r.fontFamily : d.fontFamily,
    fontSize: num(r.fontSize, 8, 400, d.fontSize),
    fontWeight: Math.round(num(r.fontWeight, 100, 900, d.fontWeight) / 100) * 100,
    italic: bool(r.italic, d.italic),
    color: color(r.color, d.color),
    uppercase: bool(r.uppercase, d.uppercase),
    textAlign: r.textAlign === "left" || r.textAlign === "right" ? r.textAlign : "center",
    lineHeight: num(r.lineHeight, 0.8, 3, d.lineHeight),
    letterSpacing: num(r.letterSpacing, -20, 100, d.letterSpacing),
    stroke: bool(r.stroke, d.stroke),
    strokeColor: color(r.strokeColor, d.strokeColor),
    strokeWidth: num(r.strokeWidth, 0, 40, d.strokeWidth),
    background: bool(r.background, d.background),
    backgroundColor: color(r.backgroundColor, d.backgroundColor),
    backgroundOpacity: num(r.backgroundOpacity, 0, 1, d.backgroundOpacity),
    padding: num(r.padding, 0, 200, d.padding),
    borderRadius: num(r.borderRadius, 0, 200, d.borderRadius),
    shadow: bool(r.shadow, d.shadow),
    x: num(r.x, 0, 1, d.x),
    y: num(r.y, 0, 1, d.y),
    anchor: r.anchor === "top" || r.anchor === "middle" ? r.anchor : r.anchor === "bottom" ? "bottom" : d.anchor,
    maxWidth: num(r.maxWidth, 0.1, 1, d.maxWidth),
  };
  if (typeof r.highlightColor === "string" && HEX.test(r.highlightColor)) out.highlightColor = r.highlightColor.toLowerCase();
  if (typeof r.animation === "string") out.animation = r.animation;
  return out;
}

export function normalizeCaptionTrackSettings(raw: unknown): CaptionTrackSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: CaptionTrackSettings = { style: normalizeCaptionStyle(r.style) };
  if (typeof r.presetId === "string") out.presetId = r.presetId;
  if (typeof r.language === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(r.language)) out.language = r.language;
  if (typeof r.speakerColors === "object" && r.speakerColors !== null) {
    const sc: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.speakerColors as Record<string, unknown>)) if (typeof v === "string" && HEX.test(v)) sc[k] = v.toLowerCase();
    if (Object.keys(sc).length) out.speakerColors = sc;
  }
  return out;
}

/** Validates word timings: finite, non-negative, start <= end, sorted; null if unusable. */
export function normalizeWords(raw: unknown): CaptionWordTiming[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CaptionWordTiming[] = [];
  for (const w of raw) {
    if (typeof w !== "object" || w === null) return null;
    const { text, start, end } = w as Record<string, unknown>;
    if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
    out.push({ text, start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ---------------------------------------------------------------------------
// RENDERING BRIDGE — caption -> Text Engine inputs (no text drawing here)
// ---------------------------------------------------------------------------

/** The TextStyle a caption renders with: the Text Engine's own style type, so layout/drawing are the existing ones. */
export function captionTextStyle(s: CaptionStyleSettings, comp: { width: number }, speakerColor?: string): TextStyle {
  return normalizeTextStyle({
    ...DEFAULT_TEXT_STYLE,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontStyle: s.italic ? "italic" : "normal",
    color: speakerColor ?? s.color,
    textAlign: s.textAlign,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    sizing: "point",
    maxWidth: Math.max(1, Math.round(s.maxWidth * comp.width - 2 * s.padding)),
    background: s.background,
    backgroundColor: s.backgroundColor,
    backgroundOpacity: s.backgroundOpacity,
    padding: s.padding,
    borderRadius: s.borderRadius,
    stroke: s.stroke,
    strokeColor: s.strokeColor,
    strokeWidth: s.strokeWidth,
    shadow: s.shadow,
  });
}

/** Text as displayed (uppercase applied). The stored text is never rewritten. */
export function captionDisplayText(text: string, s: CaptionStyleSettings): string {
  return s.uppercase ? text.toLocaleUpperCase() : text;
}

/** Track-level placement as a ClipVisual (anchor from alignment + vertical anchor). A segment's own clip.visual overrides it. */
export function captionDefaultVisual(s: CaptionStyleSettings, comp: { width: number; height: number }): ClipVisual {
  const v = defaultClipVisual(comp.width, comp.height);
  return {
    ...v,
    fit: "none",
    transform: {
      ...v.transform,
      x: s.x * comp.width,
      y: s.y * comp.height,
      anchorX: s.textAlign === "left" ? 0 : s.textAlign === "right" ? 1 : 0.5,
      anchorY: s.anchor === "top" ? 0 : s.anchor === "middle" ? 0.5 : 1,
    },
  };
}

// ---------------------------------------------------------------------------
// WORD TIMING HELPERS (manual correction, split, trim)
// ---------------------------------------------------------------------------

/**
 * After the text of a caption is corrected by hand: if the word count is unchanged the timings carry over word for
 * word (typo fixes keep exact timing); otherwise the words are re-spread over the caption's span proportionally to
 * their length (approximate — flagged by the caller). Returns undefined when there were no timings.
 */
export function retimeWords(oldWords: readonly CaptionWordTiming[] | undefined, newText: string, durationSec: number): CaptionWordTiming[] | undefined {
  if (!oldWords || oldWords.length === 0) return undefined;
  const tokens = newText.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.length === oldWords.length) return tokens.map((t, i) => ({ text: t, start: oldWords[i].start, end: oldWords[i].end }));
  const span0 = Math.min(oldWords[0].start, durationSec);
  const span1 = Math.min(Math.max(span0, oldWords[oldWords.length - 1].end), durationSec);
  return spreadWords(tokens, span0, span1);
}

/** Spreads words over [start, end] proportionally to character length. */
export function spreadWords(tokens: readonly string[], start: number, end: number): CaptionWordTiming[] {
  const total = tokens.reduce((s, t) => s + t.length, 0) || 1;
  let cur = start;
  return tokens.map((t) => {
    const d = ((end - start) * t.length) / total;
    const w = { text: t, start: ms(cur), end: ms(cur + d) };
    cur += d;
    return w;
  });
}

/**
 * Where to split a caption at clip-relative second `at`: with word timings, words starting before `at` go left (the
 * right half's timings shift to its own start); without, the text splits at the word boundary nearest the
 * proportional character position.
 */
export function splitCaptionText(text: string, words: readonly CaptionWordTiming[] | undefined, at: number, durationSec: number): { left: { text: string; words?: CaptionWordTiming[] }; right: { text: string; words?: CaptionWordTiming[] } } {
  if (words && words.length > 0) {
    const L = words.filter((w) => w.start < at);
    const R = words.filter((w) => w.start >= at).map((w) => ({ text: w.text, start: ms(Math.max(0, w.start - at)), end: ms(Math.max(0, w.end - at)) }));
    return { left: { text: L.map((w) => w.text).join(" "), words: L.map((w) => ({ ...w, end: ms(Math.min(w.end, at)) })) }, right: { text: R.map((w) => w.text).join(" "), words: R } };
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { left: { text }, right: { text: "" } };
  const target = (text.length * at) / Math.max(1e-9, durationSec);
  let best = 1;
  let bestErr = Infinity;
  let pos = 0;
  for (let i = 1; i < tokens.length; i++) {
    pos += tokens[i - 1].length + 1;
    const err = Math.abs(pos - target);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return { left: { text: tokens.slice(0, best).join(" ") }, right: { text: tokens.slice(best).join(" ") } };
}

/** Index of the word being spoken at clip-relative second `t` (for future word highlighting), or -1. */
export function activeWordIndex(words: readonly CaptionWordTiming[] | undefined, t: number): number {
  if (!words) return -1;
  for (let i = 0; i < words.length; i++) if (t >= words[i].start && t < words[i].end) return i;
  return -1;
}
