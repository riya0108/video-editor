import { randomUUID } from "node:crypto";
import { cloudConfig } from "./config";

/**
 * CLOUD UPLOADS (server-only) — media a cloud feature needs (voice samples, video to dub or lip-sync) goes to the
 * PRIVATE Supabase Storage bucket `cloud-uploads`:
 *
 *   1. the server hands a signed-in user a short-lived signed upload URL for a path inside their own folder
 *      (`<user id>/<random>/<file name>`), so the browser uploads straight to storage and the file never transits
 *      this server;
 *   2. a job may only reference paths in its owner's folder (checked when the job is created);
 *   3. the worker deletes every upload 24 hours after its job finished (worker.ts housekeeping).
 *
 * Needs SUPABASE_SECRET_KEY (Storage has no least-privilege role like the database). Without it, features that upload
 * media are reported unavailable instead of failing halfway.
 */

export const UPLOAD_BUCKET = "cloud-uploads";
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function storageConfigured(): boolean {
  const c = cloudConfig();
  return !!(c.supabaseUrl && c.secretKey);
}

function headers(): Record<string, string> {
  const key = cloudConfig().secretKey!;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** A safe object name: keeps letters, digits, dot, dash, underscore; caps length. */
export function safeFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(-80);
  return base || "upload";
}

export function uploadPathFor(userId: string, fileName: string): string {
  return `${userId}/${randomUUID()}/${safeFileName(fileName)}`;
}

/** True when `path` is a well-formed path in this user's folder (no traversal). */
export function ownsUploadPath(userId: string, path: string): boolean {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === userId && /^[0-9a-f-]{36}$/.test(parts[1]) && parts[2] === safeFileName(parts[2]) && !parts.includes("..");
}

export async function createSignedUpload(path: string): Promise<{ url: string; token: string }> {
  const c = cloudConfig();
  const r = await fetch(`${c.supabaseUrl}/storage/v1/object/upload/sign/${UPLOAD_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Storage refused the upload (${r.status}).`);
  const d = (await r.json()) as { url: string };
  const token = new URL(d.url, "http://x").searchParams.get("token") ?? "";
  return { url: `${c.supabaseUrl}/storage/v1${d.url}`, token };
}

/** A short-lived URL a runner can fetch the upload from (or pass to a GPU provider). */
export async function createSignedDownload(path: string, expiresInSec = 3600): Promise<string> {
  const c = cloudConfig();
  const r = await fetch(`${c.supabaseUrl}/storage/v1/object/sign/${UPLOAD_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: expiresInSec }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Storage couldn't sign the download (${r.status}).`);
  const d = (await r.json()) as { signedURL: string };
  return `${c.supabaseUrl}/storage/v1${d.signedURL}`;
}

export async function deleteUploads(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const c = cloudConfig();
  for (let i = 0; i < paths.length; i += 100) {
    const r = await fetch(`${c.supabaseUrl}/storage/v1/object/${UPLOAD_BUCKET}`, { method: "DELETE", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Storage couldn't delete uploads (${r.status}).`);
  }
}
