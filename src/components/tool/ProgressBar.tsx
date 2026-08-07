export default function ProgressBar({
  label,
  fraction,
}: {
  label: string;
  /** 0–1 */
  fraction: number;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-body-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-(--color-text-muted)">{pct}%</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-(--color-bg-subtle)">
        <div
          className="h-full rounded-full bg-primary-500 transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
