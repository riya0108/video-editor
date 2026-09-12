import { TEXT_FONTS } from "../../../../lib/ffmpeg/fonts";
import { TEXT_COLORS } from "../../../../lib/ffmpeg/text-colors";

export const MAX_TEXT_SIZE = 400;

/**
 * A quick-access style bar that floats over the preview near the selected
 * text/caption block — mirrors the full font/size/color controls already in
 * the flyout panel, for making a fast tweak without leaving the preview.
 * Rendered as one more overlay child inside FramedVideoStage's `children`
 * render-prop, alongside RectOverlay/PickColorOverlay.
 *
 * Docks near whichever edge the text block ISN'T close to (based on its
 * current y%), so it doesn't sit on top of the text it's editing.
 */
export default function FloatingTextToolbar({
  y,
  fontId,
  fontSize,
  color,
  onChange,
}: {
  /** The text block's current vertical anchor, 0-100% of the frame. */
  y: number;
  fontId: string;
  fontSize: number;
  color: string;
  onChange: (patch: { fontId?: string; fontSize?: number; color?: string }) => void;
}) {
  const dockClass = y > 50 ? "top-2" : "bottom-2";

  return (
    <div
      className={`pointer-events-auto absolute left-1/2 z-20 flex max-w-[92vw] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full border border-(--color-border) bg-(--color-surface) px-2 py-1.5 shadow-md ${dockClass}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 border-r border-(--color-border) pr-1.5">
        {TEXT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Text color ${c}`}
            onClick={() => onChange({ color: c })}
            className={`h-5 w-5 rounded-full border-2 ${color === c ? "border-primary-500" : "border-(--color-border)"}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => onChange({ color: e.target.value })}
          className="h-5 w-5 cursor-pointer rounded-full border border-(--color-border) bg-transparent"
          aria-label="Custom text color"
        />
      </div>

      <select
        value={fontId}
        onChange={(e) => onChange({ fontId: e.target.value })}
        className="rounded-md border-none bg-transparent py-1 pl-1 pr-5 text-caption font-medium outline-none"
        aria-label="Font"
      >
        {TEXT_FONTS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1 border-l border-(--color-border) pl-1.5">
        <button
          type="button"
          aria-label="Decrease text size"
          onClick={() => onChange({ fontSize: Math.max(12, fontSize - 4) })}
          className="grid h-6 w-6 place-items-center rounded-full text-body-sm font-semibold hover:bg-(--color-bg-subtle)"
        >
          −
        </button>
        <span className="w-8 text-center text-caption tabular-nums text-(--color-text-muted)">{fontSize}</span>
        <button
          type="button"
          aria-label="Increase text size"
          onClick={() => onChange({ fontSize: Math.min(MAX_TEXT_SIZE, fontSize + 4) })}
          className="grid h-6 w-6 place-items-center rounded-full text-body-sm font-semibold hover:bg-(--color-bg-subtle)"
        >
          +
        </button>
      </div>
    </div>
  );
}
