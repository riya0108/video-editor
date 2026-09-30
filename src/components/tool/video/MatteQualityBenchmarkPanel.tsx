import { useEffect, useMemo, useState } from "react";
import { Play, Loader2, Copy, Check, Download, Upload, Save } from "lucide-react";
import { runQualityBenchmark, type QualityRunResult, type ImageCaseVisuals } from "../../../lib/matting/quality-benchmark/runner";
import { buildReport, formatReportAsMarkdown, compareReports, type QualityReport, type HumanEvaluation } from "../../../lib/matting/quality-benchmark/report";

/**
 * PHASE 15 — MATTE BENCHMARK SYSTEM. Runs the permanent synthetic matte
 * benchmark in the browser, shows objective metrics (SAD/MSE/MAD/gradient/
 * connectivity/temporal-consistency — see metrics.ts), lets a real person
 * record their own visual judgment per case (never fabricated — see
 * report.ts's HumanEvaluation doc comment), and supports saving/loading a
 * report to compare against a later run ("measure improvement between
 * versions" — see report.ts's compareReports).
 */

const REPORTS_STORAGE_KEY = "clipbench:matte-quality-reports";
const RATINGS_STORAGE_KEY = "clipbench:matte-quality-human-ratings";

function loadSavedReports(): QualityReport[] {
  try {
    const raw = localStorage.getItem(REPORTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QualityReport[]) : [];
  } catch {
    return [];
  }
}

function saveSavedReports(reports: QualityReport[]) {
  try {
    localStorage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // Storage can fail (quota, private browsing) — the current report is still visible/downloadable, just not persisted.
  }
}

function loadRatings(): Record<string, HumanEvaluation> {
  try {
    const raw = localStorage.getItem(RATINGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, HumanEvaluation>) : {};
  } catch {
    return {};
  }
}

function saveRatings(ratings: Record<string, HumanEvaluation>) {
  try {
    localStorage.setItem(RATINGS_STORAGE_KEY, JSON.stringify(ratings));
  } catch {
    // Same as above — non-fatal.
  }
}

function CanvasThumb({ canvas, label }: { canvas: HTMLCanvasElement | null; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded border border-(--color-border) bg-checkerboard">
        {canvas ? (
          <img src={canvas.toDataURL()} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="text-caption text-(--color-text-muted)">n/a</span>
        )}
      </div>
      <span className="text-caption text-(--color-text-muted)">{label}</span>
    </div>
  );
}

function HumanRatingRow({
  caseId,
  visuals,
  rating,
  onChange,
}: {
  caseId: string;
  visuals: ImageCaseVisuals | undefined;
  rating: HumanEvaluation | undefined;
  onChange: (rating: HumanEvaluation) => void;
}) {
  const [stars, setStars] = useState<HumanEvaluation["rating"]>(rating?.rating ?? 3);
  const [notes, setNotes] = useState(rating?.notes ?? "");

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-(--color-border)/60 py-3">
      <div className="w-48 shrink-0 text-caption font-medium">{caseId}</div>
      <div className="flex gap-2">
        <CanvasThumb canvas={visuals?.compositeCanvas ?? null} label="Photo" />
        <CanvasThumb canvas={visuals?.groundTruthAlphaCanvas ?? null} label="GT alpha" />
        <CanvasThumb canvas={visuals?.predictedAlphaCanvas ?? null} label="Pred. alpha" />
        <CanvasThumb canvas={visuals?.predictedForegroundCanvas ?? null} label="Pred. cutout" />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={stars}
          onChange={(e) => setStars(Number(e.target.value) as HumanEvaluation["rating"])}
          className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption"
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "(unusable)" : n === 5 ? "(looks correct)" : ""}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="w-56 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption"
        />
        <button
          type="button"
          onClick={() => onChange({ caseId, rating: stars, notes, evaluatedAt: new Date().toISOString() })}
          className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-2.5 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
        >
          <Save size={13} />
          Save
        </button>
      </div>
    </div>
  );
}

