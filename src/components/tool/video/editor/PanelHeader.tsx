import type { ReactNode } from "react";

/** Shared header for a rail flyout panel: title + optional description, and an on/off switch that controls whether the feature applies at export (independent of whether its panel happens to be open). */
export default function PanelHeader({
  label,
  description,
  enabled,
  onToggle,
}: {
  label: string;
  description?: ReactNode;
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 border-b border-(--color-border) pb-3">
      <div>
        <h3 className="font-semibold">{label}</h3>
        {description && <p className="mt-0.5 text-caption text-(--color-text-muted)">{description}</p>}
      </div>
      {onToggle && (
        <button
          type="button"
          role="switch"
          aria-checked={!!enabled}
          aria-label={`Enable ${label}`}
          onClick={() => onToggle(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-primary-500" : "bg-(--color-bg-subtle)"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      )}
    </div>
  );
}
