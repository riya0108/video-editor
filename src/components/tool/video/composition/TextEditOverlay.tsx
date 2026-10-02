import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ViewportState } from "../../../../lib/composition";
import { multiply, scale, translate, type ResolvedLayer } from "../../../../lib/composition";
import { cssFontString } from "../../../../lib/text/font-registry";

/**
 * TEXT EDIT MODE (TEXT_ENGINE_ARCHITECTURE.md §6). A native <textarea> laid
 * exactly over the text layer — CSS matrix = viewport x layer matrix, the
 * same font stack (via the font registry), size, letter spacing, line
 * height, alignment, stroke, shadow and background — so the user edits the
 * real text in place with the platform's caret, selection, IME, copy/paste,
 * select-all, Backspace/Delete and Enter-for-newline.
 *
 * While editing, the canvas copy of the layer is hidden (the parent passes an
 * opacity-0 override) so there's never a double image. Nothing is committed
 * per keystroke: the whole session is ONE undo step, committed on Esc,
 * ⌘/Ctrl+Enter, or blur (click elsewhere).
 */
export interface TextEditOverlayProps {
  /** The layer as laid out for `text` (re-resolved by the parent as the text changes). */
  layoutFor: (text: string) => ResolvedLayer | null;
  initialText: string;
  viewport: ViewportState;
  accent: string;
  onCommit: (text: string) => void;
}

function cssColorWithAlpha(color: string, alpha: number): string {
  return alpha >= 1 ? color : `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

export default function TextEditOverlay({ layoutFor, initialText, viewport, accent, onCommit }: TextEditOverlayProps) {
  const [text, setText] = useState(initialText);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const layer = layoutFor(text) ?? layoutFor(" ");

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(taRef.current?.value ?? text);
  };

  // Focus + select everything on entry, so typing immediately replaces placeholder text ("Type something...").
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.select();
  }, []);

  // Auto-grow: never let the textarea clip a line the DOM wrapped slightly differently from canvas layout.
  const [extraHeight, setExtraHeight] = useState(0);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || !layer || layer.content.type !== "text") return;
    const want = ta.scrollHeight - ta.clientHeight;
    if (want > 0) setExtraHeight((h) => h + want);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!layer || layer.content.type !== "text") return null;
  const { layout, style } = layer.content;
  const m = multiply(multiply(translate(viewport.panX, viewport.panY), scale(viewport.zoom)), layer.matrix);
  const textHeight = layout.lines.length * layout.lineHeightPx;
  const pointNoWrap = style.sizing === "point" && style.maxWidth === undefined;
  const shadow = style.shadow ? `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur / 2}px ${style.shadowColor}` : "none";

  return (
    <div
      data-testid="text-edit-overlay"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: layout.width,
        height: Math.max(layout.height, layout.contentTop + textHeight + extraHeight + style.padding),
        transformOrigin: "0 0",
        transform: `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`,
        opacity: layer.opacity,
        background: style.background ? cssColorWithAlpha(style.backgroundColor, style.backgroundOpacity) : "transparent",
        borderRadius: style.borderRadius,
        // Edit-mode affordance: dashed accent frame, distinct from object-selection's solid handles. Width compensates for the transform scale so it stays ~1.5 screen px.
        outline: `${1.5 / Math.max(0.01, viewport.zoom * Math.hypot(layer.matrix.a, layer.matrix.b))}px dashed ${accent}`,
        zIndex: 5,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: -24 / Math.max(0.01, viewport.zoom * Math.hypot(layer.matrix.a, layer.matrix.b)),
          left: 0,
          fontSize: 11 / Math.max(0.01, viewport.zoom * Math.hypot(layer.matrix.a, layer.matrix.b)),
          fontFamily: "system-ui, sans-serif",
          fontWeight: 500,
          lineHeight: 1.8,
          whiteSpace: "nowrap",
          color: "#fff",
          background: accent,
          padding: "0 0.4em",
          borderRadius: 4,
          pointerEvents: "none",
        }}
      >
        Editing text — Esc or click outside to finish
      </span>
      <textarea
        ref={taRef}
        aria-label="Edit text"
        value={text}
        wrap={pointNoWrap ? "off" : "soft"}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Keys belong to the text while editing — never let them reach the canvas (nudge/flip/delete) or app shortcuts.
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            commit();
          }
        }}
        style={{
          position: "absolute",
          left: style.padding,
          top: layout.contentTop,
          // Point text grows with its content; give the caret one em of room so typing doesn't wrap mid-word before the canvas re-lays out.
          width: pointNoWrap ? layout.contentWidth + style.fontSize : Math.max(layout.contentWidth, 1) + 1,
          height: textHeight + extraHeight,
          margin: 0,
          padding: 0,
          border: 0,
          outline: "none",
          resize: "none",
          overflow: "hidden",
          background: "transparent",
          font: cssFontString(style),
          lineHeight: `${layout.lineHeightPx}px`,
          letterSpacing: `${style.letterSpacing}px`,
          textAlign: style.textAlign,
          textAlignLast: style.textAlign === "justify" ? "left" : undefined,
          whiteSpace: pointNoWrap ? "pre" : "pre-wrap",
          overflowWrap: "anywhere",
          color: style.color,
          caretColor: accent,
          WebkitTextStroke: style.stroke && style.strokeWidth > 0 ? `${style.strokeWidth * 2}px ${style.strokeColor}` : undefined,
          paintOrder: "stroke fill",
          textShadow: shadow,
        }}
      />
    </div>
  );
}
