import { useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

/**
 * A labeled, collapsible group for a single-purpose tool's controls — the
 * left-column building block for the split editing layout. Unlike
 * EditorSection (checkbox-toggled optional features in the full Video
 * Editor), a tool's own sections aren't independently enable/disable-able,
 * so this just expands and collapses for organization.
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
    <div className="rounded-lg border border-(--color-border) p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left font-semibold"
      >
        <Icon size={16} />
        {label}
        <ChevronDown size={16} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}
