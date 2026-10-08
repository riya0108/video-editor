import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, History, Link2, Loader2, LifeBuoy, Save, ShieldAlert } from "lucide-react";
import type { TimelineEngine } from "../../../../lib/timeline/engine";
import type { MediaFrameProvider } from "../../../../lib/composition/media-frame-provider";
import type { AudioSourceStore } from "../../../../lib/audio/source-store";
import type { AIResultStore } from "../../../../lib/ai/store";
import type { AssetRegistry } from "../../../../lib/project/asset-registry";
import type { ExportSettingsState, ProjectDocument } from "../../../../lib/project/document";
import { IdbProjectStore, type ProjectStore, type VersionSummary } from "../../../../lib/project/storage";
import { NeedsSaveTargetError, ProjectManager, type AssetStatus, type ProjectState } from "../../../../lib/project/manager";
import { createMediaHost } from "../../../../lib/project/media-host";
import { downloadTarget, fsAccessAvailable, handleTarget, pickOpenHandle, pickSaveHandle } from "../../../../lib/project/file-target";
import { cleanupSessions, findRecoverable, localStorageCleanFlags, SessionTracker, STALE_MS, type Recoverable } from "../../../../lib/project/recovery";
import type { AutosaveStatus } from "../../../../lib/project/autosave";

/**
 * PROJECT FILE BAR (PROJECT_PERSISTENCE_ARCHITECTURE.md §9): Save / Save As / Open, the project name, dirty and
 * autosave status, version history with restore, the crash-recovery prompt, and the missing-media panel with relink.
 * `useProjectPersistence` connects the ProjectManager to the editor (engine, media, AI results, export settings).
 */

const EMPTY_AI = JSON.stringify({ format: "clipbench-ai-results", version: 1, results: [] });

export interface PersistenceEditor {
  engine: TimelineEngine;
  provider: MediaFrameProvider;
  audio: AudioSourceStore;
  aiStore: AIResultStore | null;
  registry: AssetRegistry;
  fps: number;
  getFrame: () => number;
  /** Called after a project was loaded into the editor (re-render, clamp playhead, remount export panel...). */
  onLoaded: (doc: ProjectDocument) => void;
  exportSettings: { current: ExportSettingsState | null };
}

export interface Persistence {
  manager: ProjectManager;
  store: ProjectStore;
  state: ProjectState;
  autosave: AutosaveStatus;
  recoverable: Recoverable[];
  message: { kind: "info" | "error"; text: string } | null;
  setMessage: (m: Persistence["message"]) => void;
  setRecoverable: (r: Recoverable[]) => void;
}

