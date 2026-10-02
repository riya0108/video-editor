import type { TextStyle } from "../timeline/text-style";
import { cssFontString } from "../text/font-registry";

/**
 * TEXT MEASUREMENT & LAYOUT (TEXT_ENGINE_ARCHITECTURE.md §3).
 *
 * Measurement is injected, never done here directly — layout (and therefore
 * scene resolution, which needs a text layer's box size for anchoring,
 * hit-testing and handles) stays pure and testable in Node. The browser
 * implementation is createCanvasTextMeasurer() below.
 *
 * Everything is measured in COMPOSITION pixels (font size as authored); the
 * renderer draws with the whole context scaled. Wrapping decisions are
 * therefore identical at every preview scale and at final resolution —
 * measuring at the scaled preview size would let hinting re-wrap a line
 * between preview and export.
 */
export interface TextMeasurer {
  /**
   * Advance width of `text` in `style`, INCLUDING letterSpacing between
   * glyphs but NOT after the last one (so right/center alignment lands on
   * the last glyph, not on trailing spacing).
   */
  measureWidth(text: string, style: TextStyle): number;
  /** Font ascent/descent (px, positive) for baseline placement. Optional — falls back to 0.8/0.2 em. */
  fontMetrics?(style: TextStyle): { ascent: number; descent: number };
  /** Drops cached metrics — call when a web font finishes loading, or widths measured against the fallback font stick around. */
  invalidate?(): void;
  /** Bumped by invalidate(); lets layout caches know their entries are stale. */
  readonly generation?: number;
}

export interface TextLine {
  text: string;
  width: number;
  /** Last line of a paragraph (explicit newline or end of text) — never justified. */
  paragraphEnd: boolean;
}

export interface TextLayout {
  lines: TextLine[];
  /** Outer box (padding included), composition px. */
  width: number;
  height: number;
  /** Width available to lines (box minus padding). */
  contentWidth: number;
  /** Y of the first line's top, inside the box (padding + vertical alignment). */
  contentTop: number;
  lineHeightPx: number;
  ascent: number;
  descent: number;
  /** Lines exceed a fixed height and are being clipped (overflow: "clip"). */
  overflowed: boolean;
}

/** Back-compat: the CSS `font` string for a style, through the font registry (guaranteed fallback). */
export function cssFont(style: TextStyle): string {
  return cssFontString(style);
}

/** User-perceived characters (emoji, combining marks, flags never split). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  return Array.from(text);
}

/** Breaks one over-wide token into chunks that each fit `max` (grapheme-safe). A single grapheme wider than `max` gets its own chunk. */
function breakWord(word: string, max: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const g of graphemes(word)) {
    if (cur && measure(cur + g) > max) {
      out.push(cur);
      cur = g;
    } else cur += g;
  }
  if (cur) out.push(cur);
  return out;
}

export function layoutText(text: string, style: TextStyle, measurer: TextMeasurer): TextLayout {
  const measure = (s: string) => measurer.measureWidth(s, style);
  const pad = style.padding;
  const wrap = style.sizing === "box" && style.boxWidth !== undefined ? Math.max(1, style.boxWidth - pad * 2) : style.maxWidth;

  const lines: TextLine[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (wrap === undefined) {
      lines.push({ text: paragraph, width: measure(paragraph), paragraphEnd: true });
      continue;
    }
    // Split on single spaces so runs of spaces the user typed are preserved when re-joined.
    const tokens = paragraph.split(" ").flatMap((w) => (w && measure(w) > wrap ? breakWord(w, wrap, measure) : [w]));
    let current: string | null = null;
    for (const token of tokens) {
      if (current === null) {
        current = token;
        continue;
      }
      const candidate: string = `${current} ${token}`;
      if (measure(candidate) <= wrap || current === "") current = candidate;
      else {
        lines.push({ text: current, width: measure(current), paragraphEnd: false });
        current = token;
      }
    }
    lines.push({ text: current ?? "", width: measure(current ?? ""), paragraphEnd: true });
  }

  const lineHeightPx = style.fontSize * style.lineHeight;
  const metrics = measurer.fontMetrics?.(style) ?? { ascent: style.fontSize * 0.8, descent: style.fontSize * 0.2 };
  const textHeight = lines.length * lineHeightPx;
  const contentWidth = wrap !== undefined && style.sizing === "box" ? wrap : Math.max(0, ...lines.map((l) => l.width));

  // Height: fixed box height (box mode) or content; maxHeight caps it. With overflow "visible" a fixed height is a MINIMUM — the box (and its background) grows with the text instead of letting it spill outside the layer.
  const natural = textHeight + pad * 2;
  let fixed = style.sizing === "box" ? style.boxHeight : undefined;
  if (style.maxHeight !== undefined) fixed = Math.min(fixed ?? natural, style.maxHeight);
  const height = fixed === undefined ? natural : style.overflow === "clip" ? fixed : Math.max(fixed, natural);
  const overflowed = style.overflow === "clip" && natural > height + 0.5;

  const inner = height - pad * 2;
  const slack = inner - textHeight;
  const contentTop = slack <= 0 ? pad : pad + (style.verticalAlign === "middle" ? slack / 2 : style.verticalAlign === "bottom" ? slack : 0);

  return {
    lines,
    width: Math.max(1, contentWidth + pad * 2),
    height: Math.max(1, height),
    contentWidth,
    contentTop,
    lineHeightPx,
    ascent: metrics.ascent,
    descent: metrics.descent,
    overflowed,
  };
}

