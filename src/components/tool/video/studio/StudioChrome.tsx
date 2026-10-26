import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * STUDIO CHROME — the editor shell's building blocks: the left tool rail, the slide-out library drawer, the
 * inspector's tabs, modal dialogs and the toast stack. Presentation only; the editor owns all state.
 */

/** Panels from the composition engine render as bordered cards; inside the shell's drawers they sit flat. */
export const FLAT_PANELS = "[&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent [&>section]:shadow-none";

export function RailButton({ icon: Icon, label, active, onClick, badge }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void; badge?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`group relative flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium transition-colors ${
        active ? "bg-primary-500/15 text-primary-600 dark:text-primary-300" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
      }`}
    >
      {active && <span className="absolute top-2 bottom-2 -left-2 w-0.5 rounded-full bg-primary-500" aria-hidden="true" />}
      <Icon className="h-5 w-5 transition-transform group-hover:scale-110" strokeWidth={1.75} />
      <span className="leading-tight">{label}</span>
      {badge && <span className="absolute top-1.5 right-3 h-1.5 w-1.5 rounded-full bg-accent-400" aria-hidden="true" />}
    </button>
  );
}

export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface) animate-fade-in" aria-label={title} data-testid="studio-drawer">
      <header className="flex items-start justify-between gap-2 px-4 pt-4 pb-3">
        <div>
          <h2 className="text-body font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-caption text-(--color-text-muted)">{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)" aria-label="Close panel">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className={`studio-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4 ${FLAT_PANELS}`}>{children}</div>
    </aside>
  );
}

export interface InspectorTab {
  id: string;
  label: string;
}

export function Tabs({ tabs, active, onChange }: { tabs: InspectorTab[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-(--color-bg-subtle) p-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          onClick={() => onChange(t.id)}
          className={`flex-1 rounded-md px-2 py-1 text-caption font-medium transition-colors ${
            t.id === active ? "bg-(--color-surface-raised) text-(--color-text) shadow-sm" : "text-(--color-text-muted) hover:text-(--color-text)"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A centered dialog. `keepMounted` hides instead of unmounting, so work running inside it (an export) carries on
 * while it's closed.
 */
export function Modal({ open, title, onClose, children, wide, keepMounted, testId }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean; keepMounted?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open && !keepMounted) return null;
  return (
    <div className={`fixed inset-0 z-50 items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm sm:pt-[8vh] ${open ? "flex" : "hidden"}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testId}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-lg outline-none animate-fade-in`}
      >
        <header className="flex items-center justify-between border-b border-(--color-border) px-5 py-3.5">
          <h2 className="text-body font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export interface Toast {
  id: number;
  kind: "info" | "warning" | "error";
  text: ReactNode;
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-xl items-start gap-3 rounded-xl border px-4 py-2.5 text-caption shadow-lg backdrop-blur-md animate-fade-in ${
            t.kind === "error"
              ? "border-danger-500/40 bg-danger-500/15 text-(--color-text)"
              : t.kind === "warning"
                ? "border-warning-500/40 bg-warning-500/15 text-(--color-text)"
                : "border-(--color-border) bg-(--color-surface-raised)/95 text-(--color-text)"
          }`}
        >
          <div className="flex-1">{t.text}</div>
          <button type="button" onClick={() => onDismiss(t.id)} className="-mr-1 rounded p-0.5 text-(--color-text-muted) hover:text-(--color-text)" aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-(--color-border-strong) bg-(--color-bg-subtle) px-1.5 py-0.5 font-mono text-[11px] text-(--color-text-muted)">{children}</kbd>;
}

export const SHORTCUTS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["← / →", "Previous / next frame (hold ⇧ for 1 second)"],
  ["S", "Split at the playhead (timeline focused)"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
  ["⌘S / ⇧⌘S", "Save / save as"],
  ["⌘D", "Duplicate selected layers"],
  ["Delete", "Delete selected layers"],
  ["C", "Toggle crop handles"],
  ["⌘E", "Export"],
  ["?", "Show this list"],
];
