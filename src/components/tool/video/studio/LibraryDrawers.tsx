import { useState } from "react";
import { FileAudio, Film, Image as ImageIcon, Shapes, Upload } from "lucide-react";
import type { CompositionSettings } from "../../../../lib/timeline/model";
import type { TextStyle } from "../../../../lib/timeline/text-style";
import { GRAPHICS_LIBRARY } from "../../../../lib/graphics/library";
import { TEXT_FONTS } from "../../../../lib/ffmpeg/fonts";
import { dragHasFiles, filesFromDataTransfer } from "../../../../lib/composition/media-import";
import { MOTION_PREVIEW } from "./TemplateGalleries";
import { StickersSection } from "./AssetDrawers";
import type { AssetRecord } from "../../../../lib/project/assets";

/**
 * LIBRARY DRAWERS — what the left rail opens: media, text presets, shapes & graphics, and the canvas settings
 * (also the inspector's empty state). Each one only reports a choice; the editor makes the edit.
 */

export const ASPECTS: { id: string; ratio: string; label: string; hint: string; width: number; height: number }[] = [
  { id: "16:9", ratio: "16:9", label: "Landscape", hint: "YouTube · Vimeo · web", width: 1920, height: 1080 },
  { id: "9:16", ratio: "9:16", label: "Vertical", hint: "Reels · TikTok · Shorts", width: 1080, height: 1920 },
  { id: "1:1", ratio: "1:1", label: "Square", hint: "Instagram · LinkedIn", width: 1080, height: 1080 },
  { id: "4:5", ratio: "4:5", label: "Portrait", hint: "Instagram & Facebook feed", width: 1080, height: 1350 },
  { id: "4k", ratio: "16:9", label: "4K", hint: "3840 × 2160 landscape", width: 3840, height: 2160 },
];

export function AspectGlyph({ width, height, size = 28 }: { width: number; height: number; size?: number }) {
  const s = size / Math.max(width, height);
  return (
    <span className="flex items-center justify-center" style={{ width: size, height: size }} aria-hidden="true">
      <span className="rounded-[3px] border-2 border-current" style={{ width: Math.max(8, width * s), height: Math.max(8, height * s) }} />
    </span>
  );
}

const SWATCHES = ["#000000", "#ffffff", "#0f172a", "#1e1b4b", "#312e81", "#7c3aed", "#db2777", "#f97316", "#facc15", "#16a34a", "#0891b2", "transparent"];

