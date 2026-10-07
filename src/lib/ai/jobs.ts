import { AIError, isAbort, toAIError } from "./errors";
import type { AIRequest, AIServices } from "./provider";
import type { AnyProvider } from "./registry";
import type { AIFeatureId, AIJobStatus, AIResult } from "./types";

/**
 * AI JOB SYSTEM (AI_EDITING_ARCHITECTURE.md §4).
 *
 *   queued -> processing -> completed | failed | cancelled
 *   queued -> cancelled            (cancelled before it started)
 *   failed | cancelled -> queued   (retry: a NEW attempt of the same request)
 *
 * Jobs run FIFO with bounded concurrency (default 1: the models compete for the same GPU/CPU). Cancellation aborts
 * the provider's signal; a provider that finishes anyway after the abort is still reported as cancelled (its output
 * is discarded — the user asked to stop). Every failure is an AIError with a code. A job never produces a result
 * without the provider actually returning one.
 */

export interface AIJob {
  id: string;
  feature: AIFeatureId;
  providerId: string;
  clipId: string;
  label: string;
  status: AIJobStatus;
  /** 0..1 */
  progress: number;
  stage?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: { code: AIError["code"]; message: string; retryable: boolean };
  resultId?: string;
  attempt: number;
}

type Listener = (job: AIJob) => void;

interface Entry {
  job: AIJob;
  provider: AnyProvider;
  request: AIRequest;
  controller: AbortController;
}

let jobCounter = 0;

export class AIJobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<Listener>();
  private running = 0;

  constructor(
    private readonly services: AIServices,
    private readonly onResult: (result: AIResult) => void,
    private readonly opts: { concurrency?: number; timeoutMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(job: AIJob) {
    for (const l of this.listeners) l({ ...job });
  }

  get jobs(): AIJob[] {
    return this.order.map((id) => ({ ...this.entries.get(id)!.job }));
  }

  job(id: string): AIJob | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.job } : undefined;
  }

  /** Queues a request. Returns the job id immediately. */
  submit(provider: AnyProvider, request: AIRequest, label = provider.label): string {
    jobCounter += 1;
    const id = `aijob-${jobCounter}`;
    const job: AIJob = { id, feature: provider.feature, providerId: provider.id, clipId: request.clipId, label, status: "queued", progress: 0, createdAt: this.now(), attempt: 1 };
    this.entries.set(id, { job, provider, request, controller: new AbortController() });
    this.order.push(id);
    this.emit(job);
    queueMicrotask(() => this.pump());
    return id;
  }

  cancel(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.job.status === "queued") {
      this.finish(e, "cancelled", { error: new AIError("cancelled", "Cancelled before it started.") });
    } else if (e.job.status === "processing") {
      e.controller.abort();
    }
  }

  /** Re-queues a failed or cancelled job (same request, fresh signal). */
  retry(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || (e.job.status !== "failed" && e.job.status !== "cancelled")) return false;
    e.controller = new AbortController();
    e.job = { ...e.job, status: "queued", progress: 0, stage: undefined, error: undefined, startedAt: undefined, finishedAt: undefined, resultId: undefined, attempt: e.job.attempt + 1 };
    this.emit(e.job);
    queueMicrotask(() => this.pump());
    return true;
  }

  /** Drops finished jobs from the list (results stay in the store). */
  clearFinished(): void {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.entries.get(this.order[i])!;
      if (e.job.status === "completed" || e.job.status === "failed" || e.job.status === "cancelled") {
        this.entries.delete(this.order[i]);
        this.order.splice(i, 1);
      }
    }
  }

  /** Resolves when the job reaches a terminal status. */
  wait(id: string): Promise<AIJob> {
    return new Promise((resolve) => {
      const check = (j?: AIJob) => {
        const job = j ?? this.job(id);
        if (job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")) {
          off();
          resolve(job);
        }
      };
      const off = this.subscribe((j) => j.id === id && check(j));
      check();
    });
  }

  private pump() {
    const max = this.opts.concurrency ?? 1;
    while (this.running < max) {
      const next = this.order.map((id) => this.entries.get(id)!).find((e) => e.job.status === "queued");
      if (!next) return;
      void this.start(next);
    }
  }

  private async start(e: Entry) {
    this.running++;
    e.job = { ...e.job, status: "processing", startedAt: this.now(), progress: 0 };
    this.emit(e.job);
    const t0 = this.now();
    const signal = e.controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (this.opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        e.controller.abort();
      }, this.opts.timeoutMs);
    }
    try {
      const out = await e.provider.run(e.request, {
        signal,
        services: this.services,
        progress: (fraction, stage) => {
          if (e.job.status !== "processing") return;
          e.job = { ...e.job, progress: Math.min(1, Math.max(0, fraction)), stage };
          this.emit(e.job);
        },
      });
      if (signal.aborted) throw new AIError(timedOut ? "timeout" : "cancelled", timedOut ? "Timed out." : "Cancelled.");
      const result: AIResult = {
        id: `airesult-${e.job.id}-${e.job.attempt}`,
        feature: e.provider.feature,
        providerId: e.provider.id,
        providerKind: e.provider.kind,
        ...(e.provider.model ? { model: e.provider.model } : {}),
        target: { clipId: e.request.clipId, sourceId: e.request.sourceId, sourceStart: e.request.media.sourceStart, sourceEnd: e.request.media.sourceEnd },
        createdAt: this.now(),
        items: out.items,
        warnings: out.warnings,
        metrics: { durationMs: this.now() - t0, ...(out.metrics ?? {}) },
        params: out.params ?? e.request.params,
      };
      this.onResult(result);
      this.finish(e, "completed", { resultId: result.id });
    } catch (err) {
      const ai = timedOut ? new AIError("timeout", `Timed out after ${Math.round((this.opts.timeoutMs ?? 0) / 1000)} s.`) : toAIError(err);
      this.finish(e, isAbort(err) && !timedOut ? "cancelled" : ai.code === "cancelled" ? "cancelled" : "failed", { error: ai });
    } finally {
      if (timer) clearTimeout(timer);
      this.running--;
      this.pump();
    }
  }

  private finish(e: Entry, status: AIJobStatus, extra: { resultId?: string; error?: AIError }) {
    e.job = {
      ...e.job,
      status,
      finishedAt: this.now(),
      ...(status === "completed" ? { progress: 1 } : {}),
      ...(extra.resultId ? { resultId: extra.resultId } : {}),
      ...(extra.error ? { error: { code: extra.error.code, message: extra.error.message, retryable: extra.error.retryable } } : {}),
    };
    this.emit(e.job);
  }
}
