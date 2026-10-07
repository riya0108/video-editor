import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clapperboard, Loader2, TriangleAlert, X, XCircle } from "lucide-react";
import type { TimelineModel } from "../../../../lib/timeline/model";
import { checkRenderSettings, OUTPUT_FRAME_RATES, OUTPUT_RESOLUTIONS, type OutputFrameRate } from "../../../../lib/render/settings";
import { RenderPlanError } from "../../../../lib/render/plan";
import type { RenderDeps, RenderOutcome, RenderProgress } from "../../../../lib/render/job";

/**
 * VIDEO EXPORT (RENDER_ENGINE_ARCHITECTURE.md §9): output size + frame rate, a progress bar per phase, cancel, and
 * the validation report of the file that was actually written. The download is offered only when every check passed —
 * a failed validation shows exactly which check failed and why (the file stays available, labelled as failed, for
 * inspection).
 */

const PHASE_LABEL: Record<RenderProgress["phase"], string> = {
  preparing: "Preparing",
  video: "Rendering frames",
  audio: "Mixing audio",
  finalizing: "Writing file",
  validating: "Validating output",
};

export default function VideoExportPanel({ timeline, deps }: { timeline: TimelineModel; deps: RenderDeps }) {
  const comp = timeline.composition;
  const sameShape = OUTPUT_RESOLUTIONS.filter((r) => checkRenderSettings(timeline, { width: r.width, height: r.height, fps: 30 }).ok);
  const [resId, setResId] = useState(sameShape[0]?.id ?? "");
  const [fps, setFps] = useState<OutputFrameRate>(OUTPUT_FRAME_RATES.includes(timeline.frameRate as OutputFrameRate) ? (timeline.frameRate as OutputFrameRate) : 30);
  const [state, setState] = useState<{ status: "idle" | "running" | "done" | "error"; progress?: RenderProgress; outcome?: RenderOutcome; url?: string; message?: string }>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => void (state.url && URL.revokeObjectURL(state.url)), [state.url]);
  // Composition size changed: keep the selection valid.
  useEffect(() => {
    if (!sameShape.some((r) => r.id === resId)) setResId(sameShape[0]?.id ?? "");
  }, [comp.width, comp.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const res = OUTPUT_RESOLUTIONS.find((r) => r.id === resId);
  const run = async () => {
    if (!res) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ status: "running", progress: { phase: "preparing", done: 0, total: 1 } });
    try {
      const { renderTimeline } = await import("../../../../lib/render/job");
      const outcome = await renderTimeline(timeline, { width: res.width, height: res.height, fps }, deps, { signal: ac.signal, onProgress: (progress) => setState((s) => (s.status === "running" ? { ...s, progress } : s)) });
      setState({ status: "done", outcome, url: URL.createObjectURL(outcome.blob) });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      setState(aborted ? { status: "idle" } : { status: "error", message: e instanceof RenderPlanError ? e.errors.join(" ") : (e as Error).message });
    } finally {
      abortRef.current = null;
    }
  };

  const p = state.progress;
  const report = state.outcome?.report;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption" data-testid="video-export">
      <div className="flex flex-wrap items-center gap-2">
        <Clapperboard className="h-4 w-4" />
        <span className="font-medium">Export video</span>
        <select aria-label="Output size" value={resId} onChange={(e) => setResId(e.target.value)} disabled={state.status === "running"} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5">
          {OUTPUT_RESOLUTIONS.map((r) => {
            const ok = sameShape.includes(r);
            return (
              <option key={r.id} value={r.id} disabled={!ok}>
                {r.label}
                {ok ? "" : " — different shape than the composition"}
              </option>
            );
          })}
        </select>
        <select aria-label="Frame rate" value={fps} onChange={(e) => setFps(Number(e.target.value) as OutputFrameRate)} disabled={state.status === "running"} className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5">
          {OUTPUT_FRAME_RATES.map((r) => (
            <option key={r} value={r}>
              {r} fps{r === timeline.frameRate ? " (project)" : ""}
            </option>
          ))}
        </select>
        {state.status === "running" ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1">
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        ) : (
          <button type="button" onClick={run} disabled={!res} className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
            Render MP4
          </button>
        )}
        {sameShape.length === 0 && <span className="text-danger-600">No output size matches this composition's shape ({comp.width}×{comp.height}).</span>}
      </div>

      {state.status === "running" && p && (
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            {PHASE_LABEL[p.phase]}
            {p.phase === "video" ? ` ${p.done} / ${p.total}` : ""}
          </span>
          <progress className="h-1.5 flex-1" max={1} value={p.total ? p.done / p.total : 0} />
        </div>
      )}

      {state.status === "error" && (
        <span className="text-danger-600" role="alert">
          {state.message}
        </span>
      )}

      {state.status === "done" && report && state.url && (
        <div className="flex flex-col gap-1" data-testid="video-export-report" data-ok={report.ok}>
          <div className="flex flex-wrap items-center gap-2">
            {report.ok ? <CheckCircle2 className="h-4 w-4 text-success-600" /> : <XCircle className="h-4 w-4 text-danger-600" />}
            <span className="font-medium">{report.ok ? "Rendered and validated" : "Rendered, but validation failed"}</span>
            <span className="tabular-nums text-(--color-text-muted)">
              {report.frameCount} frames · {report.durationSec.toFixed(2)} s · {report.codec} · {(report.bytes / 1e6).toFixed(1)} MB · {(report.renderMs / 1000).toFixed(1)} s
            </span>
            <a href={state.url} download={`render-${res?.id}-${fps}fps${report.ok ? "" : "-FAILED-VALIDATION"}.mp4`} className="underline">
              Download MP4
            </a>
          </div>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {report.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-1" data-check={c.id} data-ok={c.ok}>
                {c.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success-600" /> : <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger-600" />}
                <span>
                  <span className="font-medium">{c.label}:</span> <span className="text-(--color-text-muted)">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {report.warnings.map((w) => (
            <span key={w} className="flex items-start gap-1 text-warning-700">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
