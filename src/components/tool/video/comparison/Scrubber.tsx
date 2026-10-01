/**
 * MATTE COMPARISON VIEWER. A deliberately lightweight timeline — NOT a
 * reuse of the main editor's `EditorTimeline.tsx`, which is a heavyweight
 * multi-lane drag/resize/split component built for a different job
 * (arranging multiple clips/segments). This tool only ever shows one clip
 * and needs to scrub + show where the batch-sampled frames landed, so a
 * plain range input plus tick marks is enough.
 */
export default function Scrubber({
  min,
  max,
  value,
  onChange,
  sampleTimes,
  disabled = false,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (time: number) => void;
  /** Timestamps (seconds) of the batch-sampled AI-matte frames, shown as tick marks so it's visible which parts of the scrub range have a computed matte vs. are held from a nearby sample. */
  sampleTimes: number[];
  disabled?: boolean;
}) {
  const span = Math.max(1e-6, max - min);
  return (
    <div className="relative w-full py-3">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2">
        {sampleTimes.map((t, i) => (
          <span
            key={i}
            className="absolute top-0 h-1 w-px bg-primary-500/70"
            style={{ left: `${Math.min(100, Math.max(0, ((t - min) / span) * 100))}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.001}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="relative z-10 w-full accent-primary-500 disabled:opacity-50"
      />
    </div>
  );
}
