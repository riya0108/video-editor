import type { CaptionStylePreset } from "../../../lib/captions/caption-styles";
import type { CaptionCue } from "../../../lib/captions/types";
import CaptionOverlay from "./editor/CaptionOverlay";

const SAMPLE_CUE: CaptionCue = {
  id: "sample",
  start: 0,
  end: 3,
  text: "Just like this",
  words: [
    { text: "Just", start: 0, end: 1 },
    { text: "like", start: 1, end: 2 },
    { text: "this", start: 2, end: 3 },
  ],
};

/** A small mock preview card for a caption style — a stand-in "video" (gradient + a soft person silhouette) with sample text rendered in the real style (via the same CaptionOverlay used in the live editors), so users can see the look before applying it. */
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
        <div
          className="absolute max-w-[92%] -translate-x-1/2 -translate-y-1/2 text-center"
          style={{ left: `${style.x}%`, top: `${style.y}%` }}
        >
          <CaptionOverlay style={style} cue={SAMPLE_CUE} currentTime={1.1} scale={0.36} />
        </div>
      </div>
      <span className="truncate border-t border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption font-medium">
        {preset.label}
      </span>
    </button>
  );
}