export default function MatteQualityBenchmarkPanel() {
  const [versionLabel, setVersionLabel] = useState(() => new Date().toISOString().slice(0, 10));
  const [run, setRun] = useState<QualityRunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ratings, setRatings] = useState<Record<string, HumanEvaluation>>({});
  const [savedReports, setSavedReports] = useState<QualityReport[]>([]);
  const [compareIndex, setCompareIndex] = useState<number | "">("");

  useEffect(() => {
    setRatings(loadRatings());
    setSavedReports(loadSavedReports());
  }, []);

  const report = useMemo(() => {
    if (!run) return null;
    return buildReport(run, versionLabel, Object.values(ratings));
  }, [run, versionLabel, ratings]);

  const comparison = useMemo(() => {
    if (!report || compareIndex === "" || !savedReports[compareIndex]) return null;
    return compareReports(savedReports[compareIndex], report);
  }, [report, compareIndex, savedReports]);

  const runBenchmark = async () => {
    setIsRunning(true);
    setError(null);
    setRun(null);
    setProgress(null);
    try {
      const result = await runQualityBenchmark((completed, total, label) => setProgress({ completed, total, label }));
      setRun(result);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Benchmark failed to run.");
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  };

  const updateRating = (rating: HumanEvaluation) => {
    setRatings((prev) => {
      const next = { ...prev, [rating.caseId]: rating };
      saveRatings(next);
      return next;
    });
  };

  const copyMarkdown = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatReportAsMarkdown(report));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission issues aren't fatal — the report is still visible on screen.
    }
  };

  const saveReport = () => {
    if (!report) return;
    const next = [...savedReports, report];
    setSavedReports(next);
    saveSavedReports(next);
  };

  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `matte-quality-${report.versionLabel.replace(/[^a-z0-9-_]+/gi, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadReportFile = async (file: File) => {
    try {
      const text = await file.text();
      const loaded = JSON.parse(text) as QualityReport;
      const next = [...savedReports, loaded];
      setSavedReports(next);
      saveSavedReports(next);
      setCompareIndex(next.length - 1);
    } catch (err) {
      console.error(err);
      setError("That file doesn't look like a matte quality report.");
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Matte quality benchmark</h2>
            <p className="mt-1 text-caption text-(--color-text-muted)">
              Runs the real background-removal pipeline against the permanent synthetic dataset (Easy/Medium/Hard/Video
              categories) and scores it against exact ground truth. See the report footer for what these numbers do —
              and don't — mean.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-caption text-(--color-text-muted)">
              Version label
              <input
                type="text"
                value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
                className="ml-2 w-40 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption"
              />
            </label>
            <button
              type="button"
              disabled={isRunning}
              onClick={runBenchmark}
              className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunning ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              {isRunning ? "Running…" : "Run benchmark"}
            </button>
          </div>
        </div>
        {isRunning && progress && (
          <p className="mt-3 text-caption text-(--color-text-muted)">
            {progress.completed}/{progress.total} — {progress.label}
          </p>
        )}
        {error && <p className="mt-3 text-body-sm text-danger-600">{error}</p>}
      </div>

      {report && (
        <>
          <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">Results — {report.versionLabel}</h3>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={copyMarkdown} className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  {copied ? <Check size={14} className="text-success-600" /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy Markdown"}
                </button>
                <button type="button" onClick={saveReport} className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  <Save size={14} />
                  Save for later comparison
                </button>
                <button type="button" onClick={downloadReport} className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  <Download size={14} />
                  Download JSON
                </button>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  <Upload size={14} />
                  Load report JSON
                  <input
                    type="file"
                    accept="application/json"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) loadReportFile(f);
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-caption">
                <thead>
                  <tr className="border-b border-(--color-border) text-(--color-text-muted)">
                    <th className="py-2 pr-3 font-medium">Category</th>
                    <th className="py-2 pr-3 font-medium">Cases</th>
                    <th className="py-2 pr-3 font-medium">Succeeded</th>
                    <th className="py-2 pr-3 font-medium">Mean SAD</th>
                    <th className="py-2 pr-3 font-medium">Mean MSE</th>
                    <th className="py-2 pr-3 font-medium">Mean MAD</th>
                    <th className="py-2 pr-3 font-medium">Mean gradient err.</th>
                    <th className="py-2 font-medium">Mean connectivity err.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.categoryAggregates.map((agg) => (
                    <tr key={agg.category} className="border-b border-(--color-border)/60">
                      <td className="py-2 pr-3 capitalize">{agg.category}</td>
                      <td className="py-2 pr-3">{agg.caseCount}</td>
                      <td className="py-2 pr-3">{agg.okCount}</td>
                      <td className="py-2 pr-3">{agg.meanMetrics ? agg.meanMetrics.sad.toFixed(2) : "n/a"}</td>
                      <td className="py-2 pr-3">{agg.meanMetrics ? agg.meanMetrics.mse.toFixed(4) : "n/a"}</td>
                      <td className="py-2 pr-3">{agg.meanMetrics ? agg.meanMetrics.mad.toFixed(4) : "n/a"}</td>
                      <td className="py-2 pr-3">{agg.meanMetrics ? agg.meanMetrics.gradientError.toFixed(4) : "n/a"}</td>
                      <td className="py-2">{agg.meanMetrics ? agg.meanMetrics.connectivityError.toFixed(4) : "n/a"}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2 pr-3">video</td>
                    <td className="py-2 pr-3">{report.videoAggregate.caseCount}</td>
                    <td className="py-2 pr-3">{report.videoAggregate.okCount}</td>
                    <td className="py-2 pr-3" colSpan={3}>
                      Mean MAD: {report.videoAggregate.meanMetrics ? report.videoAggregate.meanMetrics.mad.toFixed(4) : "n/a"}
                    </td>
                    <td className="py-2" colSpan={2}>
                      Mean temporal consistency err.: {report.videoAggregate.meanTemporalConsistencyError !== null ? report.videoAggregate.meanTemporalConsistencyError.toFixed(4) : "n/a"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-4 rounded-md bg-(--color-bg-subtle) p-3 text-caption text-(--color-text-muted)">
              These numbers are computed against this benchmark's own synthetic ground truth and are only meaningful
              relative to earlier runs of this same benchmark — never presented as equivalent to any other product's
              output (e.g. Photoshop) or to the published alphamatting.com leaderboard.
            </p>
          </div>

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
            <h3 className="font-semibold">Per-case results</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-caption">
                <thead>
                  <tr className="border-b border-(--color-border) text-(--color-text-muted)">
                    <th className="py-2 pr-3 font-medium">Case</th>
                    <th className="py-2 pr-3 font-medium">Category</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">SAD</th>
                    <th className="py-2 pr-3 font-medium">MSE</th>
                    <th className="py-2 pr-3 font-medium">MAD</th>
                    <th className="py-2 pr-3 font-medium">Gradient err.</th>
                    <th className="py-2 font-medium">Connectivity err.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.imageMeasurements.map((m) => (
                    <tr key={m.caseId} className="border-b border-(--color-border)/60">
                      <td className="py-2 pr-3">{m.caseId}</td>
                      <td className="py-2 pr-3 capitalize">{m.category}</td>
                      {m.ok ? (
                        <>
                          <td className="py-2 pr-3">{m.modelUsed}</td>
                          <td className="py-2 pr-3">{m.metrics!.sad.toFixed(1)}</td>
                          <td className="py-2 pr-3">{m.metrics!.mse.toFixed(4)}</td>
                          <td className="py-2 pr-3">{m.metrics!.mad.toFixed(4)}</td>
                          <td className="py-2 pr-3">{m.metrics!.gradientError.toFixed(4)}</td>
                          <td className="py-2">{m.metrics!.connectivityError.toFixed(4)}</td>
                        </>
                      ) : (
                        <td colSpan={6} className="py-2 text-danger-600">
                          Failed: {m.error}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mt-6 font-semibold">Per-case results — video</h4>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-caption">
                <thead>
                  <tr className="border-b border-(--color-border) text-(--color-text-muted)">
                    <th className="py-2 pr-3 font-medium">Case</th>
                    <th className="py-2 pr-3 font-medium">Frames</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">Mean MAD</th>
                    <th className="py-2 font-medium">Temporal consistency err.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.videoMeasurements.map((m) => (
                    <tr key={m.caseId} className="border-b border-(--color-border)/60">
                      <td className="py-2 pr-3">{m.caseId}</td>
                      <td className="py-2 pr-3">
                        {m.framesProcessed}/{m.framesTotal}
                      </td>
                      {m.ok ? (
                        <>
                          <td className="py-2 pr-3">{m.modelUsed}</td>
                          <td className="py-2 pr-3">{m.meanMetrics!.mad.toFixed(4)}</td>
                          <td className="py-2">{m.temporalConsistencyError !== undefined ? m.temporalConsistencyError.toFixed(4) : "n/a"}</td>
                        </>
                      ) : (
                        <td colSpan={3} className="py-2 text-danger-600">
                          Failed: {m.error}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {savedReports.length > 0 && (
            <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="font-semibold">Compare against a saved run</h3>
                <select
                  value={compareIndex}
                  onChange={(e) => setCompareIndex(e.target.value === "" ? "" : Number(e.target.value))}
                  className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption"
                >
                  <option value="">Choose a saved report…</option>
                  {savedReports.map((r, i) => (
                    <option key={i} value={i}>
                      {r.versionLabel} ({r.generatedAt})
                    </option>
                  ))}
                </select>
              </div>
              {comparison && (
                <div className="mt-4">
                  <p className="text-caption">
                    {comparison.previousVersionLabel} → {comparison.currentVersionLabel}: {comparison.summary.improved} improved,{" "}
                    {comparison.summary.regressed} regressed, {comparison.summary.unchanged} unchanged
                    {comparison.summary.newCases > 0 ? `, ${comparison.summary.newCases} new` : ""}
                    {comparison.summary.removedCases > 0 ? `, ${comparison.summary.removedCases} removed` : ""}.
                  </p>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[480px] text-left text-caption">
                      <thead>
                        <tr className="border-b border-(--color-border) text-(--color-text-muted)">
                          <th className="py-2 pr-3 font-medium">Case</th>
                          <th className="py-2 pr-3 font-medium">MAD before</th>
                          <th className="py-2 pr-3 font-medium">MAD after</th>
                          <th className="py-2 font-medium">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.caseComparisons.map((c) => {
                          const mad = c.deltas.find((d) => d.metric === "mad");
                          return (
                            <tr key={c.caseId} className="border-b border-(--color-border)/60">
                              <td className="py-2 pr-3">{c.caseId}</td>
                              <td className="py-2 pr-3">{mad ? mad.previous.toFixed(4) : c.presentInPrevious ? "—" : "n/a (new)"}</td>
                              <td className="py-2 pr-3">{mad ? mad.current.toFixed(4) : c.presentInCurrent ? "—" : "n/a (removed)"}</td>
                              <td className={`py-2 ${mad ? (mad.improved ? "text-success-600" : mad.delta > 0 ? "text-danger-600" : "") : ""}`}>
                                {mad ? `${mad.delta >= 0 ? "+" : ""}${mad.delta.toFixed(4)}` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
            <h3 className="font-semibold">Human visual evaluation</h3>
            <p className="mt-1 text-caption text-(--color-text-muted)">
              Objective metrics don't capture everything a human eye notices — rate each case's predicted cutout
              yourself. Ratings are saved locally and included in the report above once you save at least one.
            </p>
            <div className="mt-3">
              {report.imageMeasurements
                .filter((m) => m.ok)
                .map((m) => (
                  <HumanRatingRow key={m.caseId} caseId={m.caseId} visuals={run?.visuals.get(m.caseId)} rating={ratings[m.caseId]} onChange={updateRating} />
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
