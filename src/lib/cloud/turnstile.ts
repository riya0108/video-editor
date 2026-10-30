import { cloudConfig } from "./config";

/**
 * CLOUDFLARE TURNSTILE (server-only): every new cloud job must carry a fresh challenge token, verified here with
 * Cloudflare's siteverify API, so scripts can't drain the free budget. Without TURNSTILE_SECRET_KEY the check is
 * skipped (development) — the admin page and /api/cloud/me report that as a configuration problem.
 */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const secret = cloudConfig().turnstileSecret;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: "missing" };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== "unknown") body.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    const d = (await r.json()) as { success?: boolean; "error-codes"?: string[] };
    return d.success ? { ok: true } : { ok: false, error: (d["error-codes"] ?? []).join(",") || "failed" };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}
