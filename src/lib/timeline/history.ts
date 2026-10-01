/**
 * Generic snapshot-based undo/redo. Correct by construction rather than by
 * careful per-operation inverse logic: every edit in operations.ts already
 * returns a brand-new TimelineModel (structural sharing keeps this cheap —
 * see TIMELINE_ARCHITECTURE.md §1/§7), so "undo" is simply "go back to the
 * previous whole snapshot." Generic over T so it isn't coupled to
 * TimelineModel specifically, though engine.ts is its only real caller.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const DEFAULT_MAX_DEPTH = 100;

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] };
}

/** Records a new present state. Clears `future` (a fresh edit after an undo invalidates whatever redo would have replayed) and caps `past` at maxDepth. */
export function pushHistory<T>(history: History<T>, next: T, maxDepth = DEFAULT_MAX_DEPTH): History<T> {
  const past = [...history.past, history.present];
  while (past.length > maxDepth) past.shift();
  return { past, present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  const previous = history.past[history.past.length - 1];
  return { past, present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}
