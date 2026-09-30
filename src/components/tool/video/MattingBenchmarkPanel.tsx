import { useState } from "react";
import { Play, Loader2, Copy, Check } from "lucide-react";
import {
  runBenchmarkSuite,
  formatReportAsMarkdown,
  DEFAULT_BENCHMARK_CASES,
  type BenchmarkReport,
  type BenchmarkCase,
} from "../../../lib/matting/benchmark";

/**
 * PHASE 14 — PERFORMANCE OPTIMIZATION. Dev-facing panel that runs
 * src/lib/matting/benchmark.ts's suite in the browser and displays results —
 * this has to run client-side since the metrics it records (performance.now,
 * performance.memory, WebGPU adapter info, and the matting pipeline itself)
 * only exist in a real browser tab, not in a build step or CI script.
 */
export default function MattingBenchmarkPanel() {
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number; current: BenchmarkCase } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setIsRunning(true);
    setError(null);
    setReport(null);
    setProgress(null);
    try {
      const result = await runBenchmarkSuite(DEFAULT_BENCHMARK_CASES, (completed, total, current) =>
        setProgress({ completed, total, current }),
      );
      setReport(result);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Benchmark failed to run.");
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  };

  const copyMarkdown = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatReportAsMarkdown(report));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // markdown is still visible below to copy by hand.
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Matting performance benchmark</h2>
            <p className="mt-1 text-caption text-(--color-text-muted)">
              Runs the real background-removal pipeline against synthetic images at several resolutions and
              simulated video frame rates, on this device, right now.
            </p>
          </div>
          <button
            type="button"
            disabled={isRunning}
            onClick={run}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            {isRunning ? "Running…" : "Run benchmark"}
          </button>
        </div>
        {isRunning && progress && (
          <p className="mt-3 text-caption text-(--color-text-muted)">
            {progress.completed}/{progress.total} — {progress.current.id} ({progress.current.width}×{progress.current.height}
            {progress.current.fps ? ` @${progress.current.fps}fps` : ""})
          </p>
        )}
        {error && <p className="mt-3 text-body-sm text-danger-600">{error}</p>}
      </div>

      {report && (
        <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Results</h3>
            <button
              type="button"
              onClick={copyMarkdown}
              className="inline-flex items-center gap-2 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
            >
              {copied ? <Check size={14} className="text-success-600" /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-caption sm:grid-cols-4">
            <div>
              <dt className="text-(--color-text-muted)">CPU cores</dt>
              <dd className="font-medium">{report.environment.cpuCores}</dd>
            </div>
            <div>
              <dt className="text-(--color-text-muted)">Device memory</dt>
              <dd className="font-medium">
                {report.environment.deviceMemoryGb !== null ? `~${report.environment.deviceMemoryGb}GB` : "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-(--color-text-muted)">WebGPU</dt>
              <dd className="font-medium">{report.environment.webgpuAvailable ? "available" : "not available"}</dd>
            </div>
            <div>
              <dt className="text-(--color-text-muted)">GPU</dt>
              <dd className="font-medium">
                {[
                  report.environment.webgpuAdapterInfo?.vendor,
                  report.environment.webgpuAdapterInfo?.architecture,
                  report.environment.webgpuAdapterInfo?.description,
                ]
                  .filter(Boolean)
                  .join(" / ") || "not reported by browser"}
              </dd>
            </div>
          </dl>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-caption">
              <thead>
                <tr className="border-b border-(--color-border) text-(--color-text-muted)">
                  <th className="py-2 pr-3 font-medium">Case</th>
                  <th className="py-2 pr-3 font-medium">Resolution</th>
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Inference</th>
                  <th className="py-2 pr-3 font-medium">Total</th>
                  <th className="py-2 pr-3 font-medium">Peak memory</th>
                  <th className="py-2 pr-3 font-medium">GPU memory</th>
                  <th className="py-2 font-medium">Throughput</th>
                </tr>
              </thead>
              <tbody>
                {report.measurements.map((m) => (
                  <tr key={m.case.id} className="border-b border-(--color-border)/60">
                    <td className="py-2 pr-3">{m.case.id}</td>
                    <td className="py-2 pr-3">
                      {m.case.width}×{m.case.height}
                      {m.case.fps ? ` @${m.case.fps}fps` : ""}
                    </td>
                    {m.ok ? (
                      <>
                        <td className="py-2 pr-3">{m.modelUsed ?? "—"}</td>
                        <td className="py-2 pr-3">{m.inferenceTimeMs.toFixed(0)}ms</td>
                        <td className="py-2 pr-3">{m.totalTimeMs.toFixed(0)}ms</td>
                        <td className="py-2 pr-3">
                          {m.peakMemoryBytes !== null ? `${(m.peakMemoryBytes / (1024 * 1024)).toFixed(1)}MB` : "n/a"}
                        </td>
                        <td className="py-2 pr-3 text-(--color-text-muted)">n/a (no browser API)</td>
                        <td className="py-2">{m.throughputFps.toFixed(2)} fps</td>
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

          <p className="mt-4 text-caption text-(--color-text-muted)">
            Peak memory is the JS heap delta from <code>performance.memory</code> (Chrome/Edge only — shown as n/a
            elsewhere) and is an approximation, not a continuously-sampled true peak. No standard browser API exposes
            GPU memory usage to page JavaScript, so that column is always n/a — reported explicitly rather than
            omitted or guessed.
          </p>
        </div>
      )}
    </div>
  );
}
