import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { cloudConfig } from "./config";
import { serverEnv } from "../server-env";

/**
 * CLOUD DATABASE ACCESS (server-only). Connects as the least-privilege `clipbench_server` role through Supabase's
 * transaction pooler; that role can only EXECUTE the `cloud.*` functions (supabase/migrations/*_cloud_m0.sql), so every
 * credit and budget rule is enforced inside the database, atomically. TLS is verified against Supabase's root CA
 * (bundled at supabase/prod-ca-2021.crt; override with CLOUD_DATABASE_CA_FILE).
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  userKey: string;
  userId: string | null;
  feature: string;
  status: JobStatus;
  params: unknown;
  consent: boolean;
  uploadPaths: string[];
  creditDay: string;
  estCredits: number;
  estUsd: number;
  chargedCredits: number;
  costUsd: number;
  result: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Balance {
  day: string;
  allowance: number;
  used: number;
  reserved: number;
  available: number;
}

/** Codes the database raises; anything else is an unexpected server error. */
export type CloudErrorCode = "cloud_paused" | "invalid_estimate" | "too_many_active_jobs" | "insufficient_credits" | "daily_budget_reached" | "job_not_running" | "unknown_setting" | "not_configured";

export class CloudError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CloudError";
  }
}

const KNOWN: CloudErrorCode[] = ["cloud_paused", "invalid_estimate", "too_many_active_jobs", "insufficient_credits", "daily_budget_reached", "job_not_running", "unknown_setting"];

// DATE columns as the literal 'YYYY-MM-DD' the database holds. node-postgres's default turns them into a Date at LOCAL
// midnight, which reads as the previous day anywhere east of UTC (credit days are UTC days).
pg.types.setTypeParser(1082, (v: string) => v);

let pool: pg.Pool | null = null;

function caCert(): string | undefined {
  const file = serverEnv("CLOUD_DATABASE_CA_FILE") ?? join(process.cwd(), "supabase", "prod-ca-2021.crt");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export function cloudDb(url = cloudConfig().databaseUrl): pg.Pool {
  if (!url) throw new CloudError("not_configured", "Cloud features aren't configured on this server.");
  if (!pool) {
    const ca = caCert();
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // The worker polls often enough that a connection is never idle, so without these one could live for days and
      // fail (ECONNRESET / ETIMEDOUT) the first time it's used after the pooler or network silently dropped it.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      maxLifetimeSeconds: 300,
      ssl: local ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
    });
    pool.on("error", (e) => console.error("[cloud] database pool error:", e.message));
  }
  return pool;
}

/** True for errors that mean "the database connection broke", as opposed to a query that failed. */
export function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "57P01"].includes(code)) return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test((e as Error)?.message ?? "");
}

/** Test-only: close and forget the pool. */
export async function closeCloudDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

