/** Summary of a list of timing samples (ms). Percentiles are nearest-rank on the sorted samples. */
export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) return { n: 0, mean: NaN, p50: NaN, p95: NaN, min: NaN, max: NaN };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: rank(0.5), p95: rank(0.95), min: s[0], max: s[s.length - 1] };
}

/** Rounds every number in a JSON-able value to `digits` decimals — keeps reports readable. */
export function roundDeep<T>(value: T, digits = 2): T {
  const k = 10 ** digits;
  const walk = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * k) / k : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
