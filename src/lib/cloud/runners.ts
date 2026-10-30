import type { Job } from "./db";
import type { EchoParams } from "./features";

/**
 * FEATURE RUNNERS (server-only): what the worker actually does for each feature. A runner returns its result plus the
 * REAL provider cost (which drives the global budget) and, optionally, the credits to charge (defaults to the
 * estimate; the database never charges more than was reserved). Throw RunnerError to fail — with `retry` for
 * transient problems (provider 5xx, timeouts), and the cost already incurred so the budget stays truthful.
 */

export interface RunnerOutput {
  result: unknown;
  costUsd: number;
  credits?: number;
}

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly costUsd = 0,
    readonly retry = false,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export type Runner = (job: Job) => Promise<RunnerOutput>;

export const RUNNERS: Record<string, Runner> = {
  /** M0 test feature: proves the pipeline end to end without spending anything. */
  async echo(job) {
    const p = job.params as EchoParams;
    if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
    if (p.fail) throw new RunnerError("Test failure requested.", 0, false);
    return { result: { text: [...p.text].reverse().join(""), at: new Date().toISOString() }, costUsd: 0 };
  },
};
