import type { TimelineModel } from "../timeline/model";
import type { RenderSettings } from "../render/settings";
import type { RenderOutcome, RenderProgress } from "../render/job";

/**
 * EXPORT JOB SYSTEM (EXPORT_ARCHITECTURE.md §4).
 *
 *   queued ──▶ processing ──▶ completed      (the file was read back and EVERY validation check passed)
 *     │            ├────────▶ failed         (an error, or a file that failed validation — kept for inspection)
 *     └────────────┴────────▶ cancelled
 *
 * Jobs run one at a time, in order (the renderer's exact-frame decoders are shared). Each job renders a SNAPSHOT of
 * the timeline taken when it was queued, so editing while an export waits or runs never changes what it produces.
 * "completed" is decided from the validation report of the written file alone — never from the encoder returning
 * without an error.
 */

export type ExportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export const JOB_TRANSITIONS: Readonly<Record<ExportJobStatus, readonly ExportJobStatus[]>> = {
  queued: ["processing", "cancelled"],
  processing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const isTerminal = (s: ExportJobStatus) => JOB_TRANSITIONS[s].length === 0;

export interface JobProgress extends RenderProgress {
  /** 0..1 over the whole job (phases weighted by typical cost). */
  fraction: number;
  /** Estimated seconds left, from the frame rate so far (video phase onwards). */
  etaSec: number | null;
}

export interface ExportJob {
  id: string;
  /** Human label, e.g. "YouTube". */
  name: string;
  presetId: string;
  settings: RenderSettings;
  fileName: string;
  status: ExportJobStatus;
  progress: JobProgress | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Why it failed (error message, or the failed checks). */
  error?: string;
  /** Present when a file was written — also for a failed validation, so it can be inspected. */
  outcome?: RenderOutcome;
  /** Status history, for the report and tests. */
  history: ExportJobStatus[];
}

export type ExportRunner = (timeline: TimelineModel, settings: RenderSettings, opts: { signal: AbortSignal; onProgress: (p: RenderProgress) => void }) => Promise<RenderOutcome>;

/** Share of the whole job each phase stands for. */
const PHASE_WEIGHT: Record<RenderProgress["phase"], [number, number]> = {
  preparing: [0, 0.02],
  video: [0.02, 0.85],
  audio: [0.85, 0.9],
  finalizing: [0.9, 0.93],
  validating: [0.93, 1],
};

export function jobFraction(p: RenderProgress): number {
  const [a, b] = PHASE_WEIGHT[p.phase];
  return a + (b - a) * (p.total > 0 ? Math.min(1, p.done / p.total) : 0);
}

export class InvalidJobTransition extends Error {
  constructor(readonly from: ExportJobStatus, readonly to: ExportJobStatus) {
    super(`Export job can't go from ${from} to ${to}.`);
    this.name = "InvalidJobTransition";
  }
}

interface Internal {
  job: ExportJob;
  timeline: TimelineModel;
  abort: AbortController;
}

let nextId = 1;

export class ExportQueue {
  private readonly items: Internal[] = [];
  private readonly listeners = new Set<(jobs: readonly ExportJob[]) => void>();
  private running = false;
  private snapshot: readonly ExportJob[] = [];

  constructor(
    private readonly runner: ExportRunner,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get jobs(): readonly ExportJob[] {
    return this.snapshot;
  }

  get(id: string): ExportJob | undefined {
    return this.items.find((i) => i.job.id === id)?.job;
  }

  subscribe(fn: (jobs: readonly ExportJob[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  /** Queues an export of a snapshot of `timeline`. Returns the job id. */
  enqueue(input: { name: string; presetId: string; settings: RenderSettings; fileName: string; timeline: TimelineModel }): string {
    const id = `export-${nextId++}`;
    const job: ExportJob = { id, name: input.name, presetId: input.presetId, settings: { ...input.settings }, fileName: input.fileName, status: "queued", progress: null, createdAt: this.now(), history: ["queued"] };
    this.items.push({ job, timeline: snapshotTimeline(input.timeline), abort: new AbortController() });
    this.emit();
    void this.pump();
    return id;
  }

  /** Cancels a queued job (it never starts) or a processing one (the render is aborted). No-op once finished. */
  cancel(id: string): void {
    const it = this.items.find((i) => i.job.id === id);
    if (!it || isTerminal(it.job.status)) return;
    if (it.job.status === "queued") this.transition(it, "cancelled", { finishedAt: this.now() });
    else it.abort.abort();
  }

  /** Removes a finished job from the list. Active jobs must be cancelled first. */
  remove(id: string): void {
    const i = this.items.findIndex((x) => x.job.id === id);
    if (i < 0) return;
    if (!isTerminal(this.items[i].job.status)) throw new Error("Cancel the export before removing it.");
    this.items.splice(i, 1);
    this.emit();
  }

  /** Resolves when nothing is queued or processing. */
  async idle(): Promise<void> {
    while (this.items.some((i) => !isTerminal(i.job.status))) await new Promise((r) => setTimeout(r, 10));
  }

  private transition(it: Internal, to: ExportJobStatus, patch: Partial<ExportJob> = {}): void {
    const from = it.job.status;
    if (!JOB_TRANSITIONS[from].includes(to)) throw new InvalidJobTransition(from, to);
    it.job = { ...it.job, ...patch, status: to, history: [...it.job.history, to] };
    this.emit();
  }

  private update(it: Internal, patch: Partial<ExportJob>): void {
    it.job = { ...it.job, ...patch };
    this.emit();
  }

  private emit(): void {
    this.snapshot = this.items.map((i) => i.job);
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let it = this.nextQueued(); it; it = this.nextQueued()) await this.run(it);
    } finally {
      this.running = false;
    }
  }

  private nextQueued(): Internal | undefined {
    return this.items.find((i) => i.job.status === "queued");
  }

  private async run(it: Internal): Promise<void> {
    const startedAt = this.now();
    this.transition(it, "processing", { startedAt, progress: { phase: "preparing", done: 0, total: 1, fraction: 0, etaSec: null } });
    let videoStart: number | null = null;
    const onProgress = (p: RenderProgress) => {
      if (it.job.status !== "processing") return;
      const t = this.now();
      if (p.phase === "video" && videoStart === null) videoStart = t;
      const fraction = jobFraction(p);
      let etaSec: number | null = null;
      if (videoStart !== null && fraction > PHASE_WEIGHT.video[0] + 0.02) {
        const perUnit = (t - videoStart) / (fraction - PHASE_WEIGHT.video[0]);
        etaSec = Math.max(0, ((1 - fraction) * perUnit) / 1000);
      }
      this.update(it, { progress: { ...p, fraction, etaSec } });
    };
    try {
      const outcome = await this.runner(it.timeline, it.job.settings, { signal: it.abort.signal, onProgress });
      // A finished render that was cancelled meanwhile is still a cancellation: the user asked for no file.
      if (it.abort.signal.aborted) return this.transition(it, "cancelled", { finishedAt: this.now() });
      if (outcome.report.ok) {
        this.transition(it, "completed", { outcome, finishedAt: this.now(), progress: it.job.progress && { ...it.job.progress, fraction: 1, etaSec: 0 } });
      } else {
        const failed = outcome.report.checks.filter((c) => !c.ok);
        this.transition(it, "failed", { outcome, finishedAt: this.now(), error: `Validation failed: ${failed.map((c) => `${c.label} — ${c.detail}`).join("; ")}` });
      }
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError" || it.abort.signal.aborted;
      if (aborted) this.transition(it, "cancelled", { finishedAt: this.now() });
      else this.transition(it, "failed", { finishedAt: this.now(), error: errorMessage(e) });
    }
  }
}

function errorMessage(e: unknown): string {
  const errs = (e as { errors?: unknown })?.errors;
  if (Array.isArray(errs) && errs.every((x) => typeof x === "string")) return errs.join(" ");
  return e instanceof Error ? e.message : String(e);
}

/** A deep copy the editor can't mutate. Timelines are plain data. */
export function snapshotTimeline(tl: TimelineModel): TimelineModel {
  return typeof structuredClone === "function" ? structuredClone(tl) : JSON.parse(JSON.stringify(tl));
}

/** `render-youtube-1920x1080-30fps.mp4`; a file that failed validation is marked as such. */
export function exportFileName(presetId: string, s: Pick<RenderSettings, "width" | "height" | "fps" | "container">, failed = false): string {
  return `render-${presetId}-${s.width}x${s.height}-${s.fps}fps${failed ? "-FAILED-VALIDATION" : ""}.${s.container ?? "mp4"}`;
}
