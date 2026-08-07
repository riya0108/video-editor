/** Rounds to the nearest even integer, minimum 2 — most video codecs require even width/height/offsets. */
export function evenRound(value: number, min = 2): number {
  return Math.max(min, Math.round(value / 2) * 2);
}
