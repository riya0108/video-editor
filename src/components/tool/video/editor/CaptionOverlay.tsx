import type { CSSProperties } from "react";
import { getTextFont } from "../../../../lib/ffmpeg/fonts";
import { contrastTextColor } from "../../../../lib/captions/contrast-color";
import { INLINE_EMPHASIS_SCALE, pickEmphasisIndex } from "../../../../lib/captions/emphasis";
import { fitFontSizeToWidth } from "../../../../lib/captions/fit-text";
import type { CaptionCue, CaptionStyle } from "../../../../lib/captions/types";

const FADE_DURATION = 0.35;
/** Shorter fade window for word-level ramps — word windows are often only 150-400ms, so the 0.35s cue-level duration would swallow the whole word. */
const WORD_FADE_DURATION = 0.12;

/** Mirrors the export-time alpha ramp (build-captions-filter.ts's fadeAlphaExpr) closely enough for a live preview. `maxDur` caps the in/out ramp length — pass `WORD_FADE_DURATION` for a word's own (much shorter) window instead of the cue-level default. */
function fadeOpacity(time: number, start: number, end: number, maxDur: number = FADE_DURATION): number {
  const dur = Math.min(maxDur, Math.max(0.03, (end - start) / 2));
  if (time < start + dur) return Math.max(0, (time - start) / dur);
  if (time > end - dur) return Math.max(0, (end - time) / dur);
  return 1;
}

