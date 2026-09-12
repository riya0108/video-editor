import type { CSSProperties } from "react";
import { getTextFont } from "../../../../lib/ffmpeg/fonts";
import { contrastTextColor } from "../../../../lib/captions/contrast-color";
import { INLINE_EMPHASIS_SCALE, pickEmphasisIndex } from "../../../../lib/captions/emphasis";
import type { CaptionCue, CaptionStyle } from "../../../../lib/captions/types";

const FADE_DURATION = 0.35;

/** Mirrors the export-time alpha ramp (build-captions-filter.ts's fadeAlphaExpr) closely enough for a live preview. */
function fadeOpacity(time: number, start: number, end: number): number {
  const dur = Math.min(FADE_DURATION, Math.max(0.05, (end - start) / 2));
  if (time < start + dur) return Math.max(0, (time - start) / dur);
  if (time > end - dur) return Math.max(0, (end - time) / dur);
  return 1;
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
  style,
  cue,
  currentTime,
  scale,
}: {
  style: CaptionStyle;
  cue: CaptionCue;
  currentTime: number;
  scale: number;
}) {
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

    return (
      <span
        className={`inline-grid max-w-full place-items-center ${!hasWords && anim ? anim : ""}`}
        style={{ ...wrapperStyle, lineHeight: 1 }}
        key={!hasWords ? cue.id : undefined}
      >
        <span
          aria-hidden="true"
          style={{
            gridArea: "1 / 1",
            fontFamily: emphasisFont.cssFontFamily,
            fontWeight: 800,
            fontSize: "3.3em",
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
            // When `emphasizeKeyword` is on, `highlightColor` is dedicated to
            // that one fixed word — the normal per-word "currently spoken"
            // recolor is suppressed so it doesn't also flash on other words.
            const boxColor = style.wordBox && active && !style.emphasizeKeyword ? style.highlightColor : undefined;
            const plainHighlight = !style.wordBox && active && !style.emphasizeKeyword ? style.highlightColor : undefined;
            return (
              <span
                key={i}
                className={active && anim ? anim : undefined}
                style={{
                  display: "inline-block",
                  ...(wordIndex === emphasisIndex
                    ? emphasisStyle
                    : boxColor
                      ? {
                          backgroundColor: boxColor,
                          color: contrastTextColor(boxColor),
                          borderRadius: radius,
                          padding: `${1 * scale}px ${8 * scale}px`,
                          boxShadow: style.glow ? `0 0 ${18 * scale}px ${style.glowColor}` : undefined,
                        }
                      : plainHighlight
                        ? { color: plainHighlight }
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
