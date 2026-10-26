import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Film, Image as ImageIcon, Loader2, Music, Pause, Play, Plus, Search, Trash2, Upload, X } from "lucide-react";
import type { StockItem, StockProvider, StockType } from "../../../../lib/stock/providers";
import { MAX_BRAND_COLORS, type BrandKit, type LogoCorner } from "../../../../lib/brand/brand-kit";
import { TEXT_FONTS } from "../../../../lib/ffmpeg/fonts";
import { EMOJI_STICKERS, STICKER_CATEGORIES, STICKERS } from "../../../../lib/graphics/stickers";

/**
 * ASSET DRAWERS — stock media search (via the server's /api/stock route), stickers & emoji, and the brand kit.
 * Like the other drawers they only report choices; the editor imports files and makes the edits.
 */

const label = "mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase";
const fmtDur = (s?: number) => (s === undefined ? "" : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `0:${String(Math.round(s)).padStart(2, "0")}`);

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<StockProvider, string> = { pexels: "Pexels", pixabay: "Pixabay", openverse: "Openverse" };
const TYPES: { id: StockType; label: string; icon: typeof Film }[] = [
  { id: "video", label: "Videos", icon: Film },
  { id: "image", label: "Photos", icon: ImageIcon },
  { id: "audio", label: "Music & SFX", icon: Music },
];
const SUGGESTIONS: Record<StockType, string[]> = {
  video: ["city", "nature", "office", "ocean", "technology", "food"],
  image: ["background", "abstract", "people", "travel", "texture", "sky"],
  audio: ["upbeat", "ambient", "piano", "whoosh", "applause", "rain"],
};

export interface StockImportProgress {
  id: string;
  fraction: number | null;
}