export function useProjectPersistence(ed: PersistenceEditor | null): Persistence | null {
  /** Bound to ONE editor instance (`engine`): a manager must never persist a different editor's content under its project. */
  const [p, setP] = useState<{ manager: ProjectManager; store: ProjectStore; tracker: SessionTracker; engine: TimelineEngine; dispose: () => void } | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [autosave, setAutosave] = useState<AutosaveStatus>({ state: "idle", lastSavedAt: null, error: null });
  const [recoverable, setRecoverable] = useState<Recoverable[]>([]);
  const [message, setMessage] = useState<Persistence["message"]>(null);
  const edRef = useRef(ed);
  edRef.current = ed;
  /** The editor state the last load produced — changes from it (and only those) are edits. */
  const appliedRef = useRef<{ timeline: unknown; ai: boolean }>({ timeline: null, ai: false });

  useEffect(() => {
    if (!ed || p) return;
    let cancelled = false;
    (async () => {
      const store = await IdbProjectStore.open();
      const flags = localStorageCleanFlags();
      const tracker = new SessionTracker(store, crypto.randomUUID(), undefined, flags);
      await tracker.start();
      const host = createMediaHost(
        { provider: ed.provider, audio: ed.audio, registry: ed.registry, store, fps: ed.fps },
        {
          snapshot: () => {
            const e = edRef.current!;
            const ai = e.aiStore ? (JSON.parse(e.aiStore.serialize()) as { results: unknown[] }) : null;
            return { timeline: e.engine.timeline, aiResults: ai && ai.results.length ? ai : null, exportSettings: e.exportSettings.current, ui: { frame: e.getFrame() } };
          },
          apply: (doc) => {
            const e = edRef.current!;
            e.engine.loadTimeline(doc.timeline);
            e.engine.resetHistory();
            appliedRef.current = { timeline: e.engine.timeline, ai: true };
            e.aiStore?.load(doc.aiResults ? JSON.stringify(doc.aiResults) : EMPTY_AI);
            e.exportSettings.current = doc.exportSettings;
            e.onLoaded(doc);
          },
        },
      );
      const manager = new ProjectManager({ store, host, registry: ed.registry, tracker, cleanFlags: flags });
      const sourceHandles = async () => [...ed.registry.sourceHandles(), ...(await store.listHandles())];
      manager.targetForHandle = (h) => handleTarget(h, { sourceHandles });
      // Media picked with a READ handle: remember the handle by content fingerprint, so this file is found again.
      const rememberHandles = () => {
        for (const r of ed.registry.all()) {
          const h = ed.registry.fileFor(r.id)?.handle;
          if (h && r.origin.type === "file") void store.putHandle(r.origin.fingerprint, h);
        }
      };
      rememberHandles();
      if (cancelled) {
        manager.dispose();
        void tracker.end();
        return;
      }
      manager.onChange(setState);
      manager.onAutosave(setAutosave);
      appliedRef.current = { timeline: ed.engine.timeline, ai: false };
      await cleanupSessions(store, [], Date.now(), flags);
      setRecoverable(await findRecoverable(store, { ownSessionId: tracker.id, flags, pruneDead: true }));
      // A tab that crashed seconds ago still looks alive (heartbeat not yet stale): look again once it would be.
      setTimeout(() => void findRecoverable(store, { ownSessionId: tracker.id, flags, pruneDead: true }).then((r) => r.length && setRecoverable(r)), STALE_MS + 1000);
      const onHide = () => {
        void tracker.end(); // sets the synchronous clean flag first
        void manager.autosaver?.flush();
      };
      // Closing with unsaved changes: the browser's own "leave site?" prompt (registered below, removed on dispose).
      const onVisibility = () => {
        if (document.visibilityState === "hidden") void manager.autosaver?.flush();
      };
      window.addEventListener("pagehide", onHide);
      document.addEventListener("visibilitychange", onVisibility);
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (manager.state.dirty) e.preventDefault();
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      const unsubscribeRegistry = ed.registry.onChange(rememberHandles);
      const dispose = () => {
        window.removeEventListener("pagehide", onHide);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("beforeunload", onBeforeUnload);
        unsubscribeRegistry();
        manager.dispose();
        void tracker.end();
      };
      setP({ manager, store, tracker, engine: ed.engine, dispose });
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__project = { manager, store, tracker, flags, registry: ed.registry, handleTarget, findRecoverable };
    })().catch((e) => setMessage({ kind: "error", text: `Project storage is unavailable (${(e as Error).message}). Saving to a file still works; autosave and recovery are off.` }));
    return () => {
      cancelled = true;
    };
  }, [ed, p]);

  // The editor instance was replaced (remount, hot reload): this manager's project is not what the editor now shows.
  // Retire it — autosave stops, its session closes cleanly — and start fresh for the new editor.
  useEffect(() => {
    if (p && ed && ed.engine !== p.engine) {
      p.dispose();
      setP(null);
      setState(null);
    }
  }, [ed, p]);
  useEffect(() => () => p?.dispose(), [p]);

  // Every editor change after the last load is an edit (undo/redo included); the load itself isn't.
  const timeline = ed?.engine.timeline;
  useEffect(() => {
    if (!p || !timeline) return;
    if (timeline === appliedRef.current.timeline) return;
    appliedRef.current.timeline = null;
    p.manager.markEdited();
  }, [timeline, p]);
  useEffect(() => {
    if (!p || !ed?.aiStore) return;
    return ed.aiStore.subscribe(() => {
      if (appliedRef.current.ai) {
        appliedRef.current.ai = false;
        return;
      }
      p.manager.markEdited();
    });
  }, [p, ed?.aiStore]);

  if (!p || !state) return null;
  return { manager: p.manager, store: p.store, state, autosave, recoverable, message, setMessage, setRecoverable };
}

const fmtTime = (t: number) => new Date(t).toLocaleTimeString();
const REASON: Record<string, string> = { save: "Saved", autosave: "Autosave", "before-restore": "Before restore", "before-open": "Before opening another project", restored: "Restored", recovered: "Recovered after crash" };

