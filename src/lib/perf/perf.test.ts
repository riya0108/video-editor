import { describe, expect, it } from "vitest";
import { roundDeep, summarize } from "./stats";
import { buildBenchProject, BENCH_SOURCES } from "./bench-project";
import { resolveFrame } from "../composition/resolve";
import { monoMeasurer as measurer } from "../composition/test-helpers";

describe("perf stats", () => {
  it("summarizes with nearest-rank percentiles", () => {
    const s = summarize([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]);
    expect(s).toMatchObject({ n: 10, p50: 5, p95: 10, min: 1, max: 10, mean: 5.5 });
    expect(summarize([]).n).toBe(0);
  });
  it("rounds nested numbers", () => {
    expect(roundDeep({ a: 1.23456, b: [2.5551], c: "x" }, 2)).toEqual({ a: 1.23, b: [2.56], c: "x" });
  });
});

describe("bench project", () => {
  it("builds a 300-frame edit that resolves every layer kind", () => {
    const { timeline, ids } = buildBenchProject();
    expect(Object.keys(timeline.clips)).toHaveLength(9);
    const info = (id: string) => (id === BENCH_SOURCES.video ? { width: 1920, height: 1080 } : id === BENCH_SOURCES.logo ? { width: 400, height: 400 } : undefined);
    const f = resolveFrame(timeline, 150, { getSourceInfo: info, measurer });
    expect(f.missingSources).toEqual([]);
    const kinds = f.layers.map((l) => l.clipId);
    expect(kinds).toContain(ids.pip);
    expect(f.layers.filter((l) => l.transition).length).toBe(2);
  });
});
