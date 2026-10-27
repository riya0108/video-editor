/**
 * RATE LIMITING for the on-demand API routes (stock search, stock file proxy, link transcription). An in-memory
 * sliding window per client address — enough to stop one client hammering a route (and the providers' API quotas)
 * on a single server process. Behind several instances, put a shared limiter (or the CDN's) in front as well.
 *
 * The client address is Astro's `clientAddress` (the socket peer). Behind a reverse proxy, set TRUST_PROXY=true so
 * the first X-Forwarded-For entry is used instead — only when the proxy overwrites that header, or clients can
 * forge it.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
}

export const LIMITS = {
  stockSearch: { max: 60, windowMs: 60_000 },
  /** Thumbnails come through here too (20+ per results page), so it's generous. */
  stockFile: { max: 400, windowMs: 60_000 },
  transcribeSource: { max: 5, windowMs: 60_000 },
} satisfies Record<string, Limit>;

export function clientKey(request: Request, clientAddress: string | undefined): string {
  if (process.env.TRUST_PROXY === "true") {
    const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  return clientAddress || "unknown";
}

/** Records a hit; returns null when allowed, or the seconds to wait. */
export function rateLimit(route: string, key: string, limit: Limit, now = Date.now()): number | null {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (!b.hits.length || now - b.hits[b.hits.length - 1] > 10 * 60_000) buckets.delete(k);
  }
  const id = `${route}\n${key}`;
  const b = buckets.get(id) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < limit.windowMs);
  if (b.hits.length >= limit.max) {
    buckets.set(id, b);
    return Math.max(1, Math.ceil((b.hits[0] + limit.windowMs - now) / 1000));
  }
  b.hits.push(now);
  buckets.set(id, b);
  return null;
}

export function tooManyRequests(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ error: `Too many requests — try again in ${retryAfterSec} s.` }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" },
  });
}

/** Test-only. */
export function resetRateLimits(): void {
  buckets.clear();
}
