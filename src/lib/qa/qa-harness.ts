import { createTimeline, type TimelineModel } from "../timeline/model";
import type { TimelineEngine } from "../timeline/engine";
import type { Clip } from "../timeline/clip";
import type { FinalRenderer } from "../composition/final-renderer";
import { PreviewRenderer } from "../composition/preview-renderer";
import { previewProfile } from "../composition/render-profile";
import type { MediaFrameProvider } from "../composition/media-frame-provider";
import type { TextMeasurer } from "../composition/text-layout";
import type { ProjectManager } from "../project/manager";
import type { ProjectFileTarget } from "../project/manager";
import { serializeProjectDocument } from "../project/document";
import { sha256Hex } from "../project/bundle";
import { renderTimeline, type RenderDeps } from "../render/job";
import { checkExportProfile, type ExportProfile } from "../export/profile";
import { presetById, presetProfile, type PresetId } from "../export/presets";
import type { AIEditingSession } from "../ai/session";
import type { AudioSourceStore } from "../audio/source-store";

/**
 * BROWSER QA HARNESS (FULL_QA_REPORT.md) — not used by the app. Drives the live editor on
 * /tools/video/composition-preview through its own dev handles (window.__composition / __compositionActions /
 * __project): media is imported with real OPFS file handles through the editor's import path, edits go through the
 * engine and the editor's `apply`, projects are saved with the production file target, reopened after a real page
 * reload, rendered with the production FinalRenderer and exported with the production render job. Every step
 * returns what it observed (errors, timings, statuses) — nothing is asserted here; the report records the results.
 */

type Actions = {
  apply: (r: unknown) => void;
  addMediaFiles: (f: File[], h?: (FileSystemFileHandle | undefined)[]) => Promise<void>;
  removeBackground: (clip: Clip) => Promise<void>;
  generateCaptions: (o: { language: string; tier: string; profile: "subtitle" | "short-form"; scope: "timeline" | "selection"; replace: boolean }) => Promise<void>;
};
type W = Window & {
  __composition: { engine: TimelineEngine; provider: MediaFrameProvider; finalRenderer: FinalRenderer; measurer: TextMeasurer; aiSession: AIEditingSession; audioStore: AudioSourceStore; renderDeps: RenderDeps };
  __compositionActions: Actions;
  __project: { manager: ProjectManager };
};
const w = () => window as unknown as W;
export const ed = () => w().__composition.engine;
const act = () => w().__compositionActions;
const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ROOT = "/@fs/Users/teri/Downloads/Video Editor/";

/** Applies an engine EditResult through the editor (re-render, audio re-schedule). Throws with the engine's message on failure. */
export function must<T extends { ok: boolean; error?: Error }>(r: T): Extract<T, { ok: true }> {
  act().apply(r);
  if (!r.ok) throw r.error;
  return r as Extract<T, { ok: true }>;
}

export function refresh() {
  act().apply({ ok: true, timeline: ed().timeline });
}

// ---------------------------------------------------------------------------------------------- console capture

const consoleLog: { level: string; text: string; t: number }[] = [];
let consoleHooked = false;
/** Captures console errors/warnings and uncaught errors/rejections from now on (cleared by takeConsole). */
export function hookConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      consoleLog.push({ level, text: a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(" ").slice(0, 400), t: now() });
      orig(...a);
    };
  }
  addEventListener("error", (e) => consoleLog.push({ level: "uncaught", text: String(e.message).slice(0, 400), t: now() }));
  addEventListener("unhandledrejection", (e) => consoleLog.push({ level: "unhandledrejection", text: String((e.reason as Error)?.message ?? e.reason).slice(0, 400), t: now() }));
}
export function takeConsole() {
  return consoleLog.splice(0);
}

// ---------------------------------------------------------------------------------------------- media

async function opfsDir(name: string) {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}

