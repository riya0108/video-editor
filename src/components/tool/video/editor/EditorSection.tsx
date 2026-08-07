import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A checkbox-toggled, collapsible section — the repeated shell for every editor panel. */
export default function EditorSection({
  icon: Icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  label: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-(--color-primary-500)"
        />
        <Icon size={16} />
        {label}
      </label>
      {enabled && children && <div className="mt-4">{children}</div>}
    </div>
  );
}
