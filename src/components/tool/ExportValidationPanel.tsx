import { useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert, X } from "lucide-react";
import type { ExportValidationReport } from "../../lib/media/export-validation";

/**
 * PHASE 13 — TRANSPARENT EXPORT. Shows the automatic post-export
 * verification pass (file exists/readable, resolution, frame rate, alpha
 * presence + real transparency, no flatten-to-black) run right after every
 * transparent export — see src/lib/media/export-validation.ts. Collapsed to
 * a one-line summary by default; only opens automatically when something
 * actually failed, since a clean pass isn't something the user needs to
 * read through on every export.
 */
export default function ExportValidationPanel({
  report,
  isValidating,
}: {
  report: ExportValidationReport | null;
  isValidating: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (isValidating) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) px-4 py-3 text-body-sm text-(--color-text-muted)">
        <Loader2 size={15} className="animate-spin" />
        Verifying export…
      </div>
    );
  }

  if (!report) return null;

  const isOpen = open || !report.passed;
  const visibleChecks = report.checks.filter((c) => !c.skipped);
  const passedCount = visibleChecks.filter((c) => c.passed).length;

  return (
    <div
      className={`mb-3 overflow-hidden rounded-lg border text-body-sm ${
        report.passed ? "border-(--color-border) bg-(--color-bg-subtle)" : "border-danger-500/40 bg-danger-500/10"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left font-medium"
      >
        <span className={`flex items-center gap-2 ${report.passed ? "text-(--color-text)" : "text-danger-600"}`}>
          {report.passed ? <Check size={15} className="text-success-600" /> : <TriangleAlert size={15} />}
          {report.passed ? `Export verified (${passedCount}/${visibleChecks.length} checks)` : "Export validation found a problem"}
        </span>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && (
        <ul className="space-y-1.5 border-t border-(--color-border) px-4 py-3">
          {report.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2">
              {check.skipped ? (
                <span className="mt-0.5 h-[15px] w-[15px] shrink-0 rounded-full border border-(--color-border)" />
              ) : check.passed ? (
                <Check size={15} className="mt-0.5 shrink-0 text-success-600" />
              ) : (
                <X size={15} className="mt-0.5 shrink-0 text-danger-600" />
              )}
              <span className={check.skipped ? "text-(--color-text-muted)" : undefined}>
                {check.label}
                {check.detail && <span className="block text-caption text-(--color-text-muted)">{check.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
