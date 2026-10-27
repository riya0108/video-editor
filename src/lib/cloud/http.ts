import { CloudError } from "./db";
import type { Job } from "./db";

/** JSON responses and user-facing messages for the cloud API routes (server-only). */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export type ApiErrorCode =
  | "insufficient_credits"
  | "daily_budget_reached"
  | "cloud_paused"
  | "too_many_active_jobs"
  | "not_configured"
  | "sign_in_required"
  | "consent_required"
  | "turnstile_failed"
  | "invalid_params"
  | "unknown_feature"
  | "upload_not_allowed"
  | "storage_not_configured"
  | "not_found"
  | "unauthorized"
  | "server_error";

const MESSAGES: Record<ApiErrorCode, [number, string]> = {
  insufficient_credits: [402, "You've used today's free credits. They refill at 00:00 UTC."],
  daily_budget_reached: [503, "Today's free AI budget for the whole site is used up. It resets at 00:00 UTC — editing on your device keeps working."],
  cloud_paused: [503, "Cloud AI features are paused right now. Editing on your device keeps working."],
  too_many_active_jobs: [429, "You already have jobs running — wait for one to finish."],
  not_configured: [503, "Cloud AI features aren't set up on this server."],
  sign_in_required: [401, "Sign in to use this feature."],
  consent_required: [400, "Please confirm the upload notice first."],
  turnstile_failed: [403, "We couldn't verify you're human. Please try again."],
  invalid_params: [400, "That request isn't valid."],
  unknown_feature: [404, "That feature isn't available."],
  upload_not_allowed: [403, "That upload doesn't belong to you."],
  storage_not_configured: [503, "Uploads aren't set up on this server."],
  not_found: [404, "Not found."],
  unauthorized: [401, "Not authorized."],
  server_error: [500, "Something went wrong on our side. Your credits weren't charged."],
};

export function apiError(code: ApiErrorCode, message?: string): Response {
  const [status, text] = MESSAGES[code];
  return json({ error: { code, message: message ?? text } }, status);
}

/** Maps a thrown error to a response; unexpected errors are logged and never leak details. */
export function fromError(e: unknown): Response {
  if (e instanceof CloudError && e.code in MESSAGES) return apiError(e.code as ApiErrorCode);
  console.error("[cloud] unexpected error:", e);
  return apiError("server_error");
}

/** What the browser may see of a job (no internal keys or provider costs). */
export function publicJob(j: Job) {
  return {
    id: j.id,
    feature: j.feature,
    status: j.status,
    estCredits: j.estCredits,
    chargedCredits: j.chargedCredits,
    result: j.status === "succeeded" ? j.result : null,
    error: j.status === "failed" ? j.error : null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  };
}

/** Seconds until the next 00:00 UTC (credit reset). */
export function secondsUntilReset(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}
