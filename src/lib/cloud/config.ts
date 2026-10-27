import { serverEnv } from "../server-env";

/**
 * CLOUD CONFIG (server-only) — Phase 4 M0 defaults approved 2026-10-27 (PHASE4_PLAN.md §2, §7):
 * 50 credits/day signed in, 10 without an account, $25/day global cap (stored in the database so the admin page can
 * change it live), at most 2 jobs in flight per user. 1 credit = $0.01 of provider cost.
 */
export const CREDIT_USD = 0.01;

export interface CloudConfig {
  databaseUrl?: string;
  supabaseUrl?: string;
  publishableKey?: string;
  /** Supabase secret (service) key — only for Storage (uploads). */
  secretKey?: string;
  turnstileSecret?: string;
  adminToken?: string;
  anonSalt: string;
  dailyCreditsSignedIn: number;
  dailyCreditsAnon: number;
  maxActiveJobs: number;
  devFeatures: boolean;
  /** "inline" (default): the server process also runs the job worker. "off": a separate worker process does. */
  worker: "inline" | "off";
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : d;
};

export function cloudConfig(): CloudConfig {
  return {
    databaseUrl: serverEnv("CLOUD_DATABASE_URL"),
    supabaseUrl: serverEnv("PUBLIC_SUPABASE_URL"),
    publishableKey: serverEnv("PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    secretKey: serverEnv("SUPABASE_SECRET_KEY"),
    turnstileSecret: serverEnv("TURNSTILE_SECRET_KEY"),
    adminToken: serverEnv("CLOUD_ADMIN_TOKEN"),
    anonSalt: serverEnv("ANON_KEY_SALT") ?? "clipbench-anon-dev-salt",
    dailyCreditsSignedIn: int(serverEnv("CLOUD_DAILY_CREDITS"), 50),
    dailyCreditsAnon: int(serverEnv("CLOUD_DAILY_CREDITS_ANON"), 10),
    maxActiveJobs: int(serverEnv("CLOUD_MAX_ACTIVE_JOBS"), 2),
    devFeatures: serverEnv("PUBLIC_CLOUD_DEV_FEATURES") === "true",
    worker: serverEnv("CLOUD_WORKER") === "off" ? "off" : "inline",
  };
}

/** What's missing for the cloud features to work at all (shown on the admin page and in /api/cloud/me). */
export function cloudConfigProblems(c = cloudConfig()): string[] {
  const p: string[] = [];
  if (!c.databaseUrl) p.push("CLOUD_DATABASE_URL is not set");
  if (!c.supabaseUrl || !c.publishableKey) p.push("PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set (sign-in won't work)");
  if (!c.turnstileSecret) p.push("TURNSTILE_SECRET_KEY is not set (bot protection is off)");
  if (!c.adminToken) p.push("CLOUD_ADMIN_TOKEN is not set (the admin page is locked)");
  if (!c.secretKey) p.push("SUPABASE_SECRET_KEY is not set (features that upload media are unavailable)");
  if (!serverEnv("ANON_KEY_SALT")) p.push("ANON_KEY_SALT is not set (a built-in development salt is used)");
  return p;
}
