import { hostname } from "node:os";
import { claimJob, expiredUploads, failJob, isConnectionError, markUploadsCleared, redactOldJobs, requeueStale, settleJob, type Job } from "./db";
import { cloudConfig } from "./config";
import { RUNNERS, RunnerError } from "./runners";
import { deleteUploads, storageConfigured } from "./storage";

/**
 * JOB WORKER (server-only). Pulls queued jobs (cloud.claim_job — SKIP LOCKED, so several workers never take the same
 * job), runs the feature's runner with a timeout, then settles (charge actual credits) or fails (retry, or refund).
 * Housekeeping: jobs stuck "running" for 10 minutes go back to the queue, uploaded media older than 24 hours is
 * deleted from storage, and job content older than 30 days is wiped (only feature/time/credits/cost remain).
 *
 * By default it runs inside the web server process, started lazily on the first cloud API request (ensureWorker);
 * CLOUD_WORKER=off leaves it to a separate process.
 */

const POLL_MS = 1500;
/** While the database is unreachable, polls back off up to this (and the outage is logged once, not every poll). */
const MAX_BACKOFF_MS = 30_000;
const STALE_SEC = 600;
const UPLOAD_TTL_SEC = 24 * 3600;
/** The privacy page's promise: a job's content (what was sent, what came back) is wiped after 30 days. */
const JOB_CONTENT_TTL_SEC = 30 * 24 * 3600;
const RUN_TIMEOUT_MS = 9 * 60_000;

const id = `${hostname()}:${process.pid}`;
let started = false;

async function runOne(job: Job): Promise<void> {
  const runner = RUNNERS[job.feature];
  if (!runner) {
    await failJob(job.id, `No runner for "${job.feature}" on this server.`, 0, false);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      runner(job),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunnerError("Timed out.", 0, true)), RUN_TIMEOUT_MS);
      }),
    ]);
    await settleJob(job.id, out.credits ?? job.estCredits, out.costUsd, out.result);
  } catch (e) {
    const err = e instanceof RunnerError ? e : new RunnerError((e as Error).message || "Unexpected error", 0, true);
    await failJob(job.id, err.message, err.costUsd, err.retry).catch((x) => console.error("[cloud] couldn't record failure:", (x as Error).message));
  } finally {
    clearTimeout(timer);
  }
}

async function housekeeping(): Promise<void> {
  const n = await requeueStale(STALE_SEC);
  if (n) console.warn(`[cloud] re-queued ${n} stale job(s)`);
  await redactOldJobs(JOB_CONTENT_TTL_SEC);
  if (storageConfigured()) {
    const old = await expiredUploads(UPLOAD_TTL_SEC);
    if (old.length) {
      await deleteUploads(old.map((o) => o.path));
      await markUploadsCleared([...new Set(old.map((o) => o.jobId))]);
    }
  }
}

export async function workLoop(signal?: AbortSignal): Promise<void> {
  let lastHousekeeping = 0;
  let delay = POLL_MS;
  let outageSince = 0;
  while (!signal?.aborted) {
    try {
      if (Date.now() - lastHousekeeping > 60_000) {
        lastHousekeeping = Date.now();
        await housekeeping();
      }
      const job = await claimJob(id);
      if (outageSince) {
        console.info(`[cloud] database reachable again after ${Math.round((Date.now() - outageSince) / 1000)} s`);
        outageSince = 0;
      }
      delay = POLL_MS;
      if (job) {
        await runOne(job);
        continue; // drain the queue before sleeping
      }
    } catch (e) {
      if (isConnectionError(e)) {
        if (!outageSince) {
          outageSince = Date.now();
          console.warn(`[cloud] database unreachable (${(e as Error).message}); retrying with backoff`);
        }
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      } else {
        console.error("[cloud] worker error:", (e as Error).message);
      }
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Starts the in-process worker once per server process (no-op when CLOUD_WORKER=off or not configured). */
export function ensureWorker(): void {
  if (started) return;
  const c = cloudConfig();
  if (c.worker === "off" || !c.databaseUrl) return;
  started = true;
  void workLoop();
}
