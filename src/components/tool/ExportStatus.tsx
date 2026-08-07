import ProgressBar from "./ProgressBar";

export default function ExportStatus({
  enginePhase,
  engineFraction,
  runFraction,
  error,
  runLabel,
}: {
  enginePhase: "engine" | "run" | null;
  engineFraction: number;
  runFraction: number;
  error: string | null;
  runLabel: string;
}) {
  if (!enginePhase && !error) return null;

  return (
    <div className="mt-5">
      {enginePhase && (
        <ProgressBar
          label={enginePhase === "engine" ? "Loading editor engine…" : runLabel}
          fraction={enginePhase === "engine" ? engineFraction : runFraction}
        />
      )}
      {error && <p className="mt-3 text-body-sm text-danger-600">{error}</p>}
    </div>
  );
}
