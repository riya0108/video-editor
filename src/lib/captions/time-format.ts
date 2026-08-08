/**
 * Parses a flexible timecode string into seconds. Accepts plain seconds
 * ("83.4"), "mm:ss.s", or "hh:mm:ss.s" (with either "." or "," as the
 * decimal separator, so SRT-style timestamps parse too).
 */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim().replace(",", ".");
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3 || parts.some((p) => p === "")) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) return null;

  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return seconds < 0 ? null : seconds;
}

/** Formats seconds as "m:ss.s" (or "h:mm:ss.s" once past an hour). */
export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const secStr = seconds.toFixed(1).padStart(4, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secStr}`;
  }
  return `${minutes}:${secStr}`;
}
