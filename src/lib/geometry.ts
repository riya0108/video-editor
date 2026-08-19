/** Rounds to the nearest even integer, minimum 2 — most video codecs require even width/height/offsets. */
export function evenRound(value: number, min = 2): number {
  return Math.max(min, Math.round(value / 2) * 2);
}

/**
 * Rounds down to an even integer, minimum 2. Unlike `evenRound`, this never
 * rounds up — use it for a width/height that's already been clamped to fit
 * inside a hard boundary (e.g. the frame edge), since rounding up there would
 * push it back out of bounds.
 */
export function evenFloor(value: number, min = 2): number {
  return Math.max(min, Math.floor(value / 2) * 2);
}