/** Line start x (content space) for an alignment. Justified lines start at the left edge; their word gaps are stretched at draw time. */
export function lineX(layout: TextLayout, style: TextStyle, line: TextLine): number {
  const left = style.padding;
  switch (style.textAlign) {
    case "right":
      return left + layout.contentWidth - line.width;
    case "center":
      return left + (layout.contentWidth - line.width) / 2;
    default:
      return left;
  }
}

/** Alphabetic baseline y of line `i`: the font's ascent+descent box centered in the line box (CSS half-leading model). */
export function lineBaseline(layout: TextLayout, i: number): number {
  const halfLeading = (layout.lineHeightPx - (layout.ascent + layout.descent)) / 2;
  return layout.contentTop + i * layout.lineHeightPx + halfLeading + layout.ascent;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Whether this context natively supports `letterSpacing` (Chrome 99+, Safari 18+, Firefox 115+). */
export function supportsLetterSpacing(ctx: Ctx): boolean {
  return "letterSpacing" in ctx;
}

/** Browser measurer. Caches per font+spacing+string — layout may run for every edited keystroke. */
export function createCanvasTextMeasurer(): TextMeasurer {
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
  const ctx = canvas.getContext("2d") as Ctx | null;
  if (!ctx) throw new Error("2D canvas context unavailable for text measurement.");
  const native = supportsLetterSpacing(ctx);
  const widths = new Map<string, number>();
  const metrics = new Map<string, { ascent: number; descent: number }>();
  let generation = 0;

  const measureRaw = (text: string, style: TextStyle): number => {
    ctx.font = cssFont(style);
    const ls = style.letterSpacing;
    if (!ls) return ctx.measureText(text).width;
    const g = graphemes(text);
    if (g.length === 0) return 0;
    if (native) {
      (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${ls}px`;
      const w = ctx.measureText(text).width;
      (ctx as Ctx & { letterSpacing: string }).letterSpacing = "0px";
      return w - ls; // exclude spacing after the last glyph
    }
    return g.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + ls * (g.length - 1);
  };

  return {
    get generation() {
      return generation;
    },
    measureWidth(text, style) {
      const key = `${cssFont(style)}\u0000${style.letterSpacing}\u0000${text}`;
      const hit = widths.get(key);
      if (hit !== undefined) return hit;
      const w = measureRaw(text, style);
      if (widths.size > 20000) widths.clear();
      widths.set(key, w);
      return w;
    },
    fontMetrics(style) {
      const font = cssFont(style);
      const hit = metrics.get(font);
      if (hit) return hit;
      ctx.font = font;
      const m = ctx.measureText("Hgjy");
      // fontBoundingBox* are the font's real ascent/descent (stable per font, independent of the glyphs measured); fall back to em ratios.
      const ascent = Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : style.fontSize * 0.8;
      const descent = Number.isFinite(m.fontBoundingBoxDescent) && m.fontBoundingBoxDescent > 0 ? m.fontBoundingBoxDescent : style.fontSize * 0.2;
      const out = { ascent, descent };
      metrics.set(font, out);
      return out;
    },
    invalidate() {
      widths.clear();
      metrics.clear();
      generation++;
    },
  };
}
