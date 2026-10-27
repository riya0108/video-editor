import { useState } from "react";
import { ArrowRight, Clock, FolderOpen, LifeBuoy, Lock, Sparkles, Stamp, Upload, Zap } from "lucide-react";
import type { ProjectMeta } from "../../../../lib/project/storage";
import type { Recoverable } from "../../../../lib/project/recovery";
import { dragHasFiles, filesFromDataTransfer } from "../../../../lib/composition/media-import";
import { ASPECTS, AspectGlyph } from "./LibraryDrawers";

/**
 * START SCREEN — the editor's front door: pick a canvas, start from footage (the canvas then matches the first
 * video), reopen recent or crashed work, open a .clipbench file, or explore the sample project. It overlays an
 * already-running empty editor, so project storage and crash recovery are live before anything is chosen.
 */

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export default function StartScreen({
  recent,
  recoverable,
  onBlank,
  onFiles,
  onOpenProject,
  onOpenRecent,
  onRecover,
  onDemo,
  onClose,
}: {
  recent: ProjectMeta[];
  recoverable: Recoverable[];
  onBlank: (width: number, height: number) => void;
  onFiles: (files: File[]) => void;
  onOpenProject: () => void;
  onOpenRecent: (meta: ProjectMeta) => void;
  onRecover: (r: Recoverable) => void;
  onDemo: () => void;
  onClose: () => void;
}) {
  const [over, setOver] = useState(false);
  const shown = recent.filter((m) => m.headRevision > 0).slice(0, 6);
  return (
    <div
      className="studio-scroll absolute inset-0 z-40 overflow-y-auto bg-(--color-bg)"
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        const files = filesFromDataTransfer(e.dataTransfer);
        setOver(false);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        onFiles(files);
      }}
      data-testid="start-screen"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_60%_80%_at_50%_-10%,color-mix(in_oklch,var(--color-primary-500)_28%,transparent),transparent)]" aria-hidden="true" />
      <div className="relative mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12 sm:py-16">
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-surface)/70 px-3 py-1 text-caption text-(--color-text-muted) backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-primary-400" /> Clipbench Studio
          </span>
          <h1 className="mt-4 text-h1 font-semibold tracking-tight sm:text-display">What are you making today?</h1>
          <p className="mx-auto mt-3 max-w-xl text-body text-(--color-text-muted)">Pick a canvas or drop your footage. Editing runs in your browser — your files stay on your device.</p>
        </div>

        {recoverable.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="start-recovery">
            {recoverable.map((r) => (
              <div key={r.sessionId} className="flex flex-wrap items-center gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-body-sm">
                <LifeBuoy className="h-5 w-5 text-warning-600" />
                <span className="flex-1">
                  <b>{r.name}</b> wasn't closed properly — your unsaved work from {new Date(r.version.savedAt).toLocaleTimeString()} is safe.
                </span>
                <button type="button" onClick={() => onRecover(r)} className="rounded-lg bg-(--color-text) px-3 py-1.5 text-caption font-semibold text-(--color-bg)">
                  Recover it
                </button>
              </div>
            ))}
          </div>
        )}

        <section aria-label="Start with a blank canvas">
          <h2 className="mb-3 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Blank canvas</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onBlank(a.width, a.height)}
                className="group flex flex-col items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface) px-3 pt-6 pb-4 text-center transition-all hover:-translate-y-1 hover:border-primary-400 hover:shadow-[0_12px_40px_-12px_color-mix(in_oklch,var(--color-primary-500)_55%,transparent)]"
                data-testid={`start-aspect-${a.id}`}
              >
                <span className="flex h-16 items-center text-(--color-text-faint) transition-colors group-hover:text-primary-400">
                  <AspectGlyph width={a.width} height={a.height} size={56} />
                </span>
                <span>
                  <span className="block text-body-sm font-semibold">
                    {a.label} <span className="font-normal text-(--color-text-muted)">{a.id === "4k" ? "" : a.ratio}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-(--color-text-muted)">{a.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <label
          className={`group relative flex cursor-pointer flex-col items-center gap-3 overflow-hidden rounded-3xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
            over ? "border-primary-400 bg-primary-500/10" : "border-(--color-border-strong) bg-(--color-surface)/60 hover:border-primary-400"
          }`}
          data-testid="start-upload"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-accent-500 text-white shadow-lg transition-transform group-hover:scale-105">
            <Upload className="h-6 w-6" />
          </span>
          <span className="text-h3 font-semibold tracking-tight">Start from your footage</span>
          <span className="text-body-sm text-(--color-text-muted)">Drop videos, images or audio here, or click to browse. The canvas matches your first video.</span>
          <input
            type="file"
            multiple
            accept="image/*,video/*,.mov,.heic,.heif,audio/*,.svg"
            className="sr-only"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) onFiles(files);
            }}
          />
        </label>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <section aria-label="Recent projects">
            <h2 className="mb-3 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Recent projects</h2>
            {shown.length === 0 ? (
              <p className="rounded-2xl border border-(--color-border) bg-(--color-surface) px-4 py-6 text-center text-body-sm text-(--color-text-muted)">Your projects appear here — they're autosaved in this browser as you edit.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2" data-testid="start-recent">
                {shown.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => onOpenRecent(m)} className="group flex w-full items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface) px-4 py-3 text-left transition-colors hover:border-primary-400">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500/15 text-primary-500">
                        <Clock className="h-4.5 w-4.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm font-semibold">{m.name}</span>
                        <span className="block text-caption text-(--color-text-muted)">
                          Edited {ago(m.updatedAt)}
                          {m.fileName ? ` · ${m.fileName}` : ""}
                        </span>
                      </span>
                      <ArrowRight className="h-4 w-4 text-(--color-text-faint) transition-transform group-hover:translate-x-0.5 group-hover:text-primary-400" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2" aria-label="More ways to start">
            <h2 className="mb-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">More</h2>
            <button type="button" onClick={onOpenProject} className="flex items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface) px-4 py-3 text-left text-body-sm font-medium hover:border-primary-400">
              <FolderOpen className="h-4.5 w-4.5 text-(--color-text-muted)" /> Open a .clipbench file
            </button>
            <button type="button" onClick={onDemo} className="flex items-center gap-3 rounded-2xl border border-(--color-border) bg-(--color-surface) px-4 py-3 text-left text-body-sm font-medium hover:border-primary-400" data-testid="start-demo">
              <Sparkles className="h-4.5 w-4.5 text-(--color-text-muted)" /> Explore a sample project
            </button>
            <button type="button" onClick={onClose} className="flex items-center gap-3 rounded-2xl px-4 py-3 text-left text-body-sm text-(--color-text-muted) hover:text-(--color-text)">
              <ArrowRight className="h-4.5 w-4.5" /> Skip — open an empty 16:9 editor
            </button>
            <a href="/tools/video/quick-editor" className="px-4 text-caption text-(--color-text-faint) underline-offset-2 hover:text-(--color-text-muted) hover:underline">
              Editing a single clip? Try the Quick Editor
            </a>
          </section>
        </div>

        <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-caption text-(--color-text-muted)">
          <li className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-accent-400" /> Private — editing never uploads your files
          </li>
          <li className="flex items-center gap-1.5">
            <Stamp className="h-3.5 w-3.5 text-accent-400" /> No watermark, ever
          </li>
          <li className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-accent-400" /> Free export up to 4K 60 fps
          </li>
        </ul>
      </div>
    </div>
  );
}
