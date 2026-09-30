export interface KeepInterval {
  start: number;
  end: number;
}

/**
 * Cuts the given [start,end) intervals out of a single input and glues the
 * rest back together in one pass — the standard ffmpeg trim+concat pattern.
 * Each interval becomes its own trim/atrim pair (video and audio kept in
 * sync), then all pairs feed one `concat` filter. `inputIndex` selects which
 * demuxed input the trim/atrim pairs read from (default 0, the first input).
 * `labelPrefix` disambiguates labels when this is called more than once in
 * the same filtergraph.
 */
export function buildTrimConcatFilter(
  intervals: KeepInterval[],
  inputIndex = 0,
  labelPrefix = "tc",
): {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string;
} {
  if (intervals.length === 0) {
    throw new Error("buildTrimConcatFilter requires at least one interval to keep");
  }

  const parts: string[] = [];
  const pairs: string[] = [];

  intervals.forEach((interval, i) => {
    const v = `${labelPrefix}v${i}`;
    const a = `${labelPrefix}a${i}`;
    parts.push(
      `[${inputIndex}:v]trim=start=${interval.start.toFixed(3)}:end=${interval.end.toFixed(3)},setpts=PTS-STARTPTS[${v}]`,
    );
    parts.push(
      `[${inputIndex}:a]atrim=start=${interval.start.toFixed(3)}:end=${interval.end.toFixed(3)},asetpts=PTS-STARTPTS[${a}]`,
    );
    pairs.push(`[${v}][${a}]`);
  });

  const videoLabel = `${labelPrefix}outv`;
  const audioLabel = `${labelPrefix}outa`;
  parts.push(`${pairs.join("")}concat=n=${intervals.length}:v=1:a=1[${videoLabel}][${audioLabel}]`);

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}
