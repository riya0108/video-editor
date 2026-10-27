import { createHash, timingSafeEqual } from "node:crypto";
import { cloudConfig } from "./config";

/**
 * ADMIN ACCESS (server-only): one shared secret, CLOUD_ADMIN_TOKEN. The admin page signs in by posting it once; the
 * browser then holds an HttpOnly, SameSite=Strict cookie with its SHA-256 (never the token itself). Without the
 * variable set, the admin page is locked entirely.
 */
export const ADMIN_COOKIE = "cb_admin";

const digest = (s: string) => createHash("sha256").update(`clipbench-admin\n${s}`).digest("hex");

export function adminCookieValue(token: string): string {
  return digest(token);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAdminToken(token: string | undefined): boolean {
  const expected = cloudConfig().adminToken;
  return !!expected && !!token && same(digest(token), digest(expected));
}

export function isAdminCookie(value: string | undefined): boolean {
  const expected = cloudConfig().adminToken;
  return !!expected && !!value && same(value, digest(expected));
}