export function StockDrawer({ onImport }: { onImport: (file: File, item: StockItem) => Promise<void> }) {
  const [providers, setProviders] = useState<Record<StockProvider, boolean> | null>(null);
  const [providerTypes, setProviderTypes] = useState<Record<StockProvider, StockType[]> | null>(null);
  const [offline, setOffline] = useState(false);
  const [type, setType] = useState<StockType>("video");
  const [provider, setProvider] = useState<StockProvider | null>(null);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<StockItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Record<string, number | null>>({});
  const [done, setDone] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/api/stock")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { providers: Record<StockProvider, boolean>; types: Record<StockProvider, StockType[]> }) => {
        setProviders(d.providers);
        setProviderTypes(d.types);
      })
      .catch(() => setOffline(true));
    return () => audioRef.current?.pause();
  }, []);

  const choices = providers && providerTypes ? (Object.keys(providerTypes) as StockProvider[]).filter((p) => providerTypes[p].includes(type)) : [];
  const usable = choices.filter((p) => providers?.[p]);
  const active = provider && usable.includes(provider) ? provider : (usable[0] ?? null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/stock?provider=${active}&type=${type}&q=${encodeURIComponent(submitted)}&page=${page}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? `Search failed (${r.status}).`);
        return d as { items: StockItem[]; hasMore: boolean };
      })
      .then((d) => {
        if (cancelled) return;
        setItems((prev) => (page === 1 ? d.items : [...prev, ...d.items]));
        setHasMore(d.hasMore);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [active, type, submitted, page]);

  const search = (q: string) => {
    setQuery(q);
    setSubmitted(q.trim());
    setPage(1);
  };

  const add = async (item: StockItem) => {
    if (item.id in importing) return;
    setImporting((s) => ({ ...s, [item.id]: null }));
    try {
      const res = await fetch(item.url);
      if (!res.ok || !res.body) throw new Error((await res.text().catch(() => "")) || `Download failed (${res.status}).`);
      const total = Number(res.headers.get("content-length") ?? "0");
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value);
        got += value.byteLength;
        if (total) setImporting((s) => ({ ...s, [item.id]: got / total }));
      }
      const mime = res.headers.get("content-type") ?? "";
      const ext = mime.split("/")[1]?.replace("jpeg", "jpg").replace("mpeg", "mp3").split(";")[0] || "bin";
      const file = new File(chunks as BlobPart[], `${item.provider}-${item.id.replace(/^[a-z]+-/, "")}.${ext}`, { type: mime });
      await onImport(file, item);
      setDone((s) => new Set(s).add(item.id));
    } catch (e) {
      setError(`${item.title}: ${(e as Error).message}`);
    } finally {
      setImporting((s) => {
        const { [item.id]: _, ...rest } = s;
        return rest;
      });
    }
  };

  const togglePlay = (item: StockItem) => {
    if (playing === item.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const a = new Audio(item.url);
    a.onended = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
    audioRef.current = a;
    setPlaying(item.id);
  };

  if (offline)
    return (
      <p className="mx-2 flex gap-2 rounded-xl bg-warning-500/10 px-3 py-3 text-caption">
        <AlertCircle className="h-4 w-4 shrink-0 text-warning-600" /> Stock search needs the Clipbench server (it keeps provider API keys private). It isn't reachable from this page.
      </p>
    );

  return (
    <div className="flex flex-col gap-3 px-2" data-testid="stock-drawer">
      <div className="flex gap-1 rounded-lg bg-(--color-bg-subtle) p-1">
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setType(t.id);
              setPage(1);
              setItems([]);
            }}
            aria-pressed={type === t.id}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${type === t.id ? "bg-(--color-surface-raised) shadow-sm" : "text-(--color-text-muted) hover:text-(--color-text)"}`}
          >
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-(--color-text-faint)" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search free ${TYPES.find((t) => t.id === type)!.label.toLowerCase()}…`} className="w-full rounded-xl border border-(--color-border) bg-(--color-bg-subtle) py-2 pr-3 pl-9 text-body-sm focus:border-primary-500 focus:outline-none" aria-label="Search stock media" />
      </form>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS[type].map((s) => (
          <button key={s} type="button" onClick={() => search(s)} className="rounded-full border border-(--color-border) px-2.5 py-0.5 text-[11px] text-(--color-text-muted) hover:border-primary-400 hover:text-(--color-text)">
            {s}
          </button>
        ))}
      </div>
      {choices.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
          From
          {choices.map((p) => (
            <button key={p} type="button" disabled={!providers?.[p]} onClick={() => (setProvider(p), setPage(1), setItems([]))} className={`rounded-md px-2 py-0.5 font-medium disabled:opacity-40 ${active === p ? "bg-primary-500/15 text-primary-600 dark:text-primary-300" : "hover:bg-(--color-bg-subtle)"}`} title={providers?.[p] ? undefined : `Set ${p.toUpperCase()}_API_KEY on the server to enable`}>
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      )}
      {!active && providers && (
        <div className="rounded-xl bg-(--color-bg-subtle) px-3 py-3 text-caption text-(--color-text-muted)">
          Stock {type === "video" ? "videos" : "media"} need a free API key on the server. Add <code className="font-mono">PEXELS_API_KEY</code> (pexels.com/api) and/or <code className="font-mono">PIXABAY_API_KEY</code> (pixabay.com/api/docs) to <code className="font-mono">.env</code> and restart. Photos and music from Openverse work without a key.
        </div>
      )}
      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-500/10 px-3 py-2 text-caption" role="alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-500" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}

      {type === "audio" ? (
        <ul className="flex flex-col gap-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-(--color-bg-subtle)" title={`${it.title} — ${it.author} · ${it.license}`}>
              <button type="button" onClick={() => togglePlay(it)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-500/15 text-primary-500" aria-label={playing === it.id ? "Stop preview" : "Play preview"}>
                {playing === it.id ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />}
              </button>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-caption font-medium">{it.title}</span>
                <span className="block truncate text-[11px] text-(--color-text-faint)">
                  {it.author} · {it.license} {it.durationSec ? `· ${fmtDur(it.durationSec)}` : ""}
                </span>
              </span>
              <AddButton state={done.has(it.id) ? "done" : it.id in importing ? (importing[it.id] ?? -1) : "idle"} onClick={() => void add(it)} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="columns-2 gap-2 [&>*]:mb-2">
          {items.map((it) => {
            const state = it.id in importing ? (importing[it.id] ?? -1) : null;
            return (
              <button key={it.id} type="button" onClick={() => void add(it)} className="group relative block w-full break-inside-avoid overflow-hidden rounded-lg bg-(--color-bg-subtle)" title={`${it.title} — ${it.author} · ${it.license}. Click to add.`} data-testid="stock-item">
                {it.thumb ? <img src={it.thumb} alt={it.title} loading="lazy" className="block w-full transition-transform group-hover:scale-105" style={it.width && it.height ? { aspectRatio: `${it.width}/${it.height}` } : undefined} /> : <span className="block aspect-video" />}
                {it.durationSec !== undefined && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{fmtDur(it.durationSec)}</span>}
                <span className={`absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity ${state !== null || done.has(it.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                  {state !== null ? (
                    <span className="flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] text-white tabular-nums">
                      <Loader2 className="h-3 w-3 animate-spin" /> {state >= 0 ? `${Math.round(state * 100)}%` : "…"}
                    </span>
                  ) : done.has(it.id) ? (
                    <Check className="h-6 w-6 text-white" />
                  ) : (
                    <Plus className="h-6 w-6 text-white" />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {loading && (
        <p className="flex items-center justify-center gap-2 py-3 text-caption text-(--color-text-muted)">
          <Loader2 className="h-4 w-4 animate-spin" /> Searching…
        </p>
      )}
      {!loading && active && items.length === 0 && !error && <p className="py-4 text-center text-caption text-(--color-text-muted)">No results{submitted ? ` for “${submitted}”` : ""}.</p>}
      {!loading && hasMore && (
        <button type="button" onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-(--color-border) py-1.5 text-caption font-medium hover:bg-(--color-bg-subtle)">
          Load more
        </button>
      )}
      {active && <p className="px-1 text-[11px] text-(--color-text-faint)">Searches go to {PROVIDER_LABEL[active]} through the Clipbench server; imported files are processed on your device. Check each item's license — Openverse items may require credit.</p>}
    </div>
  );
}

function AddButton({ state, onClick }: { state: "idle" | "done" | number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={state !== "idle"} className="flex h-7 min-w-14 items-center justify-center gap-1 rounded-md border border-(--color-border) px-2 text-[11px] font-medium hover:border-primary-400 disabled:opacity-70" aria-label="Add to project">
      {state === "done" ? <Check className="h-3.5 w-3.5 text-success-500" /> : typeof state === "number" ? <span className="tabular-nums">{state >= 0 ? `${Math.round(state * 100)}%` : <Loader2 className="h-3.5 w-3.5 animate-spin" />}</span> : (<><Plus className="h-3.5 w-3.5" /> Add</>)}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stickers & emoji
// ---------------------------------------------------------------------------

export function StickersSection({ onSticker, onEmoji }: { onSticker: (id: string) => void; onEmoji: (emoji: string) => void }) {
  return (
    <div className="flex flex-col gap-5">
      {STICKER_CATEGORIES.map((cat) => (
        <div key={cat}>
          <h3 className={label}>{cat}</h3>
          <div className="grid grid-cols-3 gap-2">
            {STICKERS.filter((s) => s.category === cat).map((s) => (
              <button key={s.id} type="button" onClick={() => onSticker(s.id)} title={`Add the ${s.label.toLowerCase()} sticker`} className="flex aspect-square items-center justify-center rounded-xl border border-(--color-border) bg-[radial-gradient(circle_at_50%_35%,#475569,#1e293b)] p-2 transition-all hover:-translate-y-0.5 hover:border-primary-400" data-testid={`sticker-${s.id}`}>
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(s.markup)}`} alt={s.label} className="max-h-full max-w-full" draggable={false} />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div>
        <h3 className={label}>Emoji</h3>
        <div className="grid grid-cols-6 gap-1">
          {EMOJI_STICKERS.map((e) => (
            <button key={e} type="button" onClick={() => onEmoji(e)} className="aspect-square rounded-lg text-2xl transition-transform hover:scale-125 hover:bg-(--color-bg-subtle)" aria-label={`Add ${e}`}>
              {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

const CORNERS: { id: LogoCorner; label: string }[] = [
  { id: "top-left", label: "Top left" },
  { id: "top-right", label: "Top right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-right", label: "Bottom right" },
];

export function BrandDrawer({
  kit,
  onChange,
  onAddLogo,
  onApplyColor,
  onAddBrandText,
  canApplyColor,
}: {
  kit: BrandKit;
  onChange: (patch: Partial<BrandKit>) => void;
  onAddLogo: () => void;
  onApplyColor: (color: string) => void;
  onAddBrandText: (kind: "heading" | "body") => void;
  /** A text, shape or caption is selected — swatch clicks recolor it. */
  canApplyColor: boolean;
}) {
  const [newColor, setNewColor] = useState("#f97316");
  const logoUrl = useObjectUrl(kit.logo?.blob ?? null);
  const font = (id: string) => TEXT_FONTS.find((f) => f.id === id)?.cssFontFamily;
  return (
    <div className="flex flex-col gap-5 px-2" data-testid="brand-drawer">
      <input aria-label="Brand name" defaultValue={kit.name} onBlur={(e) => onChange({ name: e.target.value })} className="rounded-lg border border-transparent bg-transparent px-1 text-body font-semibold hover:border-(--color-border) focus:border-primary-500 focus:outline-none" />

      <section>
        <h3 className={label}>Logo</h3>
        {kit.logo && logoUrl ? (
          <div className="flex flex-col gap-3">
            <div className="relative flex h-28 items-center justify-center rounded-xl border border-(--color-border) bg-checkerboard p-3">
              <img src={logoUrl} alt="Brand logo" className="max-h-full max-w-full object-contain" />
              <button type="button" onClick={() => onChange({ logo: null })} className="absolute top-1.5 right-1.5 rounded-md bg-(--color-surface)/90 p-1 text-(--color-text-muted) hover:text-danger-500" aria-label="Remove logo">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {CORNERS.map((c) => (
                <button key={c.id} type="button" onClick={() => onChange({ logoCorner: c.id })} aria-pressed={kit.logoCorner === c.id} className={`rounded-lg border px-2 py-1 text-[11px] font-medium ${kit.logoCorner === c.id ? "border-primary-500 bg-primary-500/10" : "border-(--color-border) hover:bg-(--color-bg-subtle)"}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              Size
              <input type="range" min={0.04} max={0.4} step={0.01} value={kit.logoSize} onChange={(e) => onChange({ logoSize: Number(e.target.value) })} className="flex-1 accent-primary-500" />
              <span className="w-9 text-right tabular-nums">{Math.round(kit.logoSize * 100)}%</span>
            </label>
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              Opacity
              <input type="range" min={0.1} max={1} step={0.05} value={kit.logoOpacity} onChange={(e) => onChange({ logoOpacity: Number(e.target.value) })} className="flex-1 accent-primary-500" />
              <span className="w-9 text-right tabular-nums">{Math.round(kit.logoOpacity * 100)}%</span>
            </label>
            <button type="button" onClick={onAddLogo} className="rounded-lg bg-primary-500 px-3 py-2 text-caption font-semibold text-white hover:bg-primary-600" data-testid="brand-add-logo">
              Add logo to the whole video
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-(--color-border-strong) px-3 py-6 text-center hover:border-primary-400">
            <Upload className="h-5 w-5 text-(--color-text-muted)" />
            <span className="text-caption font-semibold">Upload your logo</span>
            <span className="text-[11px] text-(--color-text-muted)">PNG with transparency works best</span>
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg,image/gif"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onChange({ logo: { blob: f, name: f.name, type: f.type } });
              }}
            />
          </label>
        )}
      </section>

      <section>
        <h3 className={label}>Colors</h3>
        <div className="grid grid-cols-5 gap-2">
          {kit.colors.map((c) => (
            <div key={c} className="group relative">
              <button type="button" onClick={() => onApplyColor(c)} disabled={!canApplyColor} className="aspect-square w-full rounded-lg border border-(--color-border-strong) transition-transform enabled:hover:scale-105" style={{ background: c }} title={canApplyColor ? `Apply ${c} to the selection` : c} aria-label={`Brand color ${c}`} />
              <button type="button" onClick={() => onChange({ colors: kit.colors.filter((x) => x !== c) })} className="absolute -top-1.5 -right-1.5 hidden rounded-full bg-(--color-surface-raised) p-0.5 shadow group-hover:block" aria-label={`Remove ${c}`}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {kit.colors.length < MAX_BRAND_COLORS && (
            <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-(--color-border-strong) hover:border-primary-400" title="Add a color">
              <Plus className="h-4 w-4 text-(--color-text-muted)" />
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                onBlur={(e) => {
                  const v = e.target.value.toLowerCase();
                  if (!kit.colors.includes(v)) onChange({ colors: [...kit.colors, v] });
                }}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Add brand color"
              />
            </label>
          )}
        </div>
        <p className="mt-2 px-1 text-[11px] text-(--color-text-faint)">{canApplyColor ? "Click a color to apply it to the selected text, shape or captions." : "Select a text, shape or caption to apply a color. Brand colors also appear in the canvas background swatches."}</p>
      </section>

      <section>
        <h3 className={label}>Fonts</h3>
        <div className="flex flex-col gap-2">
          {(["headingFont", "bodyFont"] as const).map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-caption">
              <span className="text-(--color-text-muted)">{k === "headingFont" ? "Headings" : "Body"}</span>
              <select value={kit[k]} onChange={(e) => onChange({ [k]: e.target.value })} className="w-40 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1" style={{ fontFamily: font(kit[k]) }}>
                {TEXT_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="mt-1 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => onAddBrandText("heading")} className="rounded-xl border border-(--color-border) px-2 py-3 text-body-sm font-bold hover:border-primary-400" style={{ fontFamily: font(kit.headingFont) }}>
              Brand title
            </button>
            <button type="button" onClick={() => onAddBrandText("body")} className="rounded-xl border border-(--color-border) px-2 py-3 text-caption hover:border-primary-400" style={{ fontFamily: font(kit.bodyFont) }}>
              Brand text
            </button>
          </div>
        </div>
      </section>
      <p className="px-1 text-[11px] text-(--color-text-faint)">Your brand kit is saved in this browser and never uploaded.</p>
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
