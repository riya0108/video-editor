import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

/**
 * A labeled, collapsible group for a single-purpose tool's controls — the
 * left-column building block for the split editing layout. Unlike the full
 * Video Editor's PanelHeader (checkbox-toggled optional features), a tool's
 * own sections aren't independently enable/disable-able, so this just
 * expands and collapses for organization.
 */
export default function ToolPanelSection({
  icon: Icon,
  label,
  defaultOpen = true,
  children,
}: {
  icon: LucideIcon;
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left font-semibold"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
          <Icon size={15} />
        </span>
        {label}
        <ChevronDown size={16} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}
