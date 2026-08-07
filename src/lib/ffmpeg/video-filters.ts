export type StabilizeStrength = "light" | "standard" | "strong";

// deshake requires rx/ry to be exact multiples of 16.
const STABILIZE_PRESETS: Record<StabilizeStrength, { search: number; zoom: number }> = {
  light: { search: 16, zoom: 0.04 },
  standard: { search: 32, zoom: 0.08 },
  strong: { search: 64, zoom: 0.14 },
};

/**
 * Best-effort video stabilization. The proper tool for this (ffmpeg's
 * two-pass vidstabdetect/vidstabtransform, which does real trajectory
 * smoothing) isn't compiled into the browser ffmpeg build we ship — only
 * the much simpler single-pass `deshake` filter is available, and deshake
 * has no smoothing of its own, which is exactly what made the old default
 * output look shaky and abrupt.
 *
 * This tunes deshake's search so it doesn't lose tracking lock on larger
 * shakes (the biggest source of sudden jumps), then crops in a few percent
 * and rescales back up — a manual stand-in for vidstab's "zoom" parameter
 * that hides the wobbly, mirrored edges deshake leaves behind.
 */
export function stabilizeFilter(strength: StabilizeStrength = "standard"): string {
  const { search, zoom } = STABILIZE_PRESETS[strength];
  const keep = 1 - zoom;
  return [
    `deshake=rx=${search}:ry=${search}:edge=mirror:search=exhaustive`,
    // libx264/yuv420p require even dimensions — round both stages independently
    // rather than compounding a fractional crop into an odd rescale target.
    `crop=trunc(iw*${keep}/2)*2:trunc(ih*${keep}/2)*2`,
    `scale=trunc(iw/${keep}/2)*2:trunc(ih/${keep}/2)*2:flags=lanczos`,
  ].join(",");
}
