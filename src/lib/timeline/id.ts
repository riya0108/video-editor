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

/**
 * Advances counters past every id in `ids` that follows the "<prefix>-<n>"
 * convention. MUST run whenever a saved project is loaded: counters live in
 * module memory, so in a fresh session they restart at 0 and the next
 * createId("clip") would collide with a loaded "clip-1" — silently
 * overwriting a clip in the clips map.
 */
export function reserveIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /^(.*)-(\d+)$/.exec(id);
    if (!m) continue;
    const n = Number(m[2]);
    if (n > (counters.get(m[1]) ?? 0)) counters.set(m[1], n);
  }
}

/** Test-only: resets every counter back to 0 so test output is reproducible across files/runs. */
export function resetIdCountersForTests(): void {
  counters.clear();
}
