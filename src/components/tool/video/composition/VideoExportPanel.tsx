import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Ban, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Clock, Download, Loader2, Trash2, TriangleAlert, XCircle } from "lucide-react";
import type { TimelineModel } from "../../../../lib/timeline/model";
import { AUDIO_BITRATES, codecLabel, CONTAINER_CODECS, OUTPUT_FRAME_RATES, OUTPUT_RESOLUTIONS, sameShape, type Framing, type OutputAudioCodec, type OutputContainer, type OutputVideoCodec } from "../../../../lib/render/settings";
import type { RenderDeps, RenderProgress } from "../../../../lib/render/job";
import { checkExportProfile, describeProfile, normalizeProfile, QUALITY_LABEL, resolvedVideoBitrate, type ExportProfile, type QualityLevel } from "../../../../lib/export/profile";
import { EXPORT_PRESETS, presetById, presetProfile, type PresetId } from "../../../../lib/export/presets";
import type { ExportSettingsState } from "../../../../lib/project/document";
import { exportFileName, ExportQueue, isTerminal, type ExportJob, type ExportJobStatus } from "../../../../lib/export/queue";

/**
 * EXPORT PANEL (EXPORT_ARCHITECTURE.md §6): presets, every encoding setting, and a queue of export jobs
 * (queued → processing → completed | failed | cancelled) with live progress, cancel, the validation report of the
 * file that was actually written, and download. "Completed" means every check on the read-back file passed.
 */

const PHASE_LABEL: Record<RenderProgress["phase"], string> = {
  preparing: "Preparing",
  video: "Rendering frames",
  audio: "Encoding audio",
  finalizing: "Writing file",
  validating: "Validating output",
};

const STATUS_STYLE: Record<ExportJobStatus, string> = {
  queued: "text-(--color-text-muted)",
  processing: "text-(--color-text)",
  completed: "text-success-600",
  failed: "text-danger-600",
  cancelled: "text-(--color-text-muted)",
};

const field = "rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5 disabled:opacity-50";

