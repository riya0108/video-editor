import { Maximize } from "lucide-react";
import ToolPanelSection from "../ToolPanelSection";
import PanelHeader from "./editor/PanelHeader";
import { SOCIAL_PRESET_GROUPS } from "../../../lib/social-presets";
import { resolveBackgroundSize, type ResizeCanvasSettings } from "../../../lib/ffmpeg/resize-canvas-filter";
import type { BgFillMode, GradientDirection } from "../../../lib/ffmpeg/editor-state";

const FILL_MODES: { id: BgFillMode; label: string }[] = [
  { id: "blur", label: "Blur" },
  { id: "solid", label: "Solid" },
  { id: "gradient", label: "Gradient" },
];

/**
 * The full Video Editor's "Resize for a platform" panel, lifted out so every
 * single-purpose tool can offer the same reframe-and-fill behavior without
 * its own undo/redo document — just a plain `value`/`onChange` pair over
 * `ResizeCanvasSettings`, the same shape `applyResizeCanvas` consumes.
 */
export default function ResizeForPlatformSection({
  value,
  onChange,
}: {
  value: ResizeCanvasSettings;
  onChange: (updater: (s: ResizeCanvasSettings) => ResizeCanvasSettings) => void;
}) {
  const resolvedSize = resolveBackgroundSize(value);

  return (
    <ToolPanelSection icon={Maximize} label="Resize for a platform" defaultOpen={false}>
      <PanelHeader
        label="Resize for a platform"
        description="Fits your video onto a preset (or custom) canvas and fills the empty space."
        enabled={value.enabled}
        onToggle={(enabled) => onChange((s) => ({ ...s, enabled }))}
      />
      {value.enabled && (
        <div className="space-y-4">
          {SOCIAL_PRESET_GROUPS.map((group) => (
            <div key={group.platform}>
              <p className="mb-1.5 text-caption font-semibold text-(--color-text-muted)">{group.platform}</p>
              <div className="flex flex-wrap gap-1.5">
                {group.presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onChange((s) => ({ ...s, presetId: p.id }))}
                    className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                      value.presetId === p.id
                        ? "border-primary-500 bg-primary-500 text-white"
                        : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div>
            <button
              type="button"
              onClick={() => onChange((s) => ({ ...s, presetId: "custom" }))}
              className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                value.presetId === "custom"
                  ? "border-primary-500 bg-primary-500 text-white"
                  : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
              }`}
            >
              Custom size
            </button>
            {value.presetId === "custom" && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={2}
                  value={value.customWidth}
                  onChange={(e) => onChange((s) => ({ ...s, customWidth: Number(e.target.value) || s.customWidth }))}
                  className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                />
                <span className="text-(--color-text-faint)">&times;</span>
                <input
                  type="number"
                  min={2}
                  value={value.customHeight}
                  onChange={(e) => onChange((s) => ({ ...s, customHeight: Number(e.target.value) || s.customHeight }))}
                  className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                />
              </div>
            )}
            <p className="mt-1.5 text-caption text-(--color-text-faint)">
              Output: {resolvedSize.w}×{resolvedSize.h}
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-caption font-semibold text-(--color-text-muted)">Fill style</p>
            <div className="flex gap-1 rounded-md border border-(--color-border) p-1">
              {FILL_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange((s) => ({ ...s, fillMode: m.id }))}
                  className={`flex-1 rounded px-2 py-1.5 text-caption font-medium transition-colors ${
                    value.fillMode === m.id ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {value.fillMode === "solid" && (
            <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
              Color
              <input
                type="color"
                value={value.solidColor}
                onChange={(e) => onChange((s) => ({ ...s, solidColor: e.target.value }))}
                className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
              />
            </label>
          )}

          {value.fillMode === "gradient" && (
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                From
                <input
                  type="color"
                  value={value.gradientFrom}
                  onChange={(e) => onChange((s) => ({ ...s, gradientFrom: e.target.value }))}
                  className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
                />
              </label>
              <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                To
                <input
                  type="color"
                  value={value.gradientTo}
                  onChange={(e) => onChange((s) => ({ ...s, gradientTo: e.target.value }))}
                  className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
                />
              </label>
              <select
                value={value.gradientDirection}
                onChange={(e) => onChange((s) => ({ ...s, gradientDirection: e.target.value as GradientDirection }))}
                className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
              >
                <option value="vertical">Vertical</option>
                <option value="horizontal">Horizontal</option>
                <option value="diagonal">Diagonal</option>
              </select>
            </div>
          )}
        </div>
      )}
    </ToolPanelSection>
  );
}