/** Fade-in-only ramp for a word's first appearance. It doesn't fade back out on its own — a revealed word stays on screen until the whole cue does, which the cue-level `fadeOpacity` above already handles on the wrapper. */
function fadeInOpacity(time: number, start: number, dur: number = WORD_FADE_DURATION): number {
  if (time < start) return 0;
  return Math.min(1, (time - start) / dur);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** Linearly interpolates two hex colors — used to cross-fade a word's highlight color/box in and out in sync with its own spoken window, instead of hard-switching it the instant playback crosses `word.start`/`word.end`. */
function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function shapeRadius(shape: CaptionStyle["shape"], scale: number): number {
  if (shape === "pill") return 999;
  if (shape === "bubble") return 16 * scale;
  return 6 * scale;
}

/** Combines whichever of glow/shadow/glitch are enabled into one CSS text-shadow value. */
function textShadowFor(style: CaptionStyle, scale: number): string | undefined {
  const layers: string[] = [];
  if (style.glow) {
    const g = style.glowColor;
    layers.push(`0 0 ${6 * scale}px ${g}`, `0 0 ${16 * scale}px ${g}`, `0 0 ${32 * scale}px ${g}`);
  }
  if (style.shadow) {
    layers.push(`${3 * scale}px ${3 * scale}px ${5 * scale}px rgba(0,0,0,0.5)`);
  }
  if (style.glitch) {
    layers.push(`${-3 * scale}px 0 rgba(255,0,90,0.75)`, `${3 * scale}px 0 rgba(0,225,255,0.75)`);
  }
  return layers.length > 0 ? layers.join(", ") : undefined;
}

function animationClass(style: CaptionStyle): string | undefined {
  switch (style.animation) {
    case "pop":
      return "caption-anim-pop";
    case "bounce":
      return "caption-anim-bounce";
    case "slide-up":
      return "caption-anim-slide-up";
    case "glitch":
      return "caption-anim-glitch";
    case "elastic":
      return "caption-anim-elastic";
    case "drop-in":
      return "caption-anim-drop-in";
    case "wave":
      return "caption-anim-wave";
    case "blur-in":
      return "caption-anim-blur-in";
    case "flip":
      return "caption-anim-flip";
    case "shake":
      return "caption-anim-shake";
    case "typewriter":
      return "caption-anim-typewriter";
    default:
      return style.glitch ? "caption-anim-glitch" : undefined;
  }
}

function textFillStyle(style: CaptionStyle, fallbackColor?: string): CSSProperties {
  if (style.gradient.length > 1) {
    return {
      backgroundImage: `linear-gradient(90deg, ${style.gradient.join(", ")})`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
    };
  }
  return { color: fallbackColor ?? style.color };
}

/**
 * Renders one caption cue's text content — word-by-word highlight/word-box,
 * gradient/glow/glitch/glass effects, and entrance animation — exactly the
 * same way in every surface that shows a live caption preview (the
 * standalone Captions tool and the full Video Editor), so a style never
 * looks different depending on where you're editing it.
 */
export default function CaptionOverlay({
  style: baseStyle,
  cue,
  currentTime,
  scale,
  maxWidthPx,
}: {
  style: CaptionStyle;
  cue: CaptionCue;
  currentTime: number;
  scale: number;
  /** On-screen pixel width the caption block has to work with (the preview frame width, minus the drag block's own side margins) — used to shrink oversized text (the Blockbuster style's giant emphasis word, in particular) so it fits instead of running off the frame edge. Omit to skip fitting, e.g. for small mock previews that never overflow. */
  maxWidthPx?: number;
}) {
  // A cue can carry its own fontSize override (set via the floating toolbar
  // while that specific caption is selected) so one line can be sized
  // differently from the rest without touching the shared style.
  const style: CaptionStyle = cue.fontSize !== undefined ? { ...baseStyle, fontSize: cue.fontSize } : baseStyle;
  const font = getTextFont(style.fontId);
  const emphasisFont = getTextFont(style.emphasisFontId);
  const isOverlayEmphasis = style.emphasizeKeyword && style.emphasisLayout === "overlay";
  const displayText = (text: string) => (style.uppercase ? text.toLocaleUpperCase() : text);
  const emphasisDisplayText = (text: string) => (style.emphasisUppercase ? text.toLocaleUpperCase() : text);
  const emphasisGlowShadow = style.glow
    ? `0 0 ${6 * scale}px ${style.glowColor}, 0 0 ${16 * scale}px ${style.glowColor}, 0 0 ${32 * scale}px ${style.glowColor}`
    : undefined;
  // "inline" (Interlock): the word just grows in place within the normal
  // text flow — italic script, noticeably bigger than the surrounding caps.
  const emphasisStyle: CSSProperties = {
    fontFamily: emphasisFont.cssFontFamily,
    fontStyle: "italic",
    fontWeight: 600,
    fontSize: `${INLINE_EMPHASIS_SCALE}em`,
    lineHeight: 0.85,
    color: style.highlightColor,
    textShadow: emphasisGlowShadow,
  };
  const opacity = style.fade ? fadeOpacity(currentTime, cue.start, cue.end) : 1;
  const anim = animationClass(style);
  const radius = shapeRadius(style.shape, scale);
  const textShadow = textShadowFor(style, scale);

  const wrapperStyle: CSSProperties = {
    fontFamily: font.cssFontFamily,
    fontSize: style.fontSize * scale,
    // Tight leading is what makes Interlock's small caps lines nestle up
    // against the oversized script word's line instead of just stacking
    // normally beneath it.
    lineHeight: style.emphasizeKeyword && style.emphasisLayout === "inline" ? 0.8 : 1.15,
    opacity,
    padding: style.background ? `${8 * scale}px ${16 * scale}px` : 0,
    borderRadius: style.background ? radius : undefined,
    backgroundColor: style.background
      ? style.backdropBlur
        ? `${style.backgroundColor}33`
        : style.backgroundColor
      : "transparent",
    backdropFilter: style.background && style.backdropBlur ? `blur(${10 * scale}px)` : undefined,
    WebkitBackdropFilter: style.background && style.backdropBlur ? `blur(${10 * scale}px)` : undefined,
    border: style.background && style.backdropBlur ? `1px solid rgba(255,255,255,0.35)` : undefined,
    boxShadow: style.background && style.glow ? `0 0 ${24 * scale}px ${style.glowColor}` : undefined,
    WebkitTextStroke: style.outline ? `${Math.max(1, style.strokeWidth * scale * 0.55)}px ${style.outlineColor}` : undefined,
    paintOrder: style.outline ? "stroke fill" : undefined,
    ...textFillStyle(style),
    textShadow: !style.background ? textShadow : undefined,
  };

  const hasWords = style.karaoke && cue.words && cue.words.length > 0;
  // Words reveal progressively as the voiceover reaches them, rather than
  // the whole cue's text sitting on screen from the first frame — each word
  // pops in at its own start time and stays through the rest of the cue.
  const visibleWords = hasWords ? cue.words!.filter((w) => currentTime >= w.start) : [];
  const emphasisIndex =
    style.emphasizeKeyword && hasWords
      ? pickEmphasisIndex(cue.words!.map((w) => w.text))
      : style.emphasizeKeyword
        ? pickEmphasisIndex(cue.text.trim().split(/\s+/))
        : -1;

  // "overlay" (Blockbuster): the singled-out word becomes a giant standalone
  // backdrop (shown for the whole cue, title-card style, not tied to its own
  // spoken timing) with the rest of the sentence layered smaller on top,
  // both centered on the same point via a shared grid cell.
  if (isOverlayEmphasis) {
    const allWords = hasWords ? cue.words!.map((w) => w.text) : cue.text.trim().split(/\s+/);
    const bigWord = emphasisDisplayText(allWords[emphasisIndex] ?? "");
    const restWords = hasWords
      ? visibleWords.filter((w) => cue.words!.indexOf(w) !== emphasisIndex).map((w) => w.text)
      : allWords.filter((_, i) => i !== emphasisIndex);
    const restText = restWords.map(displayText).join(" ");
    // The big word is normally 3.3x the base size — huge enough that even a
    // medium-length word can run off the edge of the frame. Shrink it (never
    // grow it) so it always fits within the block's available width instead.
    const bigWordBaseSize = (style.fontSize * scale) * 3.3;
    const bigWordFontSize = maxWidthPx
      ? fitFontSizeToWidth(bigWord, bigWordBaseSize, maxWidthPx, (size) => `800 ${size}px ${emphasisFont.cssFontFamily}`)
      : bigWordBaseSize;

    return (
      <span
        className={`inline-grid max-w-full place-items-center ${!hasWords && anim ? anim : ""}`}
        style={{ ...wrapperStyle, lineHeight: 1, maxWidth: maxWidthPx }}
        key={!hasWords ? cue.id : undefined}
      >
        <span
          aria-hidden="true"
          style={{
            gridArea: "1 / 1",
            fontFamily: emphasisFont.cssFontFamily,
            fontWeight: 800,
            fontSize: bigWordFontSize,
            lineHeight: 1,
            whiteSpace: "nowrap",
            color: style.highlightColor,
            textShadow: emphasisGlowShadow,
          }}
        >
          {bigWord}
        </span>
        <span
          style={{
            gridArea: "1 / 1",
            fontFamily: font.cssFontFamily,
            fontStyle: "italic",
            fontWeight: 700,
            fontSize: "1em",
            padding: "0 0.5em",
            maxWidth: maxWidthPx,
            overflowWrap: "break-word",
            textAlign: "center",
            ...textFillStyle(style),
          }}
        >
          {restText}
        </span>
      </span>
    );
  }

  return (
    <span className={`inline-block max-w-full whitespace-pre-wrap break-words font-semibold ${!hasWords && anim ? anim : ""}`} style={wrapperStyle} key={!hasWords ? cue.id : undefined}>
      {hasWords
        ? visibleWords.map((word, i) => {
            const wordIndex = cue.words!.indexOf(word);
            const active = currentTime >= word.start && currentTime < word.end;
            // With `style.fade` on, the highlight fades in/out across the
            // word's own [start, end) window instead of snapping — `highlightT`
            // is the 0-1 strength of that highlight at the current instant.
            // Without fade, this collapses back to the old plain on/off `active`
            // boolean (as `0`/`1`), preserving the existing hard-cut look.
            const highlightT = style.fade
              ? fadeOpacity(currentTime, word.start, word.end, WORD_FADE_DURATION)
              : active
                ? 1
                : 0;
            // A newly-revealed word eases in over a short window from its own
            // start, rather than popping onto screen the instant playback
            // crosses `word.start` — only when fade is on, matching the
            // export-side reveal ramp in build-captions-filter.ts.
            const revealOpacity = style.fade ? fadeInOpacity(currentTime, word.start) : 1;
            // When `emphasizeKeyword` is on, `highlightColor` is dedicated to
            // that one fixed word — the normal per-word "currently spoken"
            // recolor is suppressed so it doesn't also flash on other words.
            const highlightOn = !style.emphasizeKeyword && highlightT > 0;
            return (
              <span
                key={i}
                className={active && anim ? anim : undefined}
                style={{
                  display: "inline-block",
                  opacity: revealOpacity,
                  ...(wordIndex === emphasisIndex
                    ? emphasisStyle
                    : highlightOn
                      ? style.wordBox
                        ? {
                            backgroundColor: `rgba(${hexToRgb(style.highlightColor).join(", ")}, ${highlightT})`,
                            color: lerpColor(style.color, contrastTextColor(style.highlightColor), highlightT),
                            borderRadius: radius,
                            padding: `${1 * scale}px ${8 * scale}px`,
                            boxShadow: style.glow ? `0 0 ${18 * scale * highlightT}px ${style.glowColor}` : undefined,
                          }
                        : { color: lerpColor(style.color, style.highlightColor, highlightT) }
                      : {}),
                }}
              >
                {wordIndex === emphasisIndex ? emphasisDisplayText(word.text) : displayText(word.text)}
                {i < visibleWords.length - 1 ? " " : ""}
              </span>
            );
          })
        : style.emphasizeKeyword
          ? cue.text
              .trim()
              .split(/\s+/)
              .map((word, i, arr) => (
                <span key={i} style={i === emphasisIndex ? emphasisStyle : undefined}>
                  {i === emphasisIndex ? emphasisDisplayText(word) : displayText(word)}
                  {i < arr.length - 1 ? " " : ""}
                </span>
              ))
          : displayText(cue.text)}
    </span>
  );
}
