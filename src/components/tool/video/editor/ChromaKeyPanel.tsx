import { Pipette } from "lucide-react";
import type { EditorChromaKeyState } from "../../../../lib/ffmpeg/editor-state";

const PRESET_COLORS = ["#00ff00", "#00b140", "#0047ff", "#ffffff", "#000000"];

export default function ChromaKeyPanel({
  state,
  onChange,
  picking,
  onTogglePicking,
}: {
  state: EditorChromaKeyState;
  onChange: (patch: Partial<EditorChromaKeyState>) => void;
  picking: boolean;
  onTogglePicking: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-caption text-(--color-text-muted)">Key color</span>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Use ${c}`}
            onClick={() => onChange({ colorHex: c })}
            className={`h-6 w-6 rounded-full border-2 ${state.colorHex === c ? "border-primary-500" : "border-(--color-border)"}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          value={state.colorHex}
          onChange={(e) => onChange({ colorHex: e.target.value })}
          className="h-6 w-6 cursor-pointer rounded border border-(--color-border) bg-transparent"
          aria-label="Custom key color"
        />
        <button
          type="button"
          onClick={onTogglePicking}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-caption font-medium transition-colors ${
            picking
              ? "border-primary-500 bg-primary-500 text-white"
              : "border-(--color-border) hover:border-(--color-border-strong)"
          }`}
        >
          <Pipette size={13} />
          {picking ? "Click the video…" : "Pick from video"}
        </button>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
          Similarity
          <input
            type="range"
            min={0.05}
            max={0.6}
            step={0.01}
            value={state.similarity}
            onChange={(e) => onChange({ similarity: Number(e.target.value) })}
            className="w-28 accent-(--color-primary-500)"
          />
        </label>
        <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
          Softness
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={state.blend}
            onChange={(e) => onChange({ blend: Number(e.target.value) })}
            className="w-28 accent-(--color-primary-500)"
          />
        </label>
      </div>

      <div>
        <p className="text-caption text-(--color-text-muted)">Replace with</p>
        <div className="mt-1.5 flex items-center gap-1 rounded-md border border-(--color-border) p-1">
          {(["transparent", "color", "image", "video"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ replace: mode })}
              className={`flex-1 rounded px-3 py-1.5 text-caption font-medium capitalize transition-colors ${
                state.replace === mode
                  ? "bg-primary-500 text-white"
                  : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        {state.replace === "transparent" && (
          <p className="mt-2 text-caption text-(--color-text-muted)">
            Exports a .mov with a real alpha channel instead of compositing onto anything — drop it into Premiere
            Pro, DaVinci Resolve, Final Cut Pro, or iMovie. Most browsers can't preview transparent video inline. Not
            available together with "Resize for a platform" or an intro/outro clip, since both need an opaque frame
            to composite onto — enable either of those and this falls back to a black backdrop instead.
          </p>
        )}
        {state.replace === "color" && (
          <input
            type="color"
            value={state.replaceColorHex}
            onChange={(e) => onChange({ replaceColorHex: e.target.value })}
            className="mt-2 h-8 w-16 cursor-pointer rounded border border-(--color-border) bg-transparent"
            aria-label="Replacement color"
          />
        )}
        {state.replace === "image" && (
          <label className="mt-2 inline-flex cursor-pointer items-center rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
            {state.replaceImageFile ? state.replaceImageFile.name : "Choose background image"}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => onChange({ replaceImageFile: e.target.files?.[0] ?? null })}
            />
          </label>
        )}
        {state.replace === "video" && (
          <label className="mt-2 inline-flex cursor-pointer items-center rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
            {state.replaceVideoFile ? state.replaceVideoFile.name : "Choose background video"}
            <input
              type="file"
              accept="video/*"
              className="sr-only"
              onChange={(e) => onChange({ replaceVideoFile: e.target.files?.[0] ?? null })}
            />
          </label>
        )}
      </div>
    </div>
  );
}