export default function VideoExportPanel({
  timeline,
  deps,
  initial,
  onSettingsChange,
}: {
  timeline: TimelineModel;
  deps: RenderDeps;
  /** Saved settings of the open project (Phase 17); null/absent = the YouTube preset. */
  initial?: ExportSettingsState | null;
  onSettingsChange?: (s: ExportSettingsState) => void;
}) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const queue = useMemo(
    () =>
      new ExportQueue(async (tl, settings, opts) => {
        const { renderTimeline } = await import("../../../../lib/render/job");
        return renderTimeline(tl, settings, depsRef.current, opts);
      }),
    [],
  );
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__exportQueue = queue;
  }, [queue]);
  const jobs = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => queue.jobs,
    () => queue.jobs,
  );

  const [presetId, setPresetId] = useState<PresetId>(() => (initial && presetById(initial.presetId) ? (initial.presetId as PresetId) : "youtube"));
  const [profile, setProfile] = useState<ExportProfile>(() => (initial && presetById(initial.presetId) ? initial.profile : presetProfile("youtube", timeline)));
  const [modified, setModified] = useState(() => !!initial?.modified);
  // Report real changes only (not re-renders, not the mount): the project is marked edited when export settings change.
  const reported = useRef(JSON.stringify({ presetId, profile, modified }));
  useEffect(() => {
    const now = JSON.stringify({ presetId, profile, modified });
    if (now === reported.current) return;
    reported.current = now;
    onSettingsChange?.({ presetId, profile, modified });
  }, [presetId, profile, modified]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = presetById(presetId)!;
  const choosePreset = (id: PresetId) => {
    setPresetId(id);
    setProfile(presetProfile(id, timeline));
    setModified(false);
  };
  const edit = (patch: Partial<ExportProfile>) => {
    setProfile((p) => normalizeProfile({ ...p, ...patch }));
    if (presetId !== "custom") setModified(true);
  };
  // The composition's shape or rate changed: rebuild an untouched preset so it stays right for the project.
  useEffect(() => {
    if (!modified) setProfile(presetProfile(presetId, timeline));
  }, [timeline.composition.width, timeline.composition.height, timeline.frameRate]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = checkExportProfile(timeline, profile, preset.guidance);
  const { width: cw, height: ch } = timeline.composition;
  const shapeDiffers = !sameShape(profile.width, profile.height, cw, ch);
  const allowed = CONTAINER_CODECS[profile.container];
  const name = `${preset.label}${modified ? " (modified)" : ""}`;
  const fpsChoices = [...new Set([...OUTPUT_FRAME_RATES, ...(Number.isInteger(timeline.frameRate) ? [timeline.frameRate] : [])])].sort((a, b) => a - b);

  const enqueue = () => {
    if (!check.ok) return;
    queue.enqueue({ name, presetId, settings: check.settings, fileName: exportFileName(presetId, check.settings), timeline });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption" data-testid="video-export">
      <div className="flex items-center gap-2">
        <Clapperboard className="h-4 w-4" />
        <span className="font-medium">Export video</span>
      </div>

      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Export preset">
        {EXPORT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === presetId}
            title={p.description}
            onClick={() => choosePreset(p.id)}
            data-preset={p.id}
            className={`rounded-md border px-2 py-1 ${p.id === presetId ? "border-(--color-text) bg-(--color-text) text-(--color-bg)" : "border-(--color-border)"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1" data-testid="export-settings">
        <label htmlFor="exp-w">Resolution</label>
        <div className="flex flex-wrap items-center gap-1">
          <input id="exp-w" aria-label="Width" type="number" min={16} max={4096} step={2} value={profile.width} onChange={(e) => edit({ width: Number(e.target.value) })} className={`${field} w-20`} />
          ×
          <input aria-label="Height" type="number" min={16} max={4096} step={2} value={profile.height} onChange={(e) => edit({ height: Number(e.target.value) })} className={`${field} w-20`} />
          <select aria-label="Standard size" value="" onChange={(e) => {
            const [w, h] = e.target.value.split("x").map(Number);
            if (w && h) edit({ width: w, height: h });
          }} className={field}>
            <option value="">Standard…</option>
            {OUTPUT_RESOLUTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
            <option value="1280x720">1280×720 (16:9 720p)</option>
            <option value="3840x2160">3840×2160 (16:9 4K)</option>
          </select>
        </div>

        {shapeDiffers && (
          <>
            <label htmlFor="exp-framing">Framing</label>
            <select id="exp-framing" value={profile.framing} onChange={(e) => edit({ framing: e.target.value as Framing })} className={field}>
              <option value="match">Same shape only (refuse)</option>
              <option value="fit">Fit — letterbox, nothing cropped</option>
              <option value="fill">Fill — crop to cover</option>
            </select>
          </>
        )}

        <label htmlFor="exp-fps">Frame rate</label>
        <select id="exp-fps" value={profile.fps} onChange={(e) => edit({ fps: Number(e.target.value) })} className={field}>
          {fpsChoices.map((r) => (
            <option key={r} value={r}>
              {r} fps{r === timeline.frameRate ? " (project)" : ""}
            </option>
          ))}
        </select>

        <label htmlFor="exp-container">Container</label>
        <select id="exp-container" value={profile.container} onChange={(e) => edit({ container: e.target.value as OutputContainer })} className={field}>
          <option value="mp4">MP4</option>
          <option value="mov">MOV (QuickTime)</option>
          <option value="webm">WebM</option>
        </select>

        <label htmlFor="exp-vcodec">Video codec</label>
        <select id="exp-vcodec" value={profile.videoCodec} onChange={(e) => edit({ videoCodec: e.target.value as OutputVideoCodec })} className={field}>
          {allowed.video.map((c) => (
            <option key={c} value={c}>
              {codecLabel(c)}
            </option>
          ))}
        </select>

        <label htmlFor="exp-rc">Quality</label>
        <div className="flex flex-wrap items-center gap-1">
          <select id="exp-rc" aria-label="Rate control" value={profile.rateControl} onChange={(e) => edit({ rateControl: e.target.value as ExportProfile["rateControl"], videoBitrate: resolvedVideoBitrate(profile) })} className={field}>
            <option value="quality">Quality level</option>
            <option value="bitrate">Target bitrate</option>
          </select>
          {profile.rateControl === "quality" ? (
            <select aria-label="Quality level" value={profile.quality} onChange={(e) => edit({ quality: e.target.value as QualityLevel })} className={field}>
              {(Object.keys(QUALITY_LABEL) as QualityLevel[]).map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABEL[q]}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input aria-label="Video bitrate (Mbit/s)" type="number" min={1} max={120} step={0.5} value={+(profile.videoBitrate / 1e6).toFixed(2)} onChange={(e) => edit({ videoBitrate: Math.round(Number(e.target.value) * 1e6) })} className={`${field} w-16`} />
              Mbit/s
            </>
          )}
          <select aria-label="Bitrate mode" value={profile.bitrateMode} onChange={(e) => edit({ bitrateMode: e.target.value as ExportProfile["bitrateMode"] })} className={field}>
            <option value="variable">VBR</option>
            <option value="constant">CBR</option>
          </select>
          <span className="tabular-nums text-(--color-text-muted)">≈ {(resolvedVideoBitrate(profile) / 1e6).toFixed(1)} Mbit/s</span>
        </div>

        <label htmlFor="exp-acodec">Audio</label>
        <div className="flex flex-wrap items-center gap-1">
          <select id="exp-acodec" aria-label="Audio codec" value={profile.audioCodec} onChange={(e) => edit({ audioCodec: e.target.value as OutputAudioCodec | "none" })} className={field}>
            {allowed.audio.map((c) => (
              <option key={c} value={c}>
                {codecLabel(c)}
              </option>
            ))}
            <option value="none">No audio</option>
          </select>
          <select aria-label="Audio bitrate" value={profile.audioBitrate} disabled={profile.audioCodec === "none"} onChange={(e) => edit({ audioBitrate: Number(e.target.value) })} className={field}>
            {AUDIO_BITRATES.map((b) => (
              <option key={b} value={b}>
                {b / 1000} kbit/s
              </option>
            ))}
          </select>
          <span className="text-(--color-text-muted)">48 kHz stereo</span>
        </div>

        {allowed.alpha.length > 0 && (
          <>
            <span>Transparency</span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={profile.alpha} disabled={!allowed.alpha.includes(profile.videoCodec)} onChange={(e) => edit({ alpha: e.target.checked })} />
              Keep alpha channel {allowed.alpha.includes(profile.videoCodec) ? "" : `(not with ${codecLabel(profile.videoCodec)})`}
            </label>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={enqueue} disabled={!check.ok} data-testid="export-enqueue" className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
          Export {profile.container.toUpperCase()}
        </button>
        <span className="tabular-nums text-(--color-text-muted)">{describeProfile(profile)}</span>
      </div>
      {check.errors.map((e) => (
        <span key={e} className="text-danger-600" role="alert">
          {e}
        </span>
      ))}
      {check.warnings.map((w) => (
        <span key={w} className="flex items-start gap-1 text-warning-700">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
        </span>
      ))}

      {jobs.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-(--color-border) pt-2" data-testid="export-jobs" aria-label="Export jobs">
          {[...jobs].reverse().map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => queue.cancel(j.id)} onRemove={() => queue.remove(j.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({ job, onCancel, onRemove }: { job: ExportJob; onCancel: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const report = job.outcome?.report;
  const p = job.progress;
  const Icon = { queued: Clock, processing: Loader2, completed: CheckCircle2, failed: XCircle, cancelled: Ban }[job.status];
  const download = () => {
    if (!job.outcome) return;
    const url = URL.createObjectURL(job.outcome.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = job.status === "completed" ? job.fileName : job.fileName.replace(/(\.\w+)$/, "-FAILED-VALIDATION$1");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <li className="flex flex-col gap-1" data-job={job.id} data-status={job.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={`h-3.5 w-3.5 ${STATUS_STYLE[job.status]} ${job.status === "processing" ? "animate-spin" : ""}`} />
        <span className="font-medium">{job.name}</span>
        <span className={`uppercase tracking-wide ${STATUS_STYLE[job.status]}`} data-testid="job-status">
          {job.status}
        </span>
        <span className="tabular-nums text-(--color-text-muted)">
          {job.settings.width}×{job.settings.height} · {job.settings.fps} fps · {(job.settings.container ?? "mp4").toUpperCase()}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!isTerminal(job.status) && (
            <button type="button" onClick={onCancel} className="rounded border border-(--color-border) px-1.5 py-0.5">
              Cancel
            </button>
          )}
          {job.outcome && (
            <button type="button" onClick={download} className="flex items-center gap-1 rounded border border-(--color-border) px-1.5 py-0.5" title={job.status === "completed" ? job.fileName : "Failed validation — download for inspection"}>
              <Download className="h-3 w-3" /> {job.status === "completed" ? "Download" : "Download (failed)"}
            </button>
          )}
          {isTerminal(job.status) && (
            <button type="button" onClick={onRemove} aria-label="Remove from list" className="rounded border border-(--color-border) p-0.5">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>

      {job.status === "processing" && p && (
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <span className="w-44 shrink-0">
            {PHASE_LABEL[p.phase]}
            {p.phase === "video" ? ` ${p.done} / ${p.total}` : ""}
          </span>
          <progress className="h-1.5 flex-1" max={1} value={p.fraction} />
          <span className="w-24 shrink-0 text-right tabular-nums">
            {Math.round(p.fraction * 100)}%{p.etaSec !== null ? ` · ${Math.ceil(p.etaSec)} s left` : ""}
          </span>
        </div>
      )}

      {job.status === "failed" && job.error && (
        <span className="text-danger-600" role="alert">
          {job.error}
        </span>
      )}

      {report && (
        <div className="flex flex-col gap-1" data-testid="video-export-report" data-ok={report.ok}>
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-left">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="tabular-nums text-(--color-text-muted)">
              {report.checks.filter((c) => c.ok).length}/{report.checks.length} checks passed · {report.frameCount} frames · {report.durationSec.toFixed(2)} s · {report.codec} · {(report.bytes / 1e6).toFixed(2)} MB · rendered in {(report.renderMs / 1000).toFixed(1)} s
            </span>
          </button>
          {open && (
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
          )}
          {report.warnings.map((w) => (
            <span key={w} className="flex items-start gap-1 text-warning-700">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
