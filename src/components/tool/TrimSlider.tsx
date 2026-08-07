import { useEffect, useRef, useState } from "react";
import { clamp } from "../../lib/time";

type Handle = "start" | "end" | null;

export default function TrimSlider({
  duration,
  start,
  end,
  currentTime,
  onChangeStart,
  onChangeEnd,
  onSeek,
}: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  onChangeStart: (t: number) => void;
  onChangeEnd: (t: number) => void;
  onSeek: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle>(null);

  // Keep latest props/state in refs so the window-level listeners (registered
  // once) never operate on stale values from the render they were added in.
  const latest = useRef({ duration, start, end, dragging, onChangeStart, onChangeEnd });
  latest.current = { duration, start, end, dragging, onChangeStart, onChangeEnd };

  useEffect(() => {
    const timeAtClientX = (clientX: number) => {
      const track = trackRef.current;
      const { duration } = latest.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
      return fraction * duration;
    };

    const handleMove = (e: PointerEvent) => {
      const { dragging, start, end, duration, onChangeStart, onChangeEnd } = latest.current;
      if (!dragging) return;
      const t = timeAtClientX(e.clientX);
      if (dragging === "start") {
        onChangeStart(clamp(t, 0, end - 0.05));
      } else {
        onChangeEnd(clamp(t, start + 0.05, duration));
      }
    };

    const handleUp = () => setDragging(null);

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  const timeAtClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    return fraction * duration;
  };

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <div className="select-none py-3">
      <div
        ref={trackRef}
        className="relative h-3 w-full cursor-pointer rounded-full bg-(--color-bg-subtle)"
        onClick={(e) => {
          if (dragging) return;
          onSeek(timeAtClientX(e.clientX));
        }}
      >
        <div
          className="absolute inset-y-0 rounded-full bg-primary-200 dark:bg-primary-900"
          style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
        />
        <div
          className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-neutral-900/70 dark:bg-white/70"
          style={{ left: `${pct(currentTime)}%` }}
          aria-hidden="true"
        />

        <button
          type="button"
          aria-label="Trim start"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging("start");
          }}
          className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary-500 shadow-sm ring-2 ring-white dark:ring-neutral-900"
          style={{ left: `${pct(start)}%` }}
        />
        <button
          type="button"
          aria-label="Trim end"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragging("end");
          }}
          className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary-500 shadow-sm ring-2 ring-white dark:ring-neutral-900"
          style={{ left: `${pct(end)}%` }}
        />
      </div>
    </div>
  );
}
