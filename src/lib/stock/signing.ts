import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * SIGNED PROXY URLS (server only). The stock file proxy serves ONLY URLs that the stock search route itself handed
 * out: each upstream URL is signed with an HMAC, so the proxy can't be pointed at arbitrary hosts (not an open
 * proxy, no SSRF beyond what a provider's own search results contain).
 *
 * The key is STOCK_PROXY_SECRET when set (stable across restarts and across instances behind a load balancer),
 * else random per process — then links from before a restart simply stop working and a new search re-issues them.
 */

const SECRET = process.env.STOCK_PROXY_SECRET || randomBytes(32).toString("hex");
/** Signed links expire, so a leaked link can't be used as a permanent hotlink. */
const TTL_MS = 6 * 60 * 60 * 1000;

const sign = (url: string, exp: number) => createHmac("sha256", SECRET).update(`${exp}\n${url}`).digest("base64url");

export function signedProxyPath(url: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  return `/api/stock-file?u=${encodeURIComponent(url)}&e=${exp}&s=${sign(url, exp)}`;
}

/** The upstream URL when the signature is valid and unexpired; null otherwise. */
export function verifySigned(u: string | null, e: string | null, s: string | null, now = Date.now()): string | null {
  if (!u || !e || !s) return null;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < now) return null;
  const want = Buffer.from(sign(u, exp));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got) ? u : null;
}
