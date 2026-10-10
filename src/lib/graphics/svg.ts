import { normalizeSvgSpec, SVG_MAX_BYTES, type SvgSpec } from "../timeline/shape-style";

/**
 * SVG IMPORT (GRAPHICS_ENGINE_ARCHITECTURE.md §5). Pure string processing —
 * no DOM — so it's testable in Node and safe to run on untrusted files.
 *
 * Defense in depth: the markup is only ever rendered through an <img>
 * (where SVG can't run script or fetch external resources) and never put
 * into the DOM, but it is ALSO sanitized here because it gets embedded in
 * project files that could be opened elsewhere later.
 */

export class SvgImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgImportError";
  }
}

export function sanitizeSvg(raw: string): string {
  if (raw.length > SVG_MAX_BYTES) throw new SvgImportError(`SVG is too large (${Math.round(raw.length / 1024)} KB, limit ${SVG_MAX_BYTES / 1024} KB).`);
  let s = raw
    .replace(/^﻿/, "")
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "") // also kills entity declarations (billion-laughs style payloads)
    .replace(/<!--[\s\S]*?-->/g, "");
  // Executable / external-content elements, with their content.
  for (const tag of ["script", "foreignObject", "iframe", "object", "embed", "audio", "video"]) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "").replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "");
  }
  // Event handlers (onload=, onclick=...).
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // javascript:/data:text/html URLs and any non-fragment href (external fetches): keep only internal #refs and inline raster data images.
  // Quoted or unquoted (`href=javascript:...` is valid markup too — Phase 20 audit).
  s = s.replace(/\s+(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi, (m, _x, _q, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? "").trim();
    return v.startsWith("#") || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? m : "";
  });
  // CSS url(...) to anything but an internal fragment.
  s = s.replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "none");
  const start = s.search(/<svg[\s>]/i);
  const end = s.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) throw new SvgImportError("That file isn't a valid SVG (no <svg> root element).");
  s = s.slice(start, end + "</svg>".length).trim();
  // <img> only renders SVG that declares the SVG namespace.
  if (!/<svg[^>]*\sxmlns\s*=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v);
  return m ? Number(m[1]) : undefined; // %, em, mm... are not absolute — fall back to viewBox
}

function attr(rootTag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(rootTag)?.slice(1).find((x) => x !== undefined);
}

/** Intrinsic size from the root's width/height (absolute units only), else viewBox, else 100x100. */
export function svgIntrinsicSize(markup: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const w = parseLength(attr(root, "width"));
  const h = parseLength(attr(root, "height"));
  const vb = attr(root, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  const vbOk = vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  if (w && h) return { width: w, height: h };
  if (vbOk && w) return { width: w, height: (w * vb![3]) / vb![2] };
  if (vbOk && h) return { width: (h * vb![2]) / vb![3], height: h };
  if (vbOk) return { width: vb![2], height: vb![3] };
  return { width: 100, height: 100 };
}

/**
 * Markup for rasterizing at exactly `pxW` x `pxH` device pixels: the root's
 * width/height are set to that size (keeping its viewBox; adding one from the
 * intrinsic size if missing) so the browser renders the vector AT that
 * resolution instead of rasterizing at intrinsic size and scaling the bitmap.
 * `preserveAspectRatio="none"` makes the SVG fill the layer's box exactly,
 * like every other layer (the box keeps the aspect unless the user changes it).
 */
export function svgAtSize(markup: string, pxW: number, pxH: number, intrinsic: { width: number; height: number }): string {
  return markup.replace(/<svg\b[^>]*>/i, (root) => {
    let r = root.replace(/\s(width|height|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    if (!/\sviewBox\s*=/i.test(r)) r = r.replace(/<svg/i, `<svg viewBox="0 0 ${intrinsic.width} ${intrinsic.height}"`);
    return r.replace(/<svg/i, `<svg width="${pxW}" height="${pxH}" preserveAspectRatio="none"`);
  });
}

/** Sanitized markup -> an SvgSpec displayed at its intrinsic size, scaled down to fit `maxSide` if it's larger. */
export function svgSpecFromMarkup(raw: string, maxSide: number): SvgSpec {
  const markup = sanitizeSvg(raw);
  const { width, height } = svgIntrinsicSize(markup);
  const k = Math.min(1, maxSide / Math.max(width, height));
  const spec = normalizeSvgSpec({ markup, intrinsicWidth: width, intrinsicHeight: height, width: width * k, height: height * k });
  if (!spec) throw new SvgImportError("That SVG couldn't be read.");
  return spec;
}

/**
 * Raster size for drawing a `boxW` x `boxH` SVG under a matrix with these
 * axis scales. Preview quantizes UP to steps of ~1.25x so zooming doesn't
 * re-rasterize every frame (always >= needed, so never blurry); final uses
 * the exact ceiling. Capped so a huge zoom can't allocate a giant bitmap.
 */
export function svgRasterSize(boxW: number, boxH: number, scaleX: number, scaleY: number, mode: "preview" | "final", cap = 4096): { width: number; height: number } {
  const q = (px: number) => {
    const need = Math.max(1, px);
    if (mode === "final") return Math.min(cap, Math.ceil(need));
    return Math.min(cap, Math.ceil(Math.pow(1.25, Math.ceil(Math.log(need) / Math.log(1.25)))));
  };
  return { width: q(boxW * Math.abs(scaleX)), height: q(boxH * Math.abs(scaleY)) };
}
