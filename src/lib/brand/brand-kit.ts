/**
 * BRAND KIT — a creator's logo, colors and fonts, kept in this browser (IndexedDB) and offered everywhere in the
 * editor: brand colors in every swatch row, brand fonts in brand text, and the logo as a one-click watermark.
 *
 * Nothing leaves the device. The kit is per browser profile, not per project: a project that used the logo carries
 * its own copy of the image (it's ordinary project media), so it still opens without the kit.
 */

export type LogoCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface BrandKit {
  name: string;
  /** Hex colors, in the user's order. The first is the primary. */
  colors: string[];
  /** Font registry ids (lib/text/font-registry.ts). */
  headingFont: string;
  bodyFont: string;
  logo: { blob: Blob; name: string; type: string } | null;
  logoCorner: LogoCorner;
  /** Logo width as a fraction of the canvas width. */
  logoSize: number;
  logoOpacity: number;
}

export const DEFAULT_BRAND_KIT: BrandKit = {
  name: "My brand",
  colors: ["#7c3aed", "#06b6d4", "#0f172a", "#ffffff"],
  headingFont: "montserrat",
  bodyFont: "geist",
  logo: null,
  logoCorner: "top-right",
  logoSize: 0.12,
  logoOpacity: 0.9,
};

export const MAX_BRAND_COLORS = 10;
const HEX = /^#[0-9a-f]{6}$/i;

/** Complete, clamped kit from stored (possibly older or damaged) data. */
export function normalizeBrandKit(raw: unknown): BrandKit {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BRAND_KIT;
  const colors = Array.isArray(r.colors) ? r.colors.filter((c): c is string => typeof c === "string" && HEX.test(c)).map((c) => c.toLowerCase()).slice(0, MAX_BRAND_COLORS) : d.colors;
  const logo = r.logo && typeof r.logo === "object" && (r.logo as { blob?: unknown }).blob instanceof Blob ? (r.logo as BrandKit["logo"]) : null;
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  return {
    name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 80) : d.name,
    colors,
    headingFont: typeof r.headingFont === "string" && r.headingFont ? r.headingFont : d.headingFont,
    bodyFont: typeof r.bodyFont === "string" && r.bodyFont ? r.bodyFont : d.bodyFont,
    logo,
    logoCorner: r.logoCorner === "top-left" || r.logoCorner === "bottom-left" || r.logoCorner === "bottom-right" ? r.logoCorner : "top-right",
    logoSize: num(r.logoSize, 0.03, 0.5, d.logoSize),
    logoOpacity: num(r.logoOpacity, 0.05, 1, d.logoOpacity),
  };
}

/** Center of a logo `w`x`h` placed in `corner` of a `compW`x`compH` canvas, with a margin of 4% of the shorter side. */
export function logoPosition(corner: LogoCorner, w: number, h: number, compW: number, compH: number): { x: number; y: number } {
  const m = Math.round(Math.min(compW, compH) * 0.04);
  const x = corner.endsWith("left") ? m + w / 2 : compW - m - w / 2;
  const y = corner.startsWith("top") ? m + h / 2 : compH - m - h / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

// ---------------------------------------------------------------------------
// Storage (IndexedDB: Blobs store natively, unlike localStorage)
// ---------------------------------------------------------------------------

const DB = "clipbench-brand";
const STORE = "kit";
const KEY = "default";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadBrandKit(): Promise<BrandKit> {
  try {
    const db = await open();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return raw ? normalizeBrandKit(raw) : { ...DEFAULT_BRAND_KIT };
  } catch {
    return { ...DEFAULT_BRAND_KIT }; // private window / storage blocked: the kit works for this session only
  }
}

export async function saveBrandKit(kit: BrandKit): Promise<boolean> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(kit, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}
