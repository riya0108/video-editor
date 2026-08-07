import { Circle, Pause, Play, Square } from "lucide-react";
import type { RecorderState } from "../../../lib/hooks/useMediaRecorder";
import { formatTime } from "../../../lib/time";

export default function RecorderControls({
  state,
  elapsedMs,
  onStart,
  onPause,
  onResume,
  onStop,
  startLabel = "Start recording",
  disabled = false,
}: {
  state: RecorderState;
  elapsedMs: number;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  startLabel?: string;
  disabled?: boolean;
}) {
  if (state === "idle") {
    return (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onStart}
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-full bg-danger-500 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-danger-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Circle size={16} fill="currentColor" />
          {startLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-5">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full bg-danger-500 ${state === "recording" ? "animate-pulse-record" : ""}`}
        />
        <span className="text-h3 font-bold tabular-nums">{formatTime(elapsedMs / 1000)}</span>
      </div>

      {state === "recording" ? (
        <button
          type="button"
          onClick={onPause}
          className="grid h-11 w-11 place-items-center rounded-full border border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
          aria-label="Pause"
        >
          <Pause size={18} />
        </button>
      ) : (
        <button
          type="button"
          onClick={onResume}
          className="grid h-11 w-11 place-items-center rounded-full border border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
          aria-label="Resume"
        >
          <Play size={18} className="ml-0.5" />
        </button>
      )}

      <button
        type="button"
        onClick={onStop}
        className="grid h-11 w-11 place-items-center rounded-full bg-danger-500 text-white hover:bg-danger-600"
        aria-label="Stop"
      >
        <Square size={16} fill="currentColor" />
      </button>
    </div>
  );
}
