import type { ReactNode } from "react";

/**
 * Shared two-column shell for single-video tools: a sticky, scrollable
 * column of controls on the left, and the live preview pinned on the right.
 * Mirrors the layout the full Video Editor already uses.
 */
export default function ToolSplitLayout({ controls, preview }: { controls: ReactNode; preview: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[420px_1fr] lg:items-start">
      <div className="space-y-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
        {controls}
      </div>
      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-4 shadow-sm">{preview}</div>
    </div>
  );
}
