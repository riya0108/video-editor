/**
 * Deterministic, human-readable ids ("clip-1", "track-2", ...) — same
 * convention as src/lib/ffmpeg/cuts.ts's nextCutSegmentId, chosen for the
 * same reason: deterministic output makes undo/redo and operation tests
 * easy to assert on exactly, unlike a random uuid.
 *
 * Counters are scoped per prefix, module-wide — fine for this engine's
 * actual usage (one counter sequence per running app instance) and makes
 * every id globally unique within a session regardless of which timeline
 * instance it was created on.
 */
const counters = new Map<string, number>();

export function createId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}-${next}`;
}

/** Test-only: resets every counter back to 0 so test output is reproducible across files/runs. */
export function resetIdCountersForTests(): void {
  counters.clear();
}
