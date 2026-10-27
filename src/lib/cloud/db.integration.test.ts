import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminSpend, cancelJob, claimJob, CloudError, failJob, getBalance, getJob, requeueStale, reserveJob, setSetting, settleJob, type Job } from "./db";

/**
 * CREDIT/JOB INVARIANTS against a REAL Postgres with the cloud migration applied, as the least-privilege server role.
 * Skipped unless CLOUD_TEST_DATABASE_URL is set. Use a DEVELOPMENT project only: it briefly changes the global cap and
 * the kill switch (restoring them), and must not run while a worker is consuming the same queue.
 *
 *   CLOUD_TEST_DATABASE_URL="$(grep ^CLOUD_DATABASE_URL .env | cut -d= -f2-)" npx vitest run src/lib/cloud/db.integration.test.ts
 */
const url = process.env.CLOUD_TEST_DATABASE_URL;
const run = `t${Date.now().toString(36)}`;
let db: pg.Pool;

const reserve = (userKey: string, credits: number, o: Partial<{ usd: number; allowance: number; maxActive: number }> = {}) =>
  reserveJob({ userKey, userId: null, feature: "echo", params: { text: "x" }, credits, usd: o.usd ?? 0, allowance: o.allowance ?? 10, maxActive: o.maxActive ?? 100, consent: false, uploadPaths: [] }, db);

/** Claims until it gets this test's job (other runs' leftovers may sit in the queue). */
async function claimMine(id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const j = await claimJob(`test-${run}`, db);
    if (!j) break;
    if (j.id === id) return j;
    await failJob(j.id, "claimed by test cleanup", 0, false, db); // not ours: fail it so it leaves the queue
  }
  throw new Error("couldn't claim the test job");
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof CloudError ? e.code : (e as Error).message;
  }
};

describe.skipIf(!url)("cloud database (real Postgres)", () => {
  beforeAll(() => {
    db = new pg.Pool({ connectionString: url, max: 20, ssl: { ca: readFileSync(join(process.cwd(), "supabase", "prod-ca-2021.crt"), "utf8"), rejectUnauthorized: true } });
  });
  afterAll(async () => {
    await setSetting("ai_enabled", true, db).catch(() => {});
    await setSetting("global_daily_budget_usd", 25, db).catch(() => {});
    await db.end();
  });

  it("concurrent submissions can never overdraw: 25 at once against 10 credits -> exactly 10 succeed", async () => {
    const user = `test:${run}:race`;
    const results = await Promise.all(Array.from({ length: 25 }, () => code(reserve(user, 1))));
    expect(results.filter((r) => r === "ok")).toHaveLength(10);
    expect(results.filter((r) => r === "insufficient_credits")).toHaveLength(15);
    const b = await getBalance(user, 10, db);
    expect(b).toMatchObject({ allowance: 10, reserved: 10, used: 0, available: 0 });
    // Leave the queue clean for the next tests.
    const jobs = await db.query("select * from cloud.list_jobs($1, 100)", [user]);
    for (const j of jobs.rows) await cancelJob(j.id, user, db);
    expect((await getBalance(user, 10, db)).available).toBe(10);
  }, 60_000);

  it("limits jobs in flight per user", async () => {
    const user = `test:${run}:active`;
    expect(await code(reserve(user, 1, { maxActive: 2 }))).toBe("ok");
    expect(await code(reserve(user, 1, { maxActive: 2 }))).toBe("ok");
    expect(await code(reserve(user, 1, { maxActive: 2 }))).toBe("too_many_active_jobs");
    const jobs = await db.query("select * from cloud.list_jobs($1, 100)", [user]);
    for (const j of jobs.rows) await cancelJob(j.id, user, db);
  });

  it("success charges the actual credits, never more than reserved", async () => {
    const user = `test:${run}:settle`;
    const j = await reserve(user, 5);
    await claimMine(j.id);
    const done = await settleJob(j.id, 9, 0.002, { text: "done" }, db);
    expect(done).toMatchObject({ status: "succeeded", chargedCredits: 5, result: { text: "done" } });
    expect(await getBalance(user, 10, db)).toMatchObject({ used: 5, reserved: 0, available: 5 });
    expect(await code(settleJob(j.id, 1, 0, null, db))).toBe("job_not_running");
  });

  it("failure retries keep the reservation; the final failure refunds in full", async () => {
    const user = `test:${run}:fail`;
    const j = await reserve(user, 4);
    await claimMine(j.id);
    const retried = await failJob(j.id, "provider 503", 0.001, true, db);
    expect(retried.status).toBe("queued");
    expect((await getBalance(user, 10, db)).reserved).toBe(4);
    await claimMine(j.id);
    const failed = await failJob(j.id, "provider 503", 0.001, false, db);
    expect(failed).toMatchObject({ status: "failed", costUsd: 0.002 });
    expect(await getBalance(user, 10, db)).toMatchObject({ used: 0, reserved: 0, available: 10 });
  });

  it("cancelling refunds a queued job, but not one already running; users can't see others' jobs", async () => {
    const user = `test:${run}:cancel`;
    const a = await reserve(user, 2);
    expect(await cancelJob(a.id, `test:${run}:someone-else`, db)).toBe(false);
    expect(await getJob(a.id, `test:${run}:someone-else`, db)).toBeNull();
    expect(await cancelJob(a.id, user, db)).toBe(true);
    expect((await getBalance(user, 10, db)).available).toBe(10);
    const b = await reserve(user, 2);
    await claimMine(b.id);
    expect(await cancelJob(b.id, user, db)).toBe(false);
    await settleJob(b.id, 2, 0, null, db);
  });

  it("a worker that dies mid-job: the job goes back to the queue", async () => {
    const user = `test:${run}:stale`;
    const j = await reserve(user, 1);
    await claimMine(j.id);
    expect(await requeueStale(0, db)).toBeGreaterThanOrEqual(1);
    expect((await getJob(j.id, user, db))?.status).toBe("queued");
    await cancelJob(j.id, user, db);
  });

  it("the global daily cap and the kill switch stop new jobs", async () => {
    const user = `test:${run}:cap`;
    const s = await adminSpend(1, db);
    const today = s.days.find((d) => d.day === s.today);
    const committed = today ? Number(today.reserved_usd) + Number(today.spent_usd) : 0;
    await setSetting("global_daily_budget_usd", committed + 0.05, db);
    try {
      const ok = await reserve(user, 1, { usd: 0.04 });
      expect(await code(reserve(user, 1, { usd: 0.04 }))).toBe("daily_budget_reached");
      await cancelJob(ok.id, user, db);
      expect(await code(reserve(user, 1, { usd: 0.04 }))).toBe("ok"); // the cancel released its budget
      await setSetting("ai_enabled", false, db);
      expect(await code(reserve(user, 1))).toBe("cloud_paused");
    } finally {
      await setSetting("ai_enabled", true, db);
      await setSetting("global_daily_budget_usd", 25, db);
      const jobs = await db.query("select * from cloud.list_jobs($1, 100)", [user]);
      for (const j of jobs.rows) await cancelJob(j.id, user, db);
    }
  });

  it("the server role can't touch the tables directly", async () => {
    expect(await code(db.query("select * from cloud.jobs limit 1"))).toMatch(/permission denied/);
    expect(await code(db.query("update cloud.credit_days set used = 0"))).toMatch(/permission denied/);
  });
});
