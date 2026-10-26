/**
 * STOCK MEDIA PROVIDERS — request builders and response normalizers for the stock search route
 * (src/pages/api/stock.ts). Pure, so every provider's mapping is unit-tested without the network.
 *
 *   pexels     photos + videos   free for commercial use, no attribution required   needs PEXELS_API_KEY
 *   pixabay    photos + videos   free for commercial use, no attribution required   needs PIXABAY_API_KEY
 *   openverse  photos + audio    Creative Commons; filtered to commercial-use +     no key
 *                                modification licenses; attribution shown/kept
 */

export type StockProvider = "pexels" | "pixabay" | "openverse";
export type StockType = "image" | "video" | "audio";

export interface StockItem {
  id: string;
  provider: StockProvider;
  type: StockType;
  title: string;
  /** Small preview image (raw upstream URL; the route swaps in a signed proxy URL). */
  thumb: string;
  /** The file to import (raw upstream URL; signed by the route). */
  url: string;
  width?: number;
  height?: number;
  durationSec?: number;
  author: string;
  authorUrl?: string;
  /** The item's page at the provider (for credit / license details). */
  pageUrl: string;
  /** Human-readable license, e.g. "Pexels License", "CC BY 4.0". */
  license: string;
  /** Required credit line, when the license requires one. */
  attribution?: string;
}

export const PROVIDER_TYPES: Record<StockProvider, StockType[]> = {
  pexels: ["image", "video"],
  pixabay: ["image", "video"],
  openverse: ["image", "audio"],
};

export const PER_PAGE = 24;
/** Openverse refuses page_size > 20 for anonymous (keyless) clients. */
const OPENVERSE_PER_PAGE = 20;

/** Upstream request for a search; null when the provider doesn't carry that type. */
export function buildRequest(provider: StockProvider, type: StockType, query: string, page: number, keys: { pexels?: string; pixabay?: string }): { url: string; headers: Record<string, string> } | null {
  if (!PROVIDER_TYPES[provider].includes(type)) return null;
  const q = encodeURIComponent(query.trim());
  const p = Math.max(1, Math.min(50, Math.floor(page) || 1));
  switch (provider) {
    case "pexels": {
      if (!keys.pexels) return null;
      const headers = { Authorization: keys.pexels };
      if (type === "image") return { url: q ? `https://api.pexels.com/v1/search?query=${q}&per_page=${PER_PAGE}&page=${p}` : `https://api.pexels.com/v1/curated?per_page=${PER_PAGE}&page=${p}`, headers };
      return { url: q ? `https://api.pexels.com/videos/search?query=${q}&per_page=${PER_PAGE}&page=${p}` : `https://api.pexels.com/videos/popular?per_page=${PER_PAGE}&page=${p}`, headers };
    }
    case "pixabay": {
      if (!keys.pixabay) return null;
      const base = type === "image" ? "https://pixabay.com/api/" : "https://pixabay.com/api/videos/";
      return { url: `${base}?key=${encodeURIComponent(keys.pixabay)}&q=${q}&per_page=${PER_PAGE}&page=${p}&safesearch=true`, headers: {} };
    }
    case "openverse": {
      const kind = type === "image" ? "images" : "audio";
      return { url: `https://api.openverse.org/v1/${kind}/?q=${q || "nature"}&page=${p}&page_size=${OPENVERSE_PER_PAGE}&license_type=commercial,modification&mature=false`, headers: {} };
    }
  }
}

type J = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as J[]) : []);
const obj = (v: unknown): J => (typeof v === "object" && v !== null ? (v as J) : {});

/** Picks the largest rendition no wider than 1920 px (else the smallest) — HD is plenty for a browser editor. */
function pickRendition<T extends { width?: number; url: string }>(list: T[]): T | undefined {
  const sized = list.filter((r) => r.url);
  const hd = sized.filter((r) => (r.width ?? 0) <= 1920).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return hd[0] ?? sized.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
}

