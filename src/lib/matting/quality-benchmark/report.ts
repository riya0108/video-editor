import type { ImageCaseMeasurement, VideoCaseMeasurement, QualityRunResult } from "./runner";
import type { ImageMetrics } from "./metrics";

/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. Turns a benchmark run into a
 * JSON-serializable report (so it can be saved, downloaded, and re-loaded
 * later to diff against a new run — "the goal is to measure improvement
 * between versions," not to produce a one-off number). Deliberately
 * excludes the run's visual canvases (see runner.ts) — a report is meant to
 * be small enough to keep many of, one per pipeline version, and diffed.
 *
 * HARD RULE, per the phase brief: nothing generated here compares this
 * app's output to Photoshop, or any other product, and no report or label
 * text may claim parity with one. This benchmark only ever measures THIS
 * APP's own pipeline against its own synthetic ground truth, across
 * versions of itself. If a real documented Photoshop-comparison protocol
 * is ever run, it must live in its own separate, explicitly-labeled report
 * — never silently folded into this one.
 */

export interface HumanEvaluation {
  caseId: string;
  /** 1 (unusable) – 5 (looks correct) — filled in by an actual person using the review UI, never fabricated or defaulted to a number. */
  rating: 1 | 2 | 3 | 4 | 5;
  notes: string;
  evaluatedAt: string;
}

export interface CategoryAggregate {
  category: string;
  caseCount: number;
  okCount: number;
  meanMetrics: ImageMetrics | null;
}

export interface QualityReport {
  /** A free-text label the caller supplies to identify which pipeline build this run measured (e.g. a date, a phase number, a git commit) — never inferred or guessed. */
  versionLabel: string;
  generatedAt: string;
  imageMeasurements: ImageCaseMeasurement[];
  videoMeasurements: VideoCaseMeasurement[];
  categoryAggregates: CategoryAggregate[];
  videoAggregate: { caseCount: number; okCount: number; meanMetrics: ImageMetrics | null; meanTemporalConsistencyError: number | null };
  /** Populated only once a real person has rated cases via the review UI — absent entries mean "not yet rated," never a fabricated default. */
  humanEvaluations: HumanEvaluation[];
}

function meanMetricsOf(list: ImageMetrics[]): ImageMetrics | null {
  if (list.length === 0) return null;
  const sum = list.reduce(
    (acc, m) => ({
      sad: acc.sad + m.sad,
      mse: acc.mse + m.mse,
      mad: acc.mad + m.mad,
      gradientError: acc.gradientError + m.gradientError,
      connectivityError: acc.connectivityError + m.connectivityError,
    }),
    { sad: 0, mse: 0, mad: 0, gradientError: 0, connectivityError: 0 },
  );
  const n = list.length;
  return { sad: sum.sad / n, mse: sum.mse / n, mad: sum.mad / n, gradientError: sum.gradientError / n, connectivityError: sum.connectivityError / n };
}

export function buildReport(run: QualityRunResult, versionLabel: string, humanEvaluations: HumanEvaluation[] = []): QualityReport {
  const categories = ["easy", "medium", "hard"] as const;
  const categoryAggregates: CategoryAggregate[] = categories.map((category) => {
    const cases = run.imageMeasurements.filter((m) => m.category === category);
    const okMetrics = cases.filter((m) => m.ok && m.metrics).map((m) => m.metrics as ImageMetrics);
    return { category, caseCount: cases.length, okCount: okMetrics.length, meanMetrics: meanMetricsOf(okMetrics) };
  });

  const okVideo = run.videoMeasurements.filter((m) => m.ok && m.meanMetrics);
  const temporalValues = run.videoMeasurements.filter((m) => m.temporalConsistencyError !== undefined).map((m) => m.temporalConsistencyError as number);

  return {
    versionLabel,
    generatedAt: run.generatedAt,
    imageMeasurements: run.imageMeasurements,
    videoMeasurements: run.videoMeasurements,
    categoryAggregates,
    videoAggregate: {
      caseCount: run.videoMeasurements.length,
      okCount: okVideo.length,
      meanMetrics: meanMetricsOf(okVideo.map((m) => m.meanMetrics as ImageMetrics)),
      meanTemporalConsistencyError: temporalValues.length > 0 ? temporalValues.reduce((s, v) => s + v, 0) / temporalValues.length : null,
    },
    humanEvaluations,
  };
}

function fmt(n: number | null | undefined, digits = 4): string {
  return n === null || n === undefined ? "n/a" : n.toFixed(digits);
}

export function formatReportAsMarkdown(report: QualityReport): string {
  const lines: string[] = [];
  lines.push(`# Matte quality benchmark — ${report.versionLabel}`);
  lines.push(`Generated ${report.generatedAt}`);
  lines.push("");
  lines.push(
    "> Metrics are computed against this benchmark's own synthetic ground truth (see dataset.ts/video-dataset.ts) and are only meaningful RELATIVE TO EARLIER RUNS OF THIS SAME BENCHMARK. They are not calibrated against, and must never be presented as equivalent to, any other product's output (e.g. Photoshop) or the published alphamatting.com leaderboard — see metrics.ts and report.ts for why.",
  );
  lines.push("");
  lines.push("## Category summary (still images)");
  lines.push("");
  lines.push("| Category | Cases | Succeeded | Mean SAD | Mean MSE | Mean MAD | Mean gradient err. | Mean connectivity err. |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const agg of report.categoryAggregates) {
    lines.push(
      `| ${agg.category} | ${agg.caseCount} | ${agg.okCount} | ${fmt(agg.meanMetrics?.sad)} | ${fmt(agg.meanMetrics?.mse)} | ${fmt(agg.meanMetrics?.mad)} | ${fmt(agg.meanMetrics?.gradientError)} | ${fmt(agg.meanMetrics?.connectivityError)} |`,
    );
  }
  lines.push("");
  lines.push("## Video summary");
  lines.push("");
  lines.push(
    `Cases: ${report.videoAggregate.caseCount}, succeeded: ${report.videoAggregate.okCount}. Mean MAD: ${fmt(report.videoAggregate.meanMetrics?.mad)}. Mean temporal-consistency error: ${fmt(report.videoAggregate.meanTemporalConsistencyError)}.`,
  );
  lines.push("");
  lines.push("## Per-case results (still images)");
  lines.push("");
  lines.push("| Case | Category | Model | SAD | MSE | MAD | Gradient err. | Connectivity err. |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const m of report.imageMeasurements) {
    if (!m.ok) {
      lines.push(`| ${m.caseId} | ${m.category} | — | FAILED: ${m.error ?? "unknown error"} | | | | |`);
      continue;
    }
    lines.push(`| ${m.caseId} | ${m.category} | ${m.modelUsed} | ${fmt(m.metrics?.sad)} | ${fmt(m.metrics?.mse)} | ${fmt(m.metrics?.mad)} | ${fmt(m.metrics?.gradientError)} | ${fmt(m.metrics?.connectivityError)} |`);
  }
  lines.push("");
  lines.push("## Per-case results (video)");
  lines.push("");
  lines.push("| Case | Frames | Model | Mean MAD | Temporal consistency err. |");
  lines.push("|---|---|---|---|---|");
  for (const m of report.videoMeasurements) {
    if (!m.ok) {
      lines.push(`| ${m.caseId} | ${m.framesProcessed}/${m.framesTotal} | — | FAILED: ${m.error ?? "unknown error"} | |`);
      continue;
    }
    lines.push(`| ${m.caseId} | ${m.framesProcessed}/${m.framesTotal} | ${m.modelUsed} | ${fmt(m.meanMetrics?.mad)} | ${fmt(m.temporalConsistencyError)} |`);
  }
  lines.push("");
  lines.push("## Human visual evaluation");
  lines.push("");
  if (report.humanEvaluations.length === 0) {
    lines.push("No cases have been rated by a human reviewer yet — run the review UI and rate cases to populate this section.");
  } else {
    lines.push("| Case | Rating (1-5) | Notes | Evaluated |");
    lines.push("|---|---|---|---|");
    for (const h of report.humanEvaluations) {
      lines.push(`| ${h.caseId} | ${h.rating} | ${h.notes || "—"} | ${h.evaluatedAt} |`);
    }
  }
  return lines.join("\n");
}

export interface MetricDelta {
  metric: keyof ImageMetrics;
  previous: number;
  current: number;
  /** current - previous — negative means the error got smaller, i.e. improved, for every metric here (all five are "lower is better"). */
  delta: number;
  improved: boolean;
}

export interface CaseComparison {
  caseId: string;
  presentInPrevious: boolean;
  presentInCurrent: boolean;
  deltas: MetricDelta[];
}

export interface ReportComparison {
  previousVersionLabel: string;
  currentVersionLabel: string;
  caseComparisons: CaseComparison[];
  /** Simple net verdict: count of cases whose MAD improved vs. regressed vs. unchanged/unavailable — a first-glance summary, not a substitute for reading the per-case deltas. */
  summary: { improved: number; regressed: number; unchanged: number; newCases: number; removedCases: number };
}

const METRIC_KEYS: (keyof ImageMetrics)[] = ["sad", "mse", "mad", "gradientError", "connectivityError"];

/** Pure diff between two reports — the concrete mechanism for "measure improvement between versions." Compares still-image cases by id; a case present in only one report is flagged, not silently skipped. */
export function compareReports(previous: QualityReport, current: QualityReport): ReportComparison {
  const prevById = new Map(previous.imageMeasurements.map((m) => [m.caseId, m]));
  const curById = new Map(current.imageMeasurements.map((m) => [m.caseId, m]));
  const allIds = new Set([...prevById.keys(), ...curById.keys()]);

  const caseComparisons: CaseComparison[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let newCases = 0;
  let removedCases = 0;

  for (const id of allIds) {
    const prevCase = prevById.get(id);
    const curCase = curById.get(id);
    const presentInPrevious = !!prevCase?.metrics;
    const presentInCurrent = !!curCase?.metrics;

    if (!presentInPrevious && presentInCurrent) newCases++;
    if (presentInPrevious && !presentInCurrent) removedCases++;

    const deltas: MetricDelta[] = [];
    if (presentInPrevious && presentInCurrent) {
      for (const key of METRIC_KEYS) {
        const previousValue = (prevCase!.metrics as ImageMetrics)[key];
        const currentValue = (curCase!.metrics as ImageMetrics)[key];
        deltas.push({ metric: key, previous: previousValue, current: currentValue, delta: currentValue - previousValue, improved: currentValue < previousValue });
      }
      const madDelta = deltas.find((d) => d.metric === "mad")!;
      if (madDelta.delta < -1e-9) improved++;
      else if (madDelta.delta > 1e-9) regressed++;
      else unchanged++;
    }

    caseComparisons.push({ caseId: id, presentInPrevious, presentInCurrent, deltas });
  }

  return {
    previousVersionLabel: previous.versionLabel,
    currentVersionLabel: current.versionLabel,
    caseComparisons: caseComparisons.sort((a, b) => a.caseId.localeCompare(b.caseId)),
    summary: { improved, regressed, unchanged, newCases, removedCases },
  };
}
