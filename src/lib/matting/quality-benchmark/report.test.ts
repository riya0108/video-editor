import { describe, it, expect } from "vitest";
import { buildReport, formatReportAsMarkdown, compareReports, type QualityReport } from "./report";
import type { QualityRunResult, ImageCaseMeasurement, VideoCaseMeasurement } from "./runner";
import type { ImageMetrics } from "./metrics";

function metrics(overrides: Partial<ImageMetrics> = {}): ImageMetrics {
  return { sad: 100, mse: 0.01, mad: 0.02, gradientError: 0.5, connectivityError: 0.1, ...overrides };
}

function imageCase(overrides: Partial<ImageCaseMeasurement> = {}): ImageCaseMeasurement {
  return {
    caseId: "easy-person-plain-bg",
    category: "easy",
    subcategory: "person on plain background",
    description: "test",
    ok: true,
    modelUsed: "u2net",
    confidence: 0.95,
    metrics: metrics(),
    ...overrides,
  };
}

function videoCase(overrides: Partial<VideoCaseMeasurement> = {}): VideoCaseMeasurement {
  return {
    caseId: "video-talking-person",
    category: "video",
    subcategory: "talking person",
    description: "test",
    ok: true,
    modelUsed: "u2net",
    meanMetrics: metrics(),
    temporalConsistencyError: 0.03,
    framesProcessed: 8,
    framesTotal: 8,
    ...overrides,
  };
}

function runResult(overrides: Partial<QualityRunResult> = {}): QualityRunResult {
  return {
    imageMeasurements: [imageCase()],
    videoMeasurements: [videoCase()],
    visuals: new Map(),
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildReport", () => {
  it("aggregates mean metrics per category from only the successful cases", () => {
    const run = runResult({
      imageMeasurements: [
        imageCase({ caseId: "a", category: "easy", metrics: metrics({ mad: 0.1 }) }),
        imageCase({ caseId: "b", category: "easy", metrics: metrics({ mad: 0.3 }) }),
        imageCase({ caseId: "c", category: "hard", ok: false, metrics: undefined, error: "boom" }),
      ],
    });
    const report = buildReport(run, "v1");
    const easy = report.categoryAggregates.find((a) => a.category === "easy")!;
    expect(easy.caseCount).toBe(2);
    expect(easy.okCount).toBe(2);
    expect(easy.meanMetrics!.mad).toBeCloseTo(0.2, 10);

    const hard = report.categoryAggregates.find((a) => a.category === "hard")!;
    expect(hard.caseCount).toBe(1);
    expect(hard.okCount).toBe(0);
    expect(hard.meanMetrics).toBeNull();
  });

  it("aggregates video temporal consistency only from cases that report it", () => {
    const run = runResult({
      videoMeasurements: [
        videoCase({ caseId: "v1", temporalConsistencyError: 0.02 }),
        videoCase({ caseId: "v2", temporalConsistencyError: 0.06 }),
        videoCase({ caseId: "v3", ok: false, meanMetrics: undefined, temporalConsistencyError: undefined, framesProcessed: 0 }),
      ],
    });
    const report = buildReport(run, "v1");
    expect(report.videoAggregate.caseCount).toBe(3);
    expect(report.videoAggregate.okCount).toBe(2);
    expect(report.videoAggregate.meanTemporalConsistencyError).toBeCloseTo(0.04, 10);
  });

  it("defaults human evaluations to empty — never fabricates a rating", () => {
    const report = buildReport(runResult(), "v1");
    expect(report.humanEvaluations).toEqual([]);
  });
});

describe("formatReportAsMarkdown", () => {
  it("includes the no-external-comparison guard note", () => {
    const md = formatReportAsMarkdown(buildReport(runResult(), "v1"));
    expect(md).toContain("must never be presented as equivalent to");
    expect(md).not.toMatch(/photoshop-level/i);
  });

  it("states plainly when no human evaluations exist yet, rather than omitting the section", () => {
    const md = formatReportAsMarkdown(buildReport(runResult(), "v1"));
    expect(md).toContain("No cases have been rated by a human reviewer yet");
  });

  it("renders a human evaluation row when one is supplied", () => {
    const report = buildReport(runResult(), "v1", [{ caseId: "easy-person-plain-bg", rating: 4, notes: "clean edges", evaluatedAt: "2026-01-01" }]);
    const md = formatReportAsMarkdown(report);
    expect(md).toContain("clean edges");
    expect(md).toContain("| easy-person-plain-bg | 4 |");
  });

  it("surfaces a failed case's error rather than a blank row", () => {
    const report = buildReport(runResult({ imageMeasurements: [imageCase({ ok: false, metrics: undefined, error: "no eligible model" })] }), "v1");
    const md = formatReportAsMarkdown(report);
    expect(md).toContain("FAILED: no eligible model");
  });
});

describe("compareReports", () => {
  it("flags an improvement when MAD decreases", () => {
    const previous: QualityReport = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.3 }) })] }), "v1");
    const current: QualityReport = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.1 }) })] }), "v2");
    const comparison = compareReports(previous, current);
    expect(comparison.summary.improved).toBe(1);
    expect(comparison.summary.regressed).toBe(0);
    const caseDelta = comparison.caseComparisons.find((c) => c.caseId === "easy-person-plain-bg")!;
    const mad = caseDelta.deltas.find((d) => d.metric === "mad")!;
    expect(mad.improved).toBe(true);
    expect(mad.delta).toBeCloseTo(-0.2, 10);
  });

  it("flags a regression when MAD increases", () => {
    const previous = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.1 }) })] }), "v1");
    const current = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.35 }) })] }), "v2");
    const comparison = compareReports(previous, current);
    expect(comparison.summary.regressed).toBe(1);
    expect(comparison.summary.improved).toBe(0);
  });

  it("flags a new case that only exists in the current report", () => {
    const previous = buildReport(runResult({ imageMeasurements: [imageCase({ caseId: "a" })] }), "v1");
    const current = buildReport(runResult({ imageMeasurements: [imageCase({ caseId: "a" }), imageCase({ caseId: "b" })] }), "v2");
    const comparison = compareReports(previous, current);
    expect(comparison.summary.newCases).toBe(1);
    const bCase = comparison.caseComparisons.find((c) => c.caseId === "b")!;
    expect(bCase.presentInPrevious).toBe(false);
    expect(bCase.presentInCurrent).toBe(true);
    expect(bCase.deltas).toEqual([]);
  });

  it("flags a removed case that only existed in the previous report", () => {
    const previous = buildReport(runResult({ imageMeasurements: [imageCase({ caseId: "a" }), imageCase({ caseId: "b" })] }), "v1");
    const current = buildReport(runResult({ imageMeasurements: [imageCase({ caseId: "a" })] }), "v2");
    const comparison = compareReports(previous, current);
    expect(comparison.summary.removedCases).toBe(1);
  });

  it("treats a truly unchanged metric as neither improved nor regressed", () => {
    const previous = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.2 }) })] }), "v1");
    const current = buildReport(runResult({ imageMeasurements: [imageCase({ metrics: metrics({ mad: 0.2 }) })] }), "v2");
    const comparison = compareReports(previous, current);
    expect(comparison.summary.unchanged).toBe(1);
  });
});