export function ProjectFileBar({ p, registry }: { p: Persistence; registry: AssetRegistry }) {
  const { manager, state, autosave } = p;
  const [busy, setBusy] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; file: File; warnings: string[] } | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label);
      try {
        const msg = await fn();
        if (msg) p.setMessage({ kind: "info", text: msg });
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return; // picker dismissed
        p.setMessage({ kind: "error", text: `${label} failed: ${(e as Error).message}` });
      } finally {
        setBusy(null);
      }
    },
    [p],
  );

  const sourceHandles = useCallback(async () => [...registry.sourceHandles(), ...(await p.store.listHandles())], [registry, p.store]);
  const saveAs = useCallback(
    () =>
      run("Save As", async () => {
        const target = fsAccessAvailable() ? handleTarget(await pickSaveHandle(state.name), { sourceHandles }) : downloadTarget(state.name);
        const v = await manager.saveAs(target);
        return `Saved "${target.name}" (version ${v.revision}).`;
      }),
    [run, manager, state.name, sourceHandles],
  );
  const save = useCallback(
    () =>
      run("Save", async () => {
        try {
          const v = await manager.save();
          return `Saved "${state.fileName}" (version ${v.revision}).`;
        } catch (e) {
          if (e instanceof NeedsSaveTargetError) {
            setBusy(null);
            await saveAs();
            return;
          }
          throw e;
        }
      }),
    [run, manager, saveAs, state.fileName],
  );
  const openBytes = (bytes: Uint8Array, name: string, handle?: FileSystemFileHandle) =>
    run("Open", async () => {
      const r = await manager.openFile(bytes, { name, handle });
      const missing = r.assets.filter((a) => a.state !== "ok").length;
      return [`Opened "${name}".`, r.migratedFrom ? `Upgraded from ${r.migratedFrom}.` : "", missing ? `${missing} media item(s) need attention below.` : "", ...r.warnings].filter(Boolean).join(" ");
    });
  const open = async () => {
    if (!fsAccessAvailable()) return openInput.current?.click();
    try {
      const h = await pickOpenHandle();
      const f = await h.getFile();
      await openBytes(new Uint8Array(await f.arrayBuffer()), f.name, h);
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") p.setMessage({ kind: "error", text: `Open failed: ${(e as Error).message}` });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) void saveAs();
        else void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saveAs]);

  const showVersions = async () => setVersions(versions ? null : (await manager.listVersions()).reverse());
  const legacySave = useMemo(() => {
    try {
      return localStorage.getItem("clipbench.compositionPlayground.project");
    } catch {
      return null;
    }
  }, []);

  const status = busy
    ? `${busy}…`
    : autosave.state === "saving"
      ? "Autosaving…"
      : autosave.state === "error"
        ? `Autosave failed: ${autosave.error}`
        : state.dirty
          ? autosave.lastSavedAt
            ? `Unsaved changes · autosaved ${fmtTime(autosave.lastSavedAt)}`
            : "Unsaved changes"
          : state.fileName
            ? `Saved · ${state.fileName}`
            : "Not saved yet";
  const attention = state.assets.filter((a) => a.state !== "ok");

  const relink = (a: AssetStatus, file: File, confirmIt = false) =>
    run("Relink", async () => {
      const r = await manager.relink(a.id, file, { confirm: confirmIt });
      if (r.needsConfirm) {
        setConfirm({ id: a.id, file, warnings: r.warnings });
        return;
      }
      setConfirm(null);
      if (!r.ok) throw new Error(r.errors.join(" "));
      return `Relinked "${a.label}" to "${file.name}".${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`;
    });

  return (
    <div className="flex flex-col gap-2" data-testid="project-file-bar">
      {p.recoverable.map((r) => (
        <div key={r.sessionId} role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 px-3 py-2 text-body-sm" data-testid="recovery-banner">
          <LifeBuoy className="h-4 w-4" />
          <span>
            <b>{r.name}</b> wasn't closed properly. Unsaved work from {fmtTime(r.version.savedAt)} (version {r.version.revision}) can be recovered.
          </span>
          <button
            type="button"
            className="rounded-md bg-(--color-text) px-2 py-1 font-medium text-(--color-bg)"
            onClick={() =>
              run("Recover", async () => {
                await manager.recover(r);
                p.setRecoverable(p.recoverable.filter((x) => x !== r));
                return `Recovered "${r.name}" (version ${r.version.revision}). Save it to keep it in a file.`;
              })
            }
          >
            Recover
          </button>
          <button
            type="button"
            className="rounded-md border border-(--color-border) px-2 py-1"
            onClick={() =>
              run("Dismiss", async () => {
                await manager.dismissRecovery(r);
                p.setRecoverable(p.recoverable.filter((x) => x !== r));
                return "Dismissed. The autosave stays in that project's version history.";
              })
            }
          >
            Not now
          </button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm">
        <input
          aria-label="Project name"
          defaultValue={state.name}
          key={state.id + state.name}
          onBlur={(e) => manager.rename(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-48 rounded border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-(--color-border)"
        />
        <span className={`text-caption ${autosave.state === "error" ? "text-danger-600" : "text-(--color-text-muted)"}`} data-testid="project-status" role="status">
          {busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
          {status}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={save} disabled={!!busy} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-50" title="Save (⌘S)">
            <Save className="h-3.5 w-3.5" /> Save
          </button>
          <button type="button" onClick={saveAs} disabled={!!busy} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-50" title="Save As (⇧⌘S)">
            Save As…
          </button>
          <button type="button" onClick={open} disabled={!!busy} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle) disabled:opacity-50">
            <FolderOpen className="h-3.5 w-3.5" /> Open…
          </button>
          <button type="button" onClick={showVersions} className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)" aria-expanded={!!versions}>
            <History className="h-3.5 w-3.5" /> Versions
          </button>
          {legacySave && (
            <button type="button" onClick={() => openBytes(new TextEncoder().encode(legacySave), "Previous playground save")} className="rounded-md border border-(--color-border) px-2 py-1 text-caption hover:bg-(--color-bg-subtle)" title="Open the timeline saved by the old Save button">
              Import old save
            </button>
          )}
          <input
            ref={openInput}
            type="file"
            accept=".clipbench,.json"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
            }}
          />
        </div>
      </div>

      {p.message && (
        <p className={`flex items-start gap-2 rounded-md px-3 py-2 text-caption ${p.message.kind === "error" ? "bg-danger-500/10 text-danger-700" : "bg-(--color-bg-subtle)"}`} role={p.message.kind === "error" ? "alert" : "status"} data-testid="project-message">
          {p.message.kind === "error" ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="flex-1">{p.message.text}</span>
          <button type="button" onClick={() => p.setMessage(null)} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}

      {versions && (
        <div className="rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption" data-testid="project-versions">
          <div className="mb-1 font-medium">Version history (this browser)</div>
          {versions.length === 0 && <div className="text-(--color-text-muted)">No versions yet — they appear after the first save or autosave.</div>}
          <ul className="max-h-48 overflow-auto">
            {versions.map((v) => (
              <li key={v.revision} className="flex items-center gap-2 py-0.5" data-revision={v.revision}>
                <span className="w-10 tabular-nums">v{v.revision}</span>
                <span className="w-56">{REASON[v.reason] ?? v.reason}</span>
                <span className="tabular-nums text-(--color-text-muted)">{new Date(v.savedAt).toLocaleString()}</span>
                <span className="tabular-nums text-(--color-text-faint)">{(v.bytes / 1024).toFixed(0)} KB</span>
                <button
                  type="button"
                  className="ml-auto rounded border border-(--color-border) px-1.5"
                  onClick={() =>
                    run("Restore", async () => {
                      await manager.restoreVersion(v.revision);
                      setVersions((await manager.listVersions()).reverse());
                      return `Restored version ${v.revision}. What you had before is kept as a restore point.`;
                    })
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-2 text-caption" data-testid="missing-media">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-danger-600" />
            <span className="font-medium">{attention.length} media item(s) unavailable — the timeline keeps their clips; they render once relinked.</span>
            {attention.some((a) => a.state === "needs-permission") && (
              <button type="button" className="rounded-md border border-(--color-border) px-2 py-0.5" onClick={() => run("Reconnect", async () => void (await manager.refreshMedia({ requestPermission: true })))}>
                Reconnect files
              </button>
            )}
            <label className="cursor-pointer rounded-md border border-(--color-border) px-2 py-0.5">
              Locate files…
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void run("Relink", async () => {
                    const done = await manager.relinkMany(files.map((file) => ({ file })));
                    return done.length ? `Relinked ${done.length} item(s) by content.` : "None of those files is a missing original. Relink items one by one to use a different file.";
                  });
                }}
              />
            </label>
          </div>
          <ul className="flex flex-col gap-1">
            {attention.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2" data-asset={a.id} data-state={a.state}>
                <span className="w-28 uppercase tracking-wide text-danger-600">{a.state.replace("-", " ")}</span>
                <span className="font-medium">{a.label}</span>
                <span className="text-(--color-text-muted)">
                  {a.kind} · {a.detail}
                </span>
                {a.state !== "needs-permission" && (
                  <label className="ml-auto flex cursor-pointer items-center gap-1 rounded border border-(--color-border) px-1.5">
                    <Link2 className="h-3 w-3" /> Relink…
                    <input
                      type="file"
                      className="sr-only"
                      accept={a.kind === "audio" ? "audio/*,video/*" : a.kind === "video" ? "video/*,.mov" : "image/*"}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void relink(a, f);
                      }}
                    />
                  </label>
                )}
              </li>
            ))}
          </ul>
          {confirm && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-500/10 px-2 py-1" role="alert">
              <span>{confirm.warnings.join(" ")}</span>
              <button type="button" className="rounded-md bg-(--color-text) px-2 py-0.5 text-(--color-bg)" onClick={() => relink(attention.find((x) => x.id === confirm.id)!, confirm.file, true)}>
                Use this file anyway
              </button>
              <button type="button" className="rounded-md border border-(--color-border) px-2 py-0.5" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
