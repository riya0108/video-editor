import { createHash } from "node:crypto";
import { cloudConfig } from "./config";
import { clientKey } from "../net/rate-limit";

/**
 * WHO IS ASKING (server-only).
 *
 *   Signed in  — the browser sends its Supabase access token (Authorization: Bearer ...). It's verified by asking
 *                Supabase Auth itself (GET /auth/v1/user with the project's publishable key), so the server never
 *                needs the JWT secret. Valid results are cached for a minute.
 *   Anonymous  — keyed by the client's IP address, salted and hashed (ANON_KEY_SALT), so the database never stores
 *                IPs. One allowance per network: a household shares it, which is the point (no free reloads by
 *                clearing cookies).
 */

export interface Identity {
  /** "u:<supabase user id>" or "a:<salted hash of the IP>". */
  userKey: string;
  userId: string | null;
  email: string | null;
  signedIn: boolean;
  /** For rate limits and Turnstile. */
  ip: string;
}

const cache = new Map<string, { at: number; user: { id: string; email: string | null } | null }>();
const TTL_MS = 60_000;

export async function verifySupabaseToken(token: string): Promise<{ id: string; email: string | null } | null> {
  const c = cloudConfig();
  if (!c.supabaseUrl || !c.publishableKey) return null;
  const key = createHash("sha256").update(token).digest("hex");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;
  let user: { id: string; email: string | null } | null = null;
  try {
    const r = await fetch(`${c.supabaseUrl}/auth/v1/user`, { headers: { apikey: c.publishableKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const u = (await r.json()) as { id?: string; email?: string };
      if (u.id) user = { id: u.id, email: u.email ?? null };
    }
  } catch {
    return null; // auth unreachable: treat as not signed in rather than caching a false negative
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), user });
  return user;
}

export async function identify(request: Request, clientAddress: string | undefined): Promise<Identity> {
  const ip = clientKey(request, clientAddress);
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (token) {
    const user = await verifySupabaseToken(token);
    if (user) return { userKey: `u:${user.id}`, userId: user.id, email: user.email, signedIn: true, ip };
  }
  const hash = createHash("sha256").update(`${cloudConfig().anonSalt}\n${ip}`).digest("hex").slice(0, 32);
  return { userKey: `a:${hash}`, userId: null, email: null, signedIn: false, ip };
}

export function allowanceFor(id: Identity): number {
  const c = cloudConfig();
  return id.signedIn ? c.dailyCreditsSignedIn : c.dailyCreditsAnon;
}