/** Copies repo files into OPFS ("qa-media") and returns their read handles — the stand-in for files picked by the user. */
export async function seed(paths: string[]): Promise<FileSystemFileHandle[]> {
  const dir = await opfsDir("qa-media");
  const out: FileSystemFileHandle[] = [];
  for (const p of paths) {
    const name = p.split("/").pop()!;
    let h: FileSystemFileHandle;
    try {
      h = await dir.getFileHandle(name);
      const f = await h.getFile();
      if (f.size > 0 || name.startsWith("zero")) {
        out.push(h);
        continue;
      }
    } catch {
      /* not there yet */
    }
    const res = await fetch(ROOT + p);
    if (!res.ok) throw new Error(`seed: ${p} -> HTTP ${res.status}`);
    h = await dir.getFileHandle(name, { create: true });
    const wr = await h.createWritable();
    await res.body!.pipeTo(wr);
    out.push(h);
  }
  return out;
}

export async function removeSeeded(name: string) {
  await (await opfsDir("qa-media")).removeEntry(name);
}

function importErrorsShown(): string[] {
  return [...document.querySelectorAll('[data-testid="import-errors"] li')].map((li) => li.textContent ?? "");
}

/** Imports files through the editor's own upload path (drop / file picker). Returns the new clips and the errors the UI showed. */
export async function importMedia(paths: string[]) {
  const handles = await seed(paths);
  const files = await Promise.all(handles.map((h) => h.getFile()));
  const before = new Set(Object.keys(ed().timeline.clips));
  const t0 = now();
  await act().addMediaFiles(files, handles);
  const ms = now() - t0;
  await sleep(50);
  const clips = Object.values(ed().timeline.clips).filter((c) => !before.has(c.id));
  return { ms, clips: clips.map((c) => ({ id: c.id, kind: c.content.kind, track: ed().timeline.tracks[c.trackId].name })), errors: importErrorsShown() };
}

/** The clip on the track whose name contains `name` (first if several). */
export function clipOn(name: string): Clip {
  const tl = ed().timeline;
  const c = Object.values(tl.clips).find((x) => tl.tracks[x.trackId].name.includes(name));
  if (!c) throw new Error(`No clip on a track named like "${name}".`);
  return c;
}

