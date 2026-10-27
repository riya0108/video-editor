import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

/**
 * CLOUD AI — BROWSER SIDE. Sign-in (Supabase Auth: email magic link), the account's daily credits, and submitting /
 * following cloud jobs through this site's /api/cloud routes. The browser never talks to the database: it only holds
 * its Supabase session, whose access token the server verifies on every request.
 */

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const TURNSTILE_SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined;

export const cloudAuthAvailable = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase: SupabaseClient | null = null;
export function auth(): SupabaseClient | null {
  if (!cloudAuthAvailable || typeof window === "undefined") return null;
  supabase ??= createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } });
  return supabase;
}

export async function currentSession(): Promise<Session | null> {
  const a = auth();
  if (!a) return null;
  const { data } = await a.auth.getSession();
  return data.session;
}

/** Sends a sign-in link to `email`; the link brings the user back to this page, signed in. */
export async function sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const a = auth();
  if (!a) return { ok: false, error: "Sign-in isn't set up on this site." };
  const { error } = await a.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}`, shouldCreateUser: true } });
  return error ? { ok: false, error: error.status === 429 ? "Too many sign-in emails — try again in a little while." : error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  await auth()?.auth.signOut();
}

export class CloudApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

/** fetch() against /api/cloud with the signed-in user's access token (if any). */
export async function cloudFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await currentSession();
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.access_token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const r = await fetch(`/api/cloud${path}`, { ...init, headers });
  const data = (await r.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!r.ok) throw new CloudApiError(data.error?.code ?? "server_error", data.error?.message ?? (r.status === 429 ? "Too many requests — slow down a little." : "Something went wrong."), r.status);
  return data as T;
}

export interface CloudMe {
  configured: boolean;
  signedIn: boolean;
  email?: string | null;
  credits?: { day: string; allowance: number; used: number; reserved: number; available: number; resetsInSec: number };
  features?: { id: string; label: string; requiresSignIn: boolean; uploadsMedia: boolean; available: boolean }[];
}

export interface CloudJob {
  id: string;
  feature: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  estCredits: number;
  chargedCredits: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const fetchMe = () => cloudFetch<CloudMe>("/me");

// ---------------------------------------------------------------------------
// Turnstile: one invisible challenge per job submission (script loaded on first use only)
// ---------------------------------------------------------------------------

type TurnstileApi = { render(el: HTMLElement, o: Record<string, unknown>): string; remove(id: string): void };
let turnstileScript: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const w = window as unknown as { turnstile?: TurnstileApi };
    if (w.turnstile) return resolve(w.turnstile);
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("Turnstile didn't load.")));
    s.onerror = () => reject(new Error("The human check couldn't load. Check your connection or ad blocker."));
    document.head.appendChild(s);
  });
  turnstileScript.catch(() => (turnstileScript = null));
  return turnstileScript;
}

/** Runs a Turnstile challenge and resolves with its token (or undefined when the site has no Turnstile key). */
export async function humanToken(): Promise<string | undefined> {
  if (!TURNSTILE_SITE_KEY) return undefined;
  const ts = await loadTurnstile();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:70";
  document.body.appendChild(host);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The human check timed out — please try again.")), 60_000);
      ts.render(host, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        callback: (t: string) => {
          clearTimeout(timer);
          resolve(t);
        },
        "error-callback": () => {
          clearTimeout(timer);
          reject(new Error("The human check failed — please try again."));
        },
      });
    });
  } finally {
    host.remove();
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function submitJob(feature: string, params: unknown, opts: { consent?: boolean; uploads?: string[] } = {}): Promise<CloudJob> {
  const turnstileToken = await humanToken();
  const { job } = await cloudFetch<{ job: CloudJob }>("/jobs", { method: "POST", body: JSON.stringify({ feature, params, consent: opts.consent ?? false, uploads: opts.uploads ?? [], turnstileToken }) });
  return job;
}

/** Polls a job until it finishes (succeeded / failed / cancelled). */
export async function waitForJob(id: string, onUpdate?: (j: CloudJob) => void, signal?: AbortSignal): Promise<CloudJob> {
  let delay = 800;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const { job } = await cloudFetch<{ job: CloudJob }>(`/jobs/${id}`);
    onUpdate?.(job);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return job;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(5000, delay * 1.4);
  }
}

export const cancelCloudJob = (id: string) => cloudFetch<{ cancelled: boolean }>(`/jobs/${id}`, { method: "DELETE" });
export const listCloudJobs = () => cloudFetch<{ jobs: CloudJob[] }>("/jobs");

// ---------------------------------------------------------------------------
// First-use consent, per feature (remembered in this browser)
// ---------------------------------------------------------------------------

const CONSENT_KEY = "clipbench.cloudConsent.v1";

export function hasConsent(feature: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "[]") as string[]).includes(feature);
  } catch {
    return false;
  }
}

export function rememberConsent(feature: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "[]") as string[];
    if (!list.includes(feature)) localStorage.setItem(CONSENT_KEY, JSON.stringify([...list, feature]));
  } catch {
    /* without storage the notice simply shows again next time */
  }
}
