const BAR_COUNT = 24;

export default function LevelMeter({ level }: { level: number }) {
  const activeBars = Math.round(level * BAR_COUNT);

  return (
    <div className="flex h-10 items-center gap-1" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const active = i < activeBars;
        const isHot = i >= BAR_COUNT - 4;
        return (
          <span
            key={i}
            className={`w-1.5 flex-1 rounded-full transition-colors ${
              !active
                ? "bg-(--color-bg-subtle)"
                : isHot
                  ? "bg-danger-500"
                  : "bg-primary-500"
            }`}
            style={{ height: `${30 + (i / BAR_COUNT) * 70}%` }}
          />
        );
      })}
    </div>
  );
}
