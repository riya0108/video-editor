import type { LucideIcon } from "lucide-react";

/** One icon-rail entry in the editor shell — icon + label, active (panel open) and enabled (feature applies at export) states shown distinctly. */
export default function EditorRailButton({
  icon: Icon,
  label,
  active,
  enabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  enabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex w-full shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-3 text-center transition-colors md:px-1.5 ${
        active
          ? "bg-primary-500 text-white shadow-sm"
          : "text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
      }`}
      style={{ minWidth: 64 }}
    >
      <Icon size={19} />
      <span className="text-[10px] leading-tight font-medium">{label}</span>
      {enabled && !active && (
        <span
          className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