function ccLicense(license: string, version: string): string {
  const l = license.toLowerCase();
  if (l === "cc0") return "CC0 (public domain)";
  if (l === "pdm") return "Public domain";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`;
}

/** Upstream JSON -> normalized items. Items missing a usable file are dropped. */
export function normalizeResponse(provider: StockProvider, type: StockType, raw: unknown, page = 1): { items: StockItem[]; hasMore: boolean } {
  const r = obj(raw);
  const items: StockItem[] = [];
  if (provider === "pexels" && type === "image") {
    for (const p of arr(r.photos)) {
      const src = obj(p.src);
      const url = str(src.large2x) || str(src.large) || str(src.original);
      if (!url) continue;
      items.push({ id: `pexels-${p.id}`, provider, type, title: str(p.alt, "Pexels photo"), thumb: str(src.medium) || str(src.small) || url, url, width: num(p.width), height: num(p.height), author: str(p.photographer, "Pexels"), authorUrl: str(p.photographer_url) || undefined, pageUrl: str(p.url), license: "Pexels License" });
    }
    return { items, hasMore: !!r.next_page };
  }
  if (provider === "pexels" && type === "video") {
    for (const v of arr(r.videos)) {
      const best = pickRendition(arr(v.video_files).filter((f) => str(f.file_type) === "video/mp4").map((f) => ({ url: str(f.link), width: num(f.width), height: num(f.height) })));
      if (!best) continue;
      const user = obj(v.user);
      items.push({ id: `pexels-v${v.id}`, provider, type, title: "Pexels video", thumb: str(v.image), url: best.url, width: best.width, height: best.height, durationSec: num(v.duration), author: str(user.name, "Pexels"), authorUrl: str(user.url) || undefined, pageUrl: str(v.url), license: "Pexels License" });
    }
    return { items, hasMore: !!r.next_page };
  }
  if (provider === "pixabay") {
    const total = num(r.totalHits) ?? 0;
    for (const h of arr(r.hits)) {
      const tags = str(h.tags);
      if (type === "image") {
        const url = str(h.largeImageURL) || str(h.webformatURL);
        if (!url) continue;
        items.push({ id: `pixabay-${h.id}`, provider, type, title: tags || "Pixabay image", thumb: str(h.webformatURL) || str(h.previewURL), url, width: num(h.imageWidth), height: num(h.imageHeight), author: str(h.user, "Pixabay"), pageUrl: str(h.pageURL), license: "Pixabay Content License" });
      } else {
        const vids = obj(h.videos);
        const renditions = ["large", "medium", "small", "tiny"].map((k) => obj(vids[k])).map((x) => ({ url: str(x.url), width: num(x.width), height: num(x.height), thumbnail: str(x.thumbnail) }));
        const best = pickRendition(renditions);
        if (!best) continue;
        items.push({ id: `pixabay-v${h.id}`, provider, type, title: tags || "Pixabay video", thumb: renditions.find((x) => x.thumbnail)?.thumbnail ?? "", url: best.url, width: best.width, height: best.height, durationSec: num(h.duration), author: str(h.user, "Pixabay"), pageUrl: str(h.pageURL), license: "Pixabay Content License" });
      }
    }
    return { items, hasMore: items.length > 0 && total > PER_PAGE * page };
  }
  // openverse
  for (const o of arr(r.results)) {
    const url = str(o.url);
    if (!url) continue;
    const license = ccLicense(str(o.license), str(o.license_version));
    const ms = num(o.duration);
    items.push({
      id: `openverse-${str(o.id)}`,
      provider,
      type,
      title: str(o.title, type === "audio" ? "Audio" : "Image"),
      thumb: str(o.thumbnail) || (type === "image" ? url : ""),
      url,
      width: num(o.width),
      height: num(o.height),
      durationSec: ms !== undefined ? ms / 1000 : undefined,
      author: str(o.creator, "Unknown"),
      authorUrl: str(o.creator_url) || undefined,
      pageUrl: str(o.foreign_landing_url),
      license,
      attribution: str(o.attribution) || undefined,
    });
  }
  const pageCount = num(r.page_count) ?? 0;
  return { items, hasMore: (num(r.page) ?? page) < pageCount };
}