/** Waits until every audio source the timeline uses has finished decoding (or failed). */
export async function audioSettled(timeoutMs = 120_000) {
  const t0 = now();
  const store = w().__composition.audioStore;
  for (;;) {
    const ids = new Set(Object.values(ed().timeline.clips).flatMap((c) => ((c.content as { source?: { sourceId: string } }).source ? [(c.content as { source: { sourceId: string } }).source.sourceId] : [])));
    const loading = [...ids].filter((id) => store.status(id).state === "loading");
    if (loading.length === 0) return { ms: now() - t0, states: Object.fromEntries([...ids].map((id) => [id, store.status(id).state])) };
    if (now() - t0 > timeoutMs) return { ms: now() - t0, timeout: loading };
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------------------------- project lifecycle

/** Starts an empty project in the editor (the editor has no "New project" command; this is what one would do). */
export function newProject(width: number, height: number, background = "#000000"): TimelineModel {
  const engine = ed();
  engine.loadTimeline(createTimeline(30, { width, height, background }));
  engine.resetHistory();
  refresh();
  return engine.timeline;
}

/** Preview: every given frame rendered by a preview renderer until its media is decoded. Reports layers that never got pixels. */
export async function previewCheck(frames: number[], quality: "full" | "half" = "half") {
  const c = w().__composition;
  const r = new PreviewRenderer(c.provider, c.measurer);
  const rows: { frame: number; layers: number; skipped: string[]; missing: string[]; settleMs: number; renderMs: number }[] = [];
  for (const f of frames) {
    const t0 = now();
    let res = r.render(ed().timeline, f, previewProfile(quality, 1, 1, false));
    while ((res.stats.skipped.length > 0 || res.resolved.missingSources.length > 0) && now() - t0 < 8000) {
      await sleep(30);
      res = r.render(ed().timeline, f, previewProfile(quality, 1, 1, false));
    }
    await sleep(60);
    const t1 = now();
    res = r.render(ed().timeline, f, previewProfile(quality, 1, 1, false));
    rows.push({ frame: f, layers: res.resolved.layers.length, skipped: res.stats.skipped, missing: res.resolved.missingSources, settleMs: Math.round(t1 - t0), renderMs: +(now() - t1).toFixed(1) });
  }
  return rows;
}

/** Full-quality final renders: SHA-256 per frame + the canonical document hash (to compare saved vs reopened). */
export async function fingerprint(frames: number[]) {
  const { finalRenderer } = w().__composition;
  const { manager } = w().__project;
  const doc = manager.buildDocument(0);
  const canonical = serializeProjectDocument({ ...doc, savedAt: "", revision: 0, ui: { ...doc.ui, frame: 0 } } as typeof doc);
  const out: { frame: number; sha: string; ms: number }[] = [];
  for (const f of frames) {
    const t0 = now();
    const { canvas } = await finalRenderer.renderFrame(ed().timeline, f);
    const ms = now() - t0;
    const g = (canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    out.push({ frame: f, sha: (await sha256Hex(new Uint8Array(px.buffer))).slice(0, 16), ms: Math.round(ms) });
  }
  return { docSha: (await sha256Hex(new TextEncoder().encode(canonical))).slice(0, 16), clips: Object.keys(ed().timeline.clips).length, tracks: Object.keys(ed().timeline.tracks).length, frames: out };
}

/** Save As onto an OPFS file through the production file target. */
export async function saveAs(name: string) {
  const { manager } = w().__project;
  const dir = await opfsDir("qa-projects");
  const h = await dir.getFileHandle(name, { create: true });
  const target = (manager as unknown as { targetForHandle: (h: FileSystemFileHandle, n: string) => ProjectFileTarget }).targetForHandle(h, name);
  manager.rename(name.replace(/\.clipbench$/, ""));
  const t0 = now();
  const v = await manager.saveAs(target);
  const ms = now() - t0;
  const size = (await h.getFile()).size;
  return { ms: Math.round(ms), bytes: size, revision: v.revision };
}

/** Opens a saved project file the way File > Open does (after a page reload = "close"). */
export async function reopen(name: string) {
  const { manager } = w().__project;
  const h = await (await opfsDir("qa-projects")).getFileHandle(name);
  const bytes = new Uint8Array(await (await h.getFile()).arrayBuffer());
  const t0 = now();
  const r = await manager.openFile(bytes, { name, handle: h });
  const ms = now() - t0;
  return { ms: Math.round(ms), assets: r.assets.map((a) => ({ label: a.label, kind: a.kind, state: a.state })), warnings: r.warnings };
}

// ---------------------------------------------------------------------------------------------- export

/** Exports through the production render job with a preset's profile (+ overrides), exactly as the export panel resolves it. */
export async function exportProject(preset: PresetId, overrides: Partial<ExportProfile> = {}, opts: { keepBase64?: boolean } = {}) {
  const tl = ed().timeline;
  const profile: ExportProfile = { ...presetProfile(preset, tl), ...overrides };
  const check = checkExportProfile(tl, profile, presetById(preset)?.guidance);
  if (!check.ok) return { refused: check.errors };
  const t0 = now();
  try {
    const out = await renderTimeline(tl, check.settings, w().__composition.renderDeps);
    const wallMs = now() - t0;
    let base64: string | null = null;
    if (opts.keepBase64) {
      const bytes = new Uint8Array(await out.blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      base64 = btoa(bin);
    }
    return {
      ok: out.report.ok,
      settings: `${check.settings.width}x${check.settings.height}@${check.settings.fps} ${check.settings.container ?? "mp4"} ${out.report.codec}`,
      frames: out.plan.frameCount,
      durationSec: out.plan.durationSec,
      bytes: out.report.bytes,
      wallMs: Math.round(wallMs),
      failed: out.report.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
      warnings: [...check.warnings, ...out.report.warnings],
      base64,
    };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}`, wallMs: Math.round(now() - t0) };
  }
}

// ---------------------------------------------------------------------------------------------- AI

/** Runs an AI feature on a clip through the session and waits for its result (or error). */
export async function runAI(feature: Parameters<AIEditingSession["run"]>[0], clip: Clip, params: Record<string, unknown> = {}, timeoutMs = 300_000) {
  const s = w().__composition.aiSession;
  const before = new Set(s.store.list().map((r) => r.id));
  const t0 = now();
  let jobId: string;
  try {
    jobId = await s.run(feature, clip, params);
  } catch (e) {
    return { error: (e as Error).message };
  }
  for (;;) {
    const r = s.store.list().find((x) => !before.has(x.id) && x.feature === feature);
    if (r) return { result: r, ms: Math.round(now() - t0), items: r.items.length, warnings: r.warnings };
    const j = s.queue.job(jobId);
    if (j && j.status !== "queued" && j.status !== "processing" && !j.resultId) return { error: `${j.status}: ${j.error?.message ?? ""}`, ms: Math.round(now() - t0) };
    if (j?.resultId) {
      const res = s.store.list().find((x) => x.id === j.resultId);
      if (res) return { result: res, ms: Math.round(now() - t0), items: res.items.length, warnings: res.warnings };
    }
    if (now() - t0 > timeoutMs) return { error: "timeout", ms: Math.round(now() - t0) };
    await sleep(250);
  }
}

/** Applies an AI edit the way the AI panel's buttons do (one undo step). */
export function applyAI(edit: (tl: TimelineModel) => TimelineModel) {
  return must(ed().transact(edit));
}

export function memoryMb() {
  const pm = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return pm ? Math.round(pm.usedJSHeapSize / 1048576) : null;
}

/** Waits for the editor's dev handles (hydration + project storage ready). */
export async function ready(timeoutMs = 30_000) {
  const t0 = now();
  while (!(w().__composition?.engine && typeof w().__compositionActions?.addMediaFiles === "function" && w().__project?.manager)) {
    if (now() - t0 > timeoutMs) throw new Error("Editor did not become ready.");
    await sleep(100);
  }
  await sleep(300);
  return Math.round(now() - t0);
}

/** A contact sheet of final renders at the given frames (each scaled to `height` px), as a PNG data URL — the visual check. */
export async function contactSheet(frames: number[], height = 360): Promise<string> {
  const { finalRenderer } = w().__composition;
  const comp = ed().timeline.composition;
  const cw = Math.round((comp.width / comp.height) * height);
  const sheet = new OffscreenCanvas(cw * frames.length + 8 * (frames.length - 1), height);
  const g = sheet.getContext("2d")!;
  g.fillStyle = "#ff00ff"; // gaps (and transparent areas) show as magenta
  g.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < frames.length; i++) {
    const { canvas } = await finalRenderer.renderFrame(ed().timeline, frames[i]);
    g.clearRect(i * (cw + 8), 0, cw, height);
    g.fillStyle = "#ff00ff";
    g.fillRect(i * (cw + 8), 0, cw, height);
    g.drawImage(canvas as OffscreenCanvas, i * (cw + 8), 0, cw, height);
  }
  const blob = await sheet.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Field-level diff of the editor's current project document against the document stored in a saved file (savedAt/revision ignored). */
export async function diffAgainstSavedFile(name: string) {
  const { decodeBundle } = await import("../project/bundle");
  const { DOCUMENT_ENTRY } = await import("../project/document");
  const h = await (await opfsDir("qa-projects")).getFileHandle(name);
  const b = await decodeBundle(new Uint8Array(await (await h.getFile()).arrayBuffer()));
  const saved = JSON.parse(new TextDecoder().decode(b.entries.get(DOCUMENT_ENTRY)!));
  const current = JSON.parse(serializeProjectDocument(w().__project.manager.buildDocument(0)));
  const diffs: string[] = [];
  const walk = (a: unknown, c: unknown, path: string) => {
    if (diffs.length > 30) return;
    if (/^\.(savedAt|revision)$/.test(path)) return;
    if (a && c && typeof a === "object" && typeof c === "object") {
      for (const k of new Set([...Object.keys(a as object), ...Object.keys(c as object)])) walk((a as Record<string, unknown>)[k], (c as Record<string, unknown>)[k], `${path}.${k}`);
    } else if (JSON.stringify(a) !== JSON.stringify(c)) diffs.push(`${path}: saved ${JSON.stringify(a)?.slice(0, 80)} / now ${JSON.stringify(c)?.slice(0, 80)}`);
  };
  walk(saved, current, "");
  return diffs;
}
