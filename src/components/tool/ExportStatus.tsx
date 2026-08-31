import ProgressBar from "./ProgressBar";

export default function ExportStatus({
  enginePhase,
  engineFraction,
  runFraction,
  error,
  runLabel,
  engineLabel = "Loading editor engine…",
  etaLabel,
  tip,
}: {
  enginePhase: "engine" | "run" | null;
  engineFraction: number;
  runFraction: number;
  error: string | null;
  runLabel: string;
  engineLabel?: string;
  /** Optional "~2m 30s remaining" estimate for the run phase, shown next to its label. */
  etaLabel?: string | null;
  /** Optional friendly note shown while the run phase is in progress — e.g. "safe to switch tabs, this keeps working in the background." */
  tip?: string;
}) {
  if (!enginePhase && !error) return null;

  return (
    <div className="mt-5">
      {enginePhase && (
        <ProgressBar
          label={
            enginePhase === "run" && etaLabel ? `${runLabel} — about ${etaLabel} left` : enginePhase === "engine" ? engineLabel : runLabel
          }
          fraction={enginePhase === "engine" ? engineFraction : runFraction}
        />
      )}
      {enginePhase === "run" && tip && <p className="mt-3 text-caption text-(--color-text-muted)">{tip}</p>}
      {error && <p className="mt-3 text-body-sm text-danger-600">{error}</p>}
    </div>
  );
}
