import { TEXT_FONTS, type TextFontOption } from "../ffmpeg/fonts";
import type { TextStyle } from "../timeline/text-style";

/**
 * FONT REGISTRY — the text engine's font abstraction (TEXT_ENGINE_ARCHITECTURE.md §2).
 *
 * Built ON the project's existing font list (lib/ffmpeg/fonts.ts TEXT_FONTS,
 * which also feeds ffmpeg drawtext) rather than a second list. Adds what the
 * canvas text engine needs: which weights/styles each family actually ships
 * (matching the @fontsource imports in styles/global.css), and resolution with
 * a GUARANTEED generic fallback — a missing, unknown or invalid font can only
 * ever render in a fallback face, never crash and never render nothing.
 */

export type FontStatus = "ok" | "weight-substituted" | "unknown-family" | "invalid" | "load-failed";

export interface RegisteredFont {
  id: string;
  label: string;
  cssFamily: string;
  /** Weights actually shipped. Variable fonts list their full range. */
  weights: readonly number[];
  /** true only if a real italic face ships; otherwise the browser synthesizes an oblique. */
  italic: boolean;
  generic: "sans-serif" | "serif" | "monospace" | "cursive";
}

/** Weights shipped per family — must match the @fontsource imports in src/styles/global.css. */
const SHIPPED: Record<string, { weights: number[]; italic?: boolean }> = {
  geist: { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] }, // @fontsource-variable/geist
  mono: { weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] }, // @fontsource-variable/geist-mono
  poppins: { weights: [700] },
  playfair: { weights: [700] },
  caveat: { weights: [700] },
  oswald: { weights: [600] },
  "dancing-script": { weights: [700] },
  "roboto-slab": { weights: [700] },
  montserrat: { weights: [700] },
};

function genericOf(css: string): RegisteredFont["generic"] {
  if (/monospace/.test(css)) return "monospace";
  if (/cursive/.test(css)) return "cursive";
  if (/serif/.test(css) && !/sans-serif/.test(css)) return "serif";
  return "sans-serif";
}

function toFace(f: TextFontOption): RegisteredFont {
  const shipped = SHIPPED[f.id] ?? { weights: [400] };
  return { id: f.id, label: f.label, cssFamily: f.cssFontFamily, weights: shipped.weights, italic: shipped.italic ?? false, generic: genericOf(f.cssFontFamily) };
}

export const FONT_FACES: readonly RegisteredFont[] = TEXT_FONTS.map(toFace);
export const DEFAULT_FONT_ID = "geist";

export function getFontFace(id: string): RegisteredFont | undefined {
  return FONT_FACES.find((f) => f.id === id);
}

export interface ResolvedFont {
  /** Full CSS font-family stack, always ending in a generic family. */
  cssFamily: string;
  weight: number;
  style: "normal" | "italic";
  /** Registry face when the family is known. */
  face?: RegisteredFont;
  status: FontStatus;
  warnings: string[];
}

/** Characters that would let a family string break out of the CSS `font` shorthand. */
const UNSAFE_FAMILY = /[;{}\\]|\/\*/;

function nearestWeight(weights: readonly number[], wanted: number): number {
  return weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), weights[0]);
}

/**
 * Resolves a style's font request to something renderable. Pure (no DOM).
 *  - registry id -> its stack; a weight the family doesn't ship snaps to the
 *    nearest shipped weight (instead of the browser's faux-bold), with a warning;
 *  - a raw CSS family -> used with a generic fallback appended ("unknown-family");
 *  - empty/unsafe -> the default font ("invalid").
 */
export function resolveFont(style: Pick<TextStyle, "fontFamily" | "fontWeight" | "fontStyle">): ResolvedFont {
  const warnings: string[] = [];
  const requested = (style.fontFamily ?? "").trim();
  const italic = style.fontStyle === "italic" ? "italic" : "normal";
  let face = getFontFace(requested);

  if (!requested || UNSAFE_FAMILY.test(requested)) {
    face = getFontFace(DEFAULT_FONT_ID)!;
    return { cssFamily: face.cssFamily, weight: nearestWeight(face.weights, style.fontWeight), style: italic, face, status: "invalid", warnings: [`Invalid font "${requested}" — using ${face.label}.`] };
  }
  if (!face) {
    // Arbitrary CSS family (e.g. a system font). The browser picks the fallback if it isn't installed; we just guarantee one exists.
    const stack = /(serif|sans-serif|monospace|cursive|system-ui)\s*$/.test(requested) ? requested : `${requested}, ui-sans-serif, sans-serif`;
    return { cssFamily: stack, weight: style.fontWeight, style: italic, status: "unknown-family", warnings: [`"${requested}" isn't a bundled font — it renders only if installed on this device, otherwise in a fallback font.`] };
  }
  let weight = style.fontWeight;
  let status: FontStatus = "ok";
  if (!face.weights.includes(weight)) {
    weight = nearestWeight(face.weights, weight);
    status = "weight-substituted";
    warnings.push(`${face.label} ships weight${face.weights.length > 1 ? "s" : ""} ${face.weights.join(", ")} — using ${weight}.`);
  }
  if (italic === "italic" && !face.italic) warnings.push(`${face.label} has no italic face — the browser slants it (synthetic oblique).`);
  return { cssFamily: face.cssFamily, weight, style: italic, face, status, warnings };
}

/** CSS `font` shorthand for canvas, from the RESOLVED font (never the raw request). */
export function cssFontString(style: Pick<TextStyle, "fontFamily" | "fontWeight" | "fontStyle" | "fontSize">): string {
  const r = resolveFont(style);
  return `${r.style === "italic" ? "italic " : ""}${r.weight} ${style.fontSize}px ${r.cssFamily}`;
}

/**
 * Loads a font for canvas use. Canvas text doesn't trigger web-font loading
 * the way DOM text does, so anything about to be measured/drawn must be
 * loaded explicitly. Never throws: resolves to whether a real face loaded
 * (false = it will render in the fallback). Bounded by a timeout so a hung
 * font request can't stall rendering forever.
 */
export async function loadFont(style: Pick<TextStyle, "fontFamily" | "fontWeight" | "fontStyle" | "fontSize">, sampleText = "Aa", timeoutMs = 4000): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  const font = cssFontString({ ...style, fontSize: 16 });
  try {
    const faces = await Promise.race([document.fonts.load(font, sampleText || "Aa"), new Promise<unknown[]>((res) => setTimeout(() => res([]), timeoutMs))]);
    return Array.isArray(faces) && faces.length > 0;
  } catch {
    return false;
  }
}
