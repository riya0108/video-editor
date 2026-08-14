import { getTextFont } from "../../../lib/ffmpeg/fonts";
import type { CaptionStylePreset } from "../../../lib/captions/caption-styles";

const SAMPLE_WORDS = ["Just", "like", "this"];

/** A small mock preview card for a caption style — a stand-in "video" (gradient + a soft person silhouette) with sample text rendered in the real style, so users can see the look before applying it. */
export default function CaptionStylePreview({
  preset,
  active,
  onClick,
}: {
  preset: CaptionStylePreset;
  active: boolean;
  onClick: () => void;
}) {
  const { style } = preset;
  const font = getTextFont(style.fontId);
  const words = style.uppercase ? SAMPLE_WORDS.map((w) => w.toUpperCase()) : SAMPLE_WORDS;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group flex w-full flex-col overflow-hidden rounded-lg border-2 text-left transition-colors ${
        active ? "border-primary-500" : "border-(--color-border) hover:border-(--color-border-strong)"
      }`}
    >
      <div
        className="relative aspect-video w-full overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 50% 115%, var(--color-neutral-400), var(--color-neutral-700) 55%, var(--color-neutral-900) 100%)",
        }}
      >
        {style.occludeByPerson && (
          <div
            className="absolute inset-x-[38%] bottom-0 h-4/5 rounded-t-full bg-(--color-neutral-300)/80 dark:bg-(--color-neutral-200)/70"
            aria-hidden="true"
          />
        )}
        <span
          className="absolute max-w-[92%] -translate-x-1/2 -translate-y-1/2 whitespace-normal break-words text-center leading-tight font-semibold"
          style={{
            left: `${style.x}%`,
            top: `${style.y}%`,
            fontFamily: font.cssFontFamily,
            color: style.color,
            fontSize: 13,
            padding: style.background ? "3px 6px" : 0,
            backgroundColor: style.background ? style.backgroundColor : "transparent",
            WebkitTextStroke: style.outline ? `1.25px ${style.outlineColor}` : undefined,
            paintOrder: style.outline ? "stroke fill" : undefined,
            opacity: style.fade ? 0.5 : 1,
          }}
        >
          {words.map((w, i) => (
            <span key={i} style={{ color: style.karaoke && i === 1 ? style.highlightColor : undefined }}>
              {w}
              {i < words.length - 1 ? " " : ""}
            </span>
          ))}
        </span>
      </div>
      <span className="truncate border-t border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption font-medium">
        {preset.label}
      </span>
    </button>
  );
}
