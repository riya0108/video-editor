import { useCallback, useRef, useState } from "react";

export interface HistoryEntry<T> {
  state: T;
  /** Short label for the version-history list, e.g. "Crop", "Add text". */
  label: string;
  at: number;
}

export interface UseHistoryStateResult<T> {
  state: T;
  /** Updates state and records a new history checkpoint (unless `silent`). */
  set: (updater: T | ((prev: T) => T), label?: string, opts?: { silent?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Every checkpoint from the start of the session (oldest first), for a "restore to version" list. */
  timeline: HistoryEntry<T>[];
  /** Index of the current state within `timeline`. */
  cursor: number;
  /** Jumps straight to a specific point in `timeline` (past or future). */
  restoreTo: (index: number) => void;
  replaceInitial: (state: T) => void;
}

const MAX_HISTORY = 200;
// Rapid-fire updates (dragging a slider, typing) collapse into one
// checkpoint instead of one per pixel/keystroke — still gives a "version per
// distinct edit" history without spamming it.
const COALESCE_WINDOW_MS = 500;

/**
 * Generic undo/redo + full-session version history for a plain, structurally
 * cloneable state object. Every `set()` call is a checkpoint (coalesced with
 * the immediately-preceding one if it happened within COALESCE_WINDOW_MS and
 * carries the same label), so `timeline` doubles as a "restore to any
 * earlier point since you opened this editor" list.
 *
 * `timeline`/`cursor` are always updated together from a ref-backed snapshot
 * rather than via nested setState-inside-setState-updater calls — the latter
 * is unsafe in React (updater functions can be invoked more than once, e.g.
 * under StrictMode) and let the two go out of sync, crashing on
 * `timeline[cursor]` being undefined.
 */
export function useHistoryState<T>(initial: T): UseHistoryStateResult<T> {
  const [timeline, setTimelineState] = useState<HistoryEntry<T>[]>([
    { state: initial, label: "Start", at: Date.now() },
  ]);
  const [cursor, setCursorState] = useState(0);
  const snapshot = useRef({ timeline, cursor });
  snapshot.current = { timeline, cursor };
  const lastCommitRef = useRef<{ at: number; label: string }>({ at: 0, label: "" });

  const apply = useCallback((nextTimeline: HistoryEntry<T>[], nextCursor: number) => {
    snapshot.current = { timeline: nextTimeline, cursor: nextCursor };
    setTimelineState(nextTimeline);
    setCursorState(nextCursor);
  }, []);

  const set = useCallback(
    (updater: T | ((prev: T) => T), label = "Edit", opts?: { silent?: boolean }) => {
      const { timeline: prevTimeline, cursor: prevCursor } = snapshot.current;
      const prevState = prevTimeline[prevCursor].state;
      const next = typeof updater === "function" ? (updater as (p: T) => T)(prevState) : updater;
      if (next === prevState) return;

      const now = Date.now();
      const coalesce =
        !opts?.silent &&
        prevCursor === prevTimeline.length - 1 &&
        lastCommitRef.current.label === label &&
        now - lastCommitRef.current.at < COALESCE_WINDOW_MS;
      lastCommitRef.current = { at: now, label };

      const truncated = prevTimeline.slice(0, prevCursor + 1);
      const withNew = coalesce
        ? [...truncated.slice(0, -1), { state: next, label, at: now }]
        : [...truncated, { state: next, label, at: now }];

      const overflow = Math.max(0, withNew.length - MAX_HISTORY);
      const trimmed = overflow > 0 ? withNew.slice(overflow) : withNew;
      const rawCursor = coalesce ? prevCursor : prevCursor + 1;
      apply(trimmed, rawCursor - overflow);
    },
    [apply],
  );

  const undo = useCallback(() => {
    const { timeline: t, cursor: c } = snapshot.current;
    apply(t, Math.max(0, c - 1));
  }, [apply]);

  const redo = useCallback(() => {
    const { timeline: t, cursor: c } = snapshot.current;
    apply(t, Math.min(t.length - 1, c + 1));
  }, [apply]);

  const restoreTo = useCallback(
    (index: number) => {
      const { timeline: t } = snapshot.current;
      apply(t, Math.max(0, Math.min(index, t.length - 1)));
    },
    [apply],
  );

  /** Resets the whole timeline to a fresh single checkpoint (e.g. after loading a new file). */
  const replaceInitial = useCallback(
    (state: T) => {
      lastCommitRef.current = { at: 0, label: "" };
      apply([{ state, label: "Start", at: Date.now() }], 0);
    },
    [apply],
  );

  return {
    state: timeline[cursor].state,
    set,
    undo,
    redo,
    canUndo: cursor > 0,
    canRedo: cursor < timeline.length - 1,
    timeline,
    cursor,
    restoreTo,
    replaceInitial,
  };
}
