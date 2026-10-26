// On-demand route: streams a stock file (or thumbnail) the stock search route issued. Only HMAC-signed, unexpired
// URLs are served (lib/stock/signing.ts) — this is not an open proxy. Each hop of a redirect is re-checked against
// the public-address guard, the response must be image/video/audio, and size is capped.
export const prerender = false;

import type { APIRoute } from "astro";
import { verifySigned } from "../../lib/stock/signing";
import { resolvePublicHttpUrl } from "../../lib/net/public-url";

const MAX_BYTES = 400 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 60_000;

const fail = (status: number, message: string) => new Response(message, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

export const GET: APIRoute = async ({ url }) => {
  const target = verifySigned(url.searchParams.get("u"), url.searchParams.get("e"), url.searchParams.get("s"));
  if (!target) return fail(403, "This link isn't valid or has expired — search again.");

  let next = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await resolvePublicHttpUrl(next);
    if (!safe) return fail(400, "That file's address isn't allowed.");
    let res: Response;
    try {
      res = await fetch(safe, { redirect: "manual", headers: { "User-Agent": "Clipbench/1.0 (stock import)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return fail(502, "Couldn't download that file.");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return fail(502, "Bad redirect from the provider.");
      next = new URL(loc, safe).toString();
      continue;
    }
    if (!res.ok || !res.body) return fail(502, `The provider answered ${res.status}.`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!/^(image|video|audio)\//.test(type) || type === "image/svg+xml") return fail(415, "That isn't a media file.");
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > MAX_BYTES) return fail(413, "That file is too large to import (over 400 MB).");

    let seen = 0;
    const capped = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength;
          if (seen > MAX_BYTES) ctl.error(new Error("too large"));
          else ctl.enqueue(chunk);
        },
      }),
    );
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (length) headers["Content-Length"] = String(length);
    return new Response(capped, { status: 200, headers });
  }
  return fail(502, "Too many redirects.");
};