async function call<T>(sql: string, args: unknown[], db = cloudDb()): Promise<T[]> {
  try {
    const r = await db.query(sql, args);
    return r.rows as T[];
  } catch (e) {
    const msg = (e as Error).message;
    const code = KNOWN.find((k) => msg === k || msg.startsWith(`${k}`));
    if (code) throw new CloudError(code);
    throw e;
  }
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "string" ? Number(v) : (v as number));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function toJob(r: Row): Job {
  return {
    id: r.id as string,
    userKey: r.user_key as string,
    userId: (r.user_id as string) ?? null,
    feature: r.feature as string,
    status: r.status as JobStatus,
    params: r.params,
    consent: !!r.consent,
    uploadPaths: (r.upload_paths as string[]) ?? [],
    creditDay: day(r.credit_day),
    estCredits: num(r.est_credits),
    estUsd: num(r.est_usd),
    chargedCredits: num(r.charged_credits),
    costUsd: num(r.cost_usd),
    result: r.result ?? null,
    error: (r.error as string) ?? null,
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export async function reserveJob(o: { userKey: string; userId: string | null; feature: string; params: unknown; credits: number; usd: number; allowance: number; maxActive: number; consent: boolean; uploadPaths: string[] }, db?: pg.Pool): Promise<Job> {
  const rows = await call<Row>("select * from cloud.reserve_job($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)", [o.userKey, o.userId, o.feature, JSON.stringify(o.params ?? {}), o.credits, o.usd, o.allowance, o.maxActive, o.consent, o.uploadPaths], db);
  return toJob(rows[0]);
}

export async function claimJob(worker: string, db?: pg.Pool): Promise<Job | null> {
  const rows = await call<Row>("select * from cloud.claim_job($1)", [worker], db);
  return rows[0]?.id ? toJob(rows[0]) : null;
}

export async function settleJob(id: string, credits: number, costUsd: number, result: unknown, db?: pg.Pool): Promise<Job> {
  const rows = await call<Row>("select * from cloud.settle_job($1, $2, $3, $4::jsonb)", [id, credits, costUsd, JSON.stringify(result ?? null)], db);
  return toJob(rows[0]);
}

export async function failJob(id: string, error: string, costUsd: number, retry: boolean, db?: pg.Pool): Promise<Job> {
  const rows = await call<Row>("select * from cloud.fail_job($1, $2, $3, $4)", [id, error.slice(0, 500), costUsd, retry], db);
  return toJob(rows[0]);
}

export async function cancelJob(id: string, userKey: string, db?: pg.Pool): Promise<boolean> {
  const rows = await call<{ cancel_job: boolean }>("select cloud.cancel_job($1, $2)", [id, userKey], db);
  return !!rows[0]?.cancel_job;
}

export async function requeueStale(olderThanSec: number, db?: pg.Pool): Promise<number> {
  const rows = await call<{ requeue_stale: number }>("select cloud.requeue_stale(make_interval(secs => $1))", [olderThanSec], db);
  return num(rows[0]?.requeue_stale ?? 0);
}

export async function getBalance(userKey: string, allowance: number, db?: pg.Pool): Promise<Balance> {
  const [r] = await call<Row>("select * from cloud.get_balance($1, $2)", [userKey, allowance], db);
  return { day: day(r.day), allowance: num(r.allowance), used: num(r.used), reserved: num(r.reserved), available: num(r.available) };
}

export async function getJob(id: string, userKey: string, db?: pg.Pool): Promise<Job | null> {
  const rows = await call<Row>("select * from cloud.get_job($1, $2)", [id, userKey], db);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(userKey: string, limit = 20, db?: pg.Pool): Promise<Job[]> {
  return (await call<Row>("select * from cloud.list_jobs($1, $2)", [userKey, limit], db)).map(toJob);
}

export async function expiredUploads(olderThanSec: number, db?: pg.Pool): Promise<{ jobId: string; path: string }[]> {
  return (await call<{ job_id: string; path: string }>("select * from cloud.expired_uploads(make_interval(secs => $1))", [olderThanSec], db)).map((r) => ({ jobId: r.job_id, path: r.path }));
}

export async function markUploadsCleared(jobIds: string[], db?: pg.Pool): Promise<number> {
  const rows = await call<{ mark_uploads_cleared: number }>("select cloud.mark_uploads_cleared($1::uuid[])", [jobIds], db);
  return num(rows[0]?.mark_uploads_cleared ?? 0);
}

export async function redactOldJobs(olderThanSec: number, db?: pg.Pool): Promise<number> {
  const rows = await call<{ redact_old_jobs: number }>("select cloud.redact_old_jobs(make_interval(secs => $1))", [olderThanSec], db);
  return num(rows[0]?.redact_old_jobs ?? 0);
}

export async function setSetting(key: "ai_enabled" | "global_daily_budget_usd", value: boolean | number, db?: pg.Pool): Promise<void> {
  await call("select cloud.set_setting($1, $2::jsonb)", [key, JSON.stringify(value)], db);
}

export async function adminSpend(days = 14, db?: pg.Pool): Promise<AdminSpend> {
  const [r] = await call<{ admin_spend: AdminSpend }>("select cloud.admin_spend($1)", [days], db);
  return r.admin_spend;
}

export interface AdminSpend {
  settings: { ai_enabled?: boolean; global_daily_budget_usd?: number };
  today: string;
  days: { day: string; cap_usd: number; reserved_usd: number; spent_usd: number }[];
  by_feature: { day: string; feature: string; jobs: number; succeeded: number; failed: number; credits: number; cost_usd: number }[];
  by_hour_today: { hour: number; cost_usd: number; jobs: number }[];
  queue: { queued: number; running: number };
}
