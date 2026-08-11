export interface KeepInterval {
  start: number;
  end: number;
}

/**
 * Cuts the given [start,end) intervals out of a single input and glues the
 * rest back together in one pass — the standard ffmpeg trim+concat pattern.
 * Each interval becomes its own trim/atrim pair (video and audio kept in
 * sync), then all pairs feed one `concat` filter.
 */
export function buildTrimConcatFilter(intervals: KeepInterval[]): {
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
    const v = `tcv${i}`;
    const a = `tca${i}`;
    parts.push(
      `[0:v]trim=start=${interval.start.toFixed(3)}:end=${interval.end.toFixed(3)},setpts=PTS-STARTPTS[${v}]`,
    );
    parts.push(
      `[0:a]atrim=start=${interval.start.toFixed(3)}:end=${interval.end.toFixed(3)},asetpts=PTS-STARTPTS[${a}]`,
    );
    pairs.push(`[${v}][${a}]`);
  });

  const videoLabel = "tcoutv";
  const audioLabel = "tcouta";
  parts.push(`${pairs.join("")}concat=n=${intervals.length}:v=1:a=1[${videoLabel}][${audioLabel}]`);

  return { filterComplex: parts.join(";"), videoLabel, audioLabel };
}