export function CanvasSettings({ composition, onChange, brandColors = [] }: { composition: CompositionSettings; onChange: (patch: Partial<CompositionSettings>) => void; brandColors?: string[] }) {
  const custom = composition.background !== "transparent" && !SWATCHES.includes(composition.background) && !brandColors.includes(composition.background) ? composition.background : null;
  return (
    <div className="flex flex-col gap-5" data-testid="canvas-settings">
      <div>
        <h3 className="mb-2 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Canvas size</h3>
        <div className="grid grid-cols-2 gap-2">
          {ASPECTS.map((a) => {
            const on = a.width === composition.width && a.height === composition.height;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onChange({ width: a.width, height: a.height })}
                aria-pressed={on}
                className={`flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                  on ? "border-primary-500 bg-primary-500/10 text-primary-700 dark:text-primary-200" : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                }`}
              >
                <AspectGlyph width={a.width} height={a.height} size={22} />
                <span className="min-w-0">
                  <span className="block text-caption font-semibold">{a.label}</span>
                  <span className="block truncate text-[11px] text-(--color-text-muted)">{a.ratio === "16:9" && a.id === "4k" ? "3840×2160" : a.ratio}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-(--color-text-faint) tabular-nums">
          Current: {composition.width} × {composition.height}
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Background</h3>
        {brandColors.length > 0 && (
          <div className="mb-2 grid grid-cols-6 gap-2" aria-label="Brand colors">
            {brandColors.map((c) => (
              <button key={c} type="button" onClick={() => onChange({ background: c })} aria-label={`Brand background ${c}`} aria-pressed={composition.background === c} title="Brand color" className={`aspect-square rounded-lg border transition-transform hover:scale-105 ${composition.background === c ? "ring-2 ring-primary-500 ring-offset-2 ring-offset-(--color-surface)" : "border-(--color-border-strong)"}`} style={{ background: c }} />
            ))}
          </div>
        )}
        <div className="grid grid-cols-6 gap-2">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange({ background: c })}
              aria-label={c === "transparent" ? "Transparent background" : `Background ${c}`}
              aria-pressed={composition.background === c}
              className={`aspect-square rounded-lg border transition-transform hover:scale-105 ${composition.background === c ? "ring-2 ring-primary-500 ring-offset-2 ring-offset-(--color-surface)" : "border-(--color-border-strong)"} ${c === "transparent" ? "bg-checkerboard" : ""}`}
              style={c === "transparent" ? undefined : { background: c }}
            />
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-caption text-(--color-text-muted)">
          <input type="color" value={custom ?? (composition.background === "transparent" ? "#000000" : composition.background)} onChange={(e) => onChange({ background: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent" />
          Custom color {custom && <span className="font-mono">{custom}</span>}
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function MediaDrawer({
  assets,
  onFiles,
  onPick,
  onReveal,
}: {
  assets: AssetRecord[];
  onFiles: (files: File[]) => void;
  /** Present when the browser has the File System Access picker (media then comes with read handles). */
  onPick?: () => void;
  onReveal: (assetId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const own = assets.filter((a) => (a.kind === "video" || a.kind === "image" || a.kind === "audio") && a.origin.type !== "generated");
  return (
    <div className="flex flex-col gap-4 px-2">
      <label
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          over ? "border-primary-500 bg-primary-500/10" : "border-(--color-border-strong) hover:border-primary-400 hover:bg-(--color-bg-subtle)"
        }`}
        onClick={
          onPick
            ? (e) => {
                e.preventDefault();
                onPick();
              }
            : undefined
        }
        onDragOver={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const files = filesFromDataTransfer(e.dataTransfer);
          setOver(false);
          if (!files.length) return;
          e.preventDefault();
          e.stopPropagation();
          onFiles(files);
        }}
        data-testid="media-upload"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-500/15 text-primary-600 dark:text-primary-300">
          <Upload className="h-5 w-5" />
        </span>
        <span className="text-body-sm font-semibold">Upload media</span>
        <span className="text-caption text-(--color-text-muted)">Video, images, audio or SVG — drag them anywhere in the editor</span>
        <input
          type="file"
          multiple
          // Audio/HEIC are selectable on purpose: picking one shows WHY it can't be added, instead of the file being silently greyed out in the picker.
          accept="image/*,video/*,.mov,.heic,.heif,audio/*,.svg"
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onFiles(files);
          }}
        />
      </label>
      <p className="px-1 text-[11px] text-(--color-text-faint)">Files never leave your device. Everything is processed in this browser tab.</p>
      <div>
        <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">In this project</h3>
        {own.length === 0 ? (
          <p className="rounded-xl bg-(--color-bg-subtle) px-3 py-4 text-center text-caption text-(--color-text-muted)">Nothing uploaded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {own.map((a) => {
              const Icon = a.kind === "video" ? Film : a.kind === "audio" ? FileAudio : ImageIcon;
              const dur = a.media?.durationSec;
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => onReveal(a.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-(--color-bg-subtle)" title="Select it on the timeline">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-(--color-bg-subtle) text-(--color-text-muted)">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption font-medium">{a.label}</span>
                      <span className="block text-[11px] text-(--color-text-faint) tabular-nums">
                        {a.kind}
                        {a.media?.width ? ` · ${a.media.width}×${a.media.height}` : ""}
                        {dur ? ` · ${dur >= 60 ? `${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s` : `${dur.toFixed(1)}s`}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface TextPreset {
  id: string;
  label: string;
  text: string;
  /** Font size as a fraction of the canvas's shorter side, so presets read the same on every aspect ratio. */
  size: number;
  style: Partial<TextStyle>;
  /** Motion presets (lib/animation/motion-presets.ts) applied with the text, in the same undo step. */
  motion?: { in?: string; out?: string; loop?: string };
}

export const TEXT_PRESETS: { group: string; items: TextPreset[] }[] = [
  {
    group: "Basics",
    items: [
      { id: "heading", label: "Add a heading", text: "Your heading", size: 0.09, style: { fontFamily: "geist", fontWeight: 800, letterSpacing: -2 } },
      { id: "subheading", label: "Add a subheading", text: "A subheading", size: 0.055, style: { fontFamily: "geist", fontWeight: 600 } },
      { id: "body", label: "Add body text", text: "Some body text", size: 0.035, style: { fontFamily: "geist", fontWeight: 400 } },
    ],
  },
  {
    group: "Animated",
    items: [
      { id: "a-pop-title", label: "Pop title", text: "WAIT FOR IT", size: 0.1, style: { fontFamily: "anton", fontWeight: 400, stroke: true, strokeColor: "#000000", strokeWidth: 8 }, motion: { in: "pop-in", out: "pop-out" } },
      { id: "a-rise", label: "Rise & fade", text: "Chapter one", size: 0.07, style: { fontFamily: "playfair", fontWeight: 700 }, motion: { in: "rise-in", out: "fade-out" } },
      { id: "a-slide-lower", label: "Sliding lower third", text: "Jordan Lee · Designer", size: 0.04, style: { fontFamily: "montserrat", fontWeight: 700, textAlign: "left", background: true, backgroundColor: "#7c3aed", backgroundOpacity: 1, padding: 22, borderRadius: 10 }, motion: { in: "slide-right-in", out: "slide-left-out" } },
      { id: "a-wipe", label: "Wipe reveal", text: "THE REVEAL", size: 0.08, style: { fontFamily: "bebas", fontWeight: 400, letterSpacing: 8 }, motion: { in: "wipe-in", out: "wipe-out" } },
      { id: "a-zoom", label: "Zoom punch", text: "BOOM", size: 0.14, style: { fontFamily: "bangers", fontWeight: 400, color: "#facc15", stroke: true, strokeColor: "#111827", strokeWidth: 10 }, motion: { in: "zoom-in", out: "zoom-out" } },
      { id: "a-float", label: "Floating tag", text: "Link in bio ↓", size: 0.045, style: { fontFamily: "poppins", fontWeight: 700, color: "#111827", background: true, backgroundColor: "#ffffff", backgroundOpacity: 1, padding: 20, borderRadius: 999 }, motion: { in: "drop-in", loop: "float", out: "fade-out" } },
      { id: "a-spin", label: "Spin in", text: "NEW!", size: 0.1, style: { fontFamily: "bungee", fontWeight: 400, color: "#f472b6" }, motion: { in: "spin-in", loop: "pulse", out: "fade-out" } },
      { id: "a-neon-blink", label: "Neon sign", text: "OPEN", size: 0.1, style: { fontFamily: "righteous", fontWeight: 400, color: "#a5f3fc", shadow: true, shadowColor: "rgba(34,211,238,0.95)", shadowBlur: 30, shadowOffsetY: 0 }, motion: { in: "fade-in", loop: "blink", out: "fade-out" } },
    ],
  },
  {
    group: "Styles",
    items: [
      { id: "impact", label: "IMPACT", text: "BIG NEWS", size: 0.11, style: { fontFamily: "anton", fontWeight: 400, stroke: true, strokeColor: "#000000", strokeWidth: 8 } },
      { id: "neon", label: "Neon", text: "Neon nights", size: 0.08, style: { fontFamily: "righteous", fontWeight: 400, color: "#a5f3fc", shadow: true, shadowColor: "rgba(34,211,238,0.95)", shadowBlur: 28, shadowOffsetY: 0 } },
      { id: "cinematic", label: "Cinematic", text: "THE JOURNEY", size: 0.06, style: { fontFamily: "playfair", fontWeight: 700, letterSpacing: 14 } },
      { id: "label", label: "Label", text: "New video", size: 0.045, style: { fontFamily: "poppins", fontWeight: 700, background: true, backgroundColor: "#7c3aed", backgroundOpacity: 1, padding: 22, borderRadius: 999 } },
      { id: "lower-third", label: "Lower third", text: "Alex Morgan · Host", size: 0.04, style: { fontFamily: "montserrat", fontWeight: 700, textAlign: "left", background: true, backgroundColor: "#000000", backgroundOpacity: 0.72, padding: 24, borderRadius: 12 } },
      { id: "comic", label: "Comic", text: "POW!", size: 0.12, style: { fontFamily: "bangers", fontWeight: 400, color: "#facc15", stroke: true, strokeColor: "#111827", strokeWidth: 10, letterSpacing: 4 } },
      { id: "script", label: "Handwritten", text: "with love", size: 0.08, style: { fontFamily: "caveat", fontWeight: 700, color: "#fde68a" } },
      { id: "retro", label: "Retro", text: "RETRO WAVE", size: 0.07, style: { fontFamily: "bungee", fontWeight: 400, color: "#f472b6", shadow: true, shadowColor: "#4c1d95", shadowBlur: 0, shadowOffsetX: 6, shadowOffsetY: 6 } },
      { id: "elegant", label: "Elegant", text: "Forever", size: 0.1, style: { fontFamily: "great-vibes", fontWeight: 400 } },
      { id: "marker", label: "Marker", text: "Must watch!", size: 0.07, style: { fontFamily: "marker", fontWeight: 400, color: "#ffffff", background: true, backgroundColor: "#dc2626", backgroundOpacity: 1, padding: 18, borderRadius: 6 } },
    ],
  },
];

const cssFamily = (id?: string) => TEXT_FONTS.find((f) => f.id === id)?.cssFontFamily ?? "inherit";

/** A CSS approximation of the preset, for the tile only (the canvas renders the real thing). */
function presetCss(p: TextPreset): React.CSSProperties {
  const s = p.style;
  return {
    fontFamily: cssFamily(s.fontFamily),
    fontWeight: s.fontWeight,
    color: s.color ?? "#ffffff",
    letterSpacing: s.letterSpacing ? `${Math.max(-1, Math.min(4, s.letterSpacing / 4))}px` : undefined,
    WebkitTextStroke: s.stroke ? `${Math.min(2, (s.strokeWidth ?? 4) / 5)}px ${s.strokeColor ?? "#000"}` : undefined,
    paintOrder: "stroke fill",
    textShadow: s.shadow ? `${(s.shadowOffsetX ?? 0) / 3}px ${(s.shadowOffsetY ?? 0) / 3}px ${(s.shadowBlur ?? 0) / 3}px ${s.shadowColor}` : undefined,
    background: s.background ? s.backgroundColor : undefined,
    opacity: 1,
    padding: s.background ? "2px 10px" : undefined,
    borderRadius: s.background ? Math.min(999, s.borderRadius ?? 0) : undefined,
  };
}

/** Plays a preset's in -> (loop) -> out on a tile, using the same CSS previews as the motion picker. */
function playPreview(el: Element | null, motion: NonNullable<TextPreset["motion"]>) {
  if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const seq = [motion.in, motion.loop, motion.out].filter((id): id is string => !!id && !!MOTION_PREVIEW[id]);
  let delay = 0;
  for (const id of seq) {
    el.animate(MOTION_PREVIEW[id], { duration: 520, delay, easing: "ease-in-out", fill: "backwards" });
    delay += 560;
  }
}

export function TextDrawer({ onAdd }: { onAdd: (preset: TextPreset) => void }) {
  return (
    <div className="flex flex-col gap-5 px-2">
      {TEXT_PRESETS.map((g) => (
        <div key={g.group}>
          <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">{g.group}</h3>
          {g.group === "Basics" ? (
            <div className="flex flex-col gap-1.5">
              {g.items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onAdd(p)}
                  className="rounded-xl border border-(--color-border) bg-(--color-bg-subtle) px-3 py-2.5 text-left transition-colors hover:border-primary-400 hover:bg-primary-500/5"
                  style={{ fontWeight: p.style.fontWeight, fontSize: p.id === "heading" ? 20 : p.id === "subheading" ? 15 : 12 }}
                  data-testid={`text-preset-${p.id}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {g.items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onAdd(p)}
                  onMouseEnter={(e) => p.motion && playPreview(e.currentTarget.firstElementChild, p.motion)}
                  title={`Add "${p.label}" text${p.motion ? " (animated)" : ""}`}
                  className="group flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-(--color-border) bg-[radial-gradient(circle_at_30%_20%,#312e81,#0b0b12_70%)] px-2 text-center transition-all hover:-translate-y-0.5 hover:border-primary-400 hover:shadow-md"
                  data-testid={`text-preset-${p.id}`}
                >
                  <span className={`text-[17px] leading-tight ${p.motion ? "" : "transition-transform group-hover:scale-105"}`} style={presetCss(p)}>
                    {p.text}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SHAPES: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "rect", label: "Rectangle", icon: <rect x="10" y="22" width="80" height="56" /> },
  { id: "rounded-rect", label: "Rounded", icon: <rect x="10" y="22" width="80" height="56" rx="16" /> },
  { id: "circle", label: "Circle", icon: <circle cx="50" cy="50" r="36" /> },
  { id: "ellipse", label: "Ellipse", icon: <ellipse cx="50" cy="50" rx="42" ry="28" /> },
  { id: "polygon", label: "Polygon", icon: <polygon points="50,12 88,40 74,86 26,86 12,40" /> },
  { id: "line", label: "Line", icon: <line x1="12" y1="80" x2="88" y2="20" strokeWidth="8" stroke="currentColor" /> },
  { id: "arrow", label: "Arrow", icon: <path d="M12 56 H62 V74 L90 50 L62 26 V44 H12 Z" /> },
];

export function ElementsDrawer({ onAdd, onSticker, onEmoji }: { onAdd: (choice: string) => void; onSticker: (id: string) => void; onEmoji: (emoji: string) => void }) {
  return (
    <div className="flex flex-col gap-5 px-2">
      <StickersSection onSticker={onSticker} onEmoji={onEmoji} />
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">
          <Shapes className="h-3.5 w-3.5" /> Shapes
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {SHAPES.map((s) => (
            <button key={s.id} type="button" onClick={() => onAdd(s.id)} title={`Add ${s.label.toLowerCase()}`} className="flex aspect-square items-center justify-center rounded-xl border border-(--color-border) bg-(--color-bg-subtle) text-primary-500 transition-all hover:-translate-y-0.5 hover:border-primary-400" data-testid={`shape-${s.id}`}>
              <svg viewBox="0 0 100 100" className="h-8 w-8" fill="currentColor">
                {s.icon}
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Graphics</h3>
        <div className="grid grid-cols-3 gap-2">
          {GRAPHICS_LIBRARY.map((g) => (
            <button key={g.id} type="button" onClick={() => onAdd(g.id)} title={`Add ${g.label.toLowerCase()}`} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-(--color-border) bg-(--color-bg-subtle) p-2 transition-all hover:-translate-y-0.5 hover:border-primary-400" data-testid={`graphic-${g.id}`}>
              <img src={`data:image/svg+xml;utf8,${encodeURIComponent(g.markup)}`} alt="" className="h-10 w-10" draggable={false} />
              <span className="text-[11px] text-(--color-text-muted)">{g.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 px-1 text-[11px] text-(--color-text-faint)">Tip: drop your own .svg files anywhere in the editor to add them as graphics.</p>
      </div>
    </div>
  );
}
