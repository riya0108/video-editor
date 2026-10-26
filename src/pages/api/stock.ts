// On-demand route: stock media search (Pexels, Pixabay, Openverse) for the editor's Stock drawer. API keys stay on
// the server; results come back normalized, with every file and thumbnail URL rewritten to a SIGNED same-origin
// proxy link (/api/stock-file), so the browser never talks to the providers directly and cross-origin isolation
// (COEP) never blocks a preview.
export const prerender = false;

import type { APIRoute } from "astro";
import { buildRequest, normalizeResponse, PROVIDER_TYPES, type StockProvider, type StockType } from "../../lib/stock/providers";
import { signedProxyPath } from "../../lib/stock/signing";
import { clientKey, LIMITS, rateLimit, tooManyRequests } from "../../lib/net/rate-limit";

const TIMEOUT_MS = 12_000;

/**
 * Search results are cached for a few minutes (keyed by the upstream request, so never across providers or API
 * keys): typing back and forth, paging, and many users searching "nature" don't each hit the provider's quota —
 * and a flaky provider (Openverse's anonymous API stalls now and then) fails less often. File links are signed per
 * response, so the cache never hands out expired ones.
 */
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; items: ReturnType<typeof normalizeResponse>["items"]; hasMore: boolean }>();

function json(body: unknown, status = 200, cache = false): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache ? "public, max-age=300" : "no-store" } });
}

const keys = () => ({ pexels: process.env.PEXELS_API_KEY || undefined, pixabay: process.env.PIXABAY_API_KEY || undefined });

/** Which providers this deployment can search (the drawer hides the rest and explains how to enable them). */
function available(): Record<StockProvider, boolean> {
  const k = keys();
  return { pexels: !!k.pexels, pixabay: !!k.pixabay, openverse: true };
}

export const GET: APIRoute = async ({ url, request, clientAddress }) => {
  const wait = rateLimit("stock", clientKey(request, clientAddress), LIMITS.stockSearch);
  if (wait) return tooManyRequests(wait);
  const provider = url.searchParams.get("provider") as StockProvider | null;
  const type = url.searchParams.get("type") as StockType | null;
  if (!provider) return json({ providers: available(), types: PROVIDER_TYPES });
  if (!(provider in PROVIDER_TYPES) || !type || !PROVIDER_TYPES[provider].includes(type)) return json({ error: "Unknown provider or media type." }, 400);
  const query = (url.searchParams.get("q") ?? "").slice(0, 100);
  const page = Number(url.searchParams.get("page") ?? "1");
  const req = buildRequest(provider, type, query, page, keys());
  if (!req) return json({ error: `${provider} isn't configured on this server.`, providers: available() }, 503);

  try {
    let hit = cache.get(req.url);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      const res = await fetch(req.url, { headers: { ...req.headers, Accept: "application/json", "User-Agent": "Clipbench/1.0 (stock search)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 429) return json({ error: "The stock provider is rate-limiting searches right now — try again in a minute." }, 429);
      if (!res.ok) return json({ error: `The stock provider answered ${res.status}.` }, 502);
      hit = { at: Date.now(), ...normalizeResponse(provider, type, await res.json(), page) };
      cache.set(req.url, hit);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    const { items, hasMore } = hit;
    const signed = items.map((it) => ({ ...it, thumb: it.thumb ? signedProxyPath(it.thumb) : "", url: signedProxyPath(it.url) }));
    return json({ items: signed, hasMore, page }, 200, true);
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === "TimeoutError";
    return json({ error: timedOut ? "The stock provider didn't answer in time." : "Couldn't reach the stock provider." }, 502);
  }
};
