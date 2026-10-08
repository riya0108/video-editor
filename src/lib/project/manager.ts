import type { TimelineModel } from "../timeline/model";
import { decodeBundle, encodeBundle, ProjectCorruptError, sha256Hex } from "./bundle";
import { assetUsage, checkRelink, matchRelink, type AssetKind, type AssetRecord, type AssetUsage, type RelinkMatch } from "./assets";
import type { AssetRegistry } from "./asset-registry";
import { blobEntryName, DOCUMENT_ENTRY, parseProjectDocument, PROJECT_DOC_FORMAT, PROJECT_DOC_VERSION, serializeProjectDocument, type ExportSettingsState, type ProjectDocument } from "./document";
import { Autosaver, type AutosaveStatus } from "./autosave";
import { versionsToPrune, type ProjectMeta, type ProjectStore, type VersionEntry, type VersionReason, type VersionSummary } from "./storage";
import { cleanupSessions, type CleanFlags, type Recoverable, type SessionTracker } from "./recovery";

/**
 * PROJECT MANAGER (PROJECT_PERSISTENCE_ARCHITECTURE.md §1, §8) — Save, Save As, Open, autosave, version history,
 * restore, crash recovery, missing-media detection and relinking, on top of:
 *   document.ts (what a project is) · bundle.ts (the .clipbench file) · storage.ts (local database) ·
 *   asset-registry.ts (where media came from) · a ProjectHost (the editor: its state, and loading media into it).
 *
 * Invariants:
 *  - every persisted state gets the next revision; persists are serialized, so revisions never collide or go back;
 *  - a file is written through ProjectFileTarget only — atomically, and never onto a source-media file;
 *  - a project (file or stored version) is verified before anything in the editor changes; a damaged one changes
 *    nothing, and the error says what is damaged;
 *  - replacing the open project while it has unsaved changes first stores them as a restorable version.
 */

export type AssetState = "ok" | "missing" | "needs-permission" | "damaged";

export interface AssetStatus {
  id: string;
  label: string;
  kind: AssetKind;
  state: AssetState;
  detail?: string;
}

export interface EditorState {
  timeline: TimelineModel;
  aiResults: unknown | null;
  exportSettings: ExportSettingsState | null;
  ui: { frame: number };
}

export interface ProjectHost {
  snapshot(): EditorState;
  /** Makes the document's media available to the editor. `pngFor` yields generated frames. */
  materialize(doc: ProjectDocument, pngFor: (sha256: string) => Promise<Uint8Array | undefined>, opts?: { requestPermission?: boolean; only?: string[] }): Promise<AssetStatus[]>;
  /** Replaces the editor's state (timeline, AI results, export settings, playhead). */
  apply(doc: ProjectDocument): void;
  /** Loads `file` as asset `id`'s media (replacing it) and returns what was decoded; throws if it can't be decoded. */
  probeAndRegister(id: string, kind: AssetKind, file: File): Promise<{ kind: AssetKind; width?: number; height?: number; durationSec?: number }>;
  unregister(id: string): void;
}

/** Where Save writes. The browser implementation (file-target.ts) writes atomically and refuses source-media files. */
export interface ProjectFileTarget {
  name: string;
  handle?: FileSystemFileHandle;
  write(bytes: Uint8Array): Promise<void>;
}

export interface ProjectState {
  id: string;
  name: string;
  createdAt: string;
  headRevision: number;
  savedRevision: number;
  fileName: string | null;
  fileHandle: FileSystemFileHandle | null;
  dirty: boolean;
  assets: AssetStatus[];
}

export class NeedsSaveTargetError extends Error {
  constructor() {
    super("This project hasn't been saved to a file yet — choose where to save it.");
    this.name = "NeedsSaveTargetError";
  }
}

export interface OpenResult {
  warnings: string[];
  assets: AssetStatus[];
  migratedFrom: string | null;
}

export interface ManagerOptions {
  store: ProjectStore;
  host: ProjectHost;
  registry: AssetRegistry;
  tracker?: SessionTracker;
  cleanFlags?: CleanFlags;
  now?: () => number;
  newId?: () => string;
  autosave?: { delayMs?: number; maxDelayMs?: number; retryMs?: number } | false;
}

export class ProjectManager {
  private s: ProjectState;
  private readonly listeners = new Set<(s: ProjectState) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Content hash (revision/savedAt excluded) of the last persisted state: unchanged state isn't stored again. */
  private lastContentHash: string | null = null;
  readonly autosaver: Autosaver | null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly o: ManagerOptions) {
    this.now = o.now ?? (() => Date.now());
    this.newId = o.newId ?? (() => `project-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.s = { id: this.newId(), name: "Untitled project", createdAt: new Date(this.now()).toISOString(), headRevision: 0, savedRevision: 0, fileName: null, fileHandle: null, dirty: false, assets: [] };
    this.autosaver = o.autosave === false ? null : new Autosaver({ ...o.autosave, now: this.now, save: () => this.autosave() });
    void o.tracker?.setProject(this.s.id);
  }

  get state(): ProjectState {
    return this.s;
  }

  onChange(fn: (s: ProjectState) => void): () => void {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  }

  onAutosave(fn: (s: AutosaveStatus) => void): () => void {
    return this.autosaver?.onStatus(fn) ?? (() => {});
  }

  private set(patch: Partial<ProjectState>) {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l(this.s);
  }

  /** Serializes every operation that reads or advances the revision counter. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  rename(name: string) {
    const n = name.trim();
    if (!n || n === this.s.name) return;
    this.set({ name: n.slice(0, 200) });
    this.markEdited();
  }

  /** The editor changed something persistent. */
  markEdited() {
    if (!this.s.dirty) this.set({ dirty: true });
    this.autosaver?.markDirty();
  }

  // ---------------------------------------------------------------------------------------------- building

  buildDocument(revision: number): ProjectDocument {
    const st = this.o.host.snapshot();
    const ids = new Set(assetUsage(st.timeline).keys());
    return {
      format: PROJECT_DOC_FORMAT,
      version: PROJECT_DOC_VERSION,
      id: this.s.id,
      name: this.s.name,
      createdAt: this.s.createdAt,
      savedAt: new Date(this.now()).toISOString(),
      revision,
      timeline: st.timeline,
      assets: this.o.registry.recordsFor(ids),
      aiResults: st.aiResults,
      exportSettings: st.exportSettings,
      ui: st.ui,
    };
  }

  private async contentHash(doc: ProjectDocument): Promise<string> {
    return sha256Hex(new TextEncoder().encode(serializeProjectDocument({ ...doc, revision: 0, savedAt: "" })));
  }

  private generatedFrames(doc: ProjectDocument) {
    return doc.assets.flatMap((a) => (a.origin.type === "generated" ? a.origin.frames : []));
  }

  /** Stores the document as a new version (+ its generated media) — one atomic commit. */
  private async persist(doc: ProjectDocument, reason: VersionReason, metaPatch: Partial<ProjectMeta> = {}): Promise<VersionEntry> {
    const { store, registry } = this.o;
    for (const f of this.generatedFrames(doc)) {
      if (await store.hasBlob(f.sha256)) continue;
      const png = registry.png(f.sha256);
      // Missing everywhere = that asset is already reported "damaged"; the rest of the project still persists.
      if (png) await store.putBlob(f.sha256, png);
    }
    const json = serializeProjectDocument(doc);
    const entry: VersionEntry = { projectId: doc.id, revision: doc.revision, savedAt: this.now(), reason, name: doc.name, json, sha256: await sha256Hex(new TextEncoder().encode(json)), bytes: json.length };
    const prev = await store.getMeta(doc.id);
    const meta: ProjectMeta = {
      id: doc.id,
      name: doc.name,
      createdAt: prev?.createdAt ?? Date.parse(doc.createdAt) ?? this.now(),
      updatedAt: this.now(),
      lastSavedRevision: prev?.lastSavedRevision ?? 0,
      headRevision: Math.max(prev?.headRevision ?? 0, doc.revision),
      fileName: prev?.fileName,
      fileHandle: prev?.fileHandle,
      ...metaPatch,
    };
    await store.commit(entry, meta);
    this.lastContentHash = await this.contentHash(doc);
    await this.prune(doc.id);
    return entry;
  }

  private async prune(projectId: string) {
    const versions = await this.o.store.listVersions(projectId);
    const drop = versionsToPrune(versions);
    if (drop.length) await this.o.store.deleteVersions(projectId, drop);
  }

  // ---------------------------------------------------------------------------------------------- autosave / save

  private autosave(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.s.dirty) return;
      const doc = this.buildDocument(this.s.headRevision + 1);
      if ((await this.contentHash(doc)) === this.lastContentHash) return;
      await this.persist(doc, "autosave");
      this.set({ headRevision: doc.revision });
    });
  }

  /** Save to the project's file (or `target` for Save As). The file is written first, atomically; history records it after. */
  save(target?: ProjectFileTarget): Promise<VersionSummary> {
    return this.exclusive(async () => {
      const t = target ?? this.currentTarget();
      if (!t) throw new NeedsSaveTargetError();
      const doc = this.buildDocument(this.s.headRevision + 1);
      const bytes = await this.encode(doc);
      await t.write(bytes);
      const entry = await this.persist(doc, "save", { lastSavedRevision: doc.revision, fileName: t.name, fileHandle: t.handle });
      this.autosaver?.clear();
      this.set({ headRevision: doc.revision, savedRevision: doc.revision, fileName: t.name, fileHandle: t.handle ?? null, dirty: false });
      const { json: _j, ...summary } = entry;
      return summary;
    });
  }

  /** Save As: same project content, new file; the new file becomes the project's file. */
  saveAs(target: ProjectFileTarget): Promise<VersionSummary> {
    return this.save(target);
  }

  /** Set by the app: re-creates a write target for the current file handle (permission permitting). */
  targetForHandle: ((handle: FileSystemFileHandle, name: string) => ProjectFileTarget) | null = null;

  private currentTarget(): ProjectFileTarget | null {
    return this.s.fileHandle && this.targetForHandle ? this.targetForHandle(this.s.fileHandle, this.s.fileName ?? this.s.fileHandle.name) : null;
  }

  async encode(doc: ProjectDocument): Promise<Uint8Array> {
    const entries = [{ name: DOCUMENT_ENTRY, data: new TextEncoder().encode(serializeProjectDocument(doc)) }];
    const seen = new Set<string>();
    for (const f of this.generatedFrames(doc)) {
      if (seen.has(f.sha256)) continue;
      seen.add(f.sha256);
      const png = this.o.registry.png(f.sha256) ?? (await this.o.store.getBlob(f.sha256));
      // A damaged generated frame is left out (the asset stays "damaged" on reopen); it never blocks saving everything else.
      if (!png) continue;
      entries.push({ name: blobEntryName(f.sha256), data: png as Uint8Array<ArrayBuffer> });
    }
    return encodeBundle(entries);
  }

  // ---------------------------------------------------------------------------------------------- open / restore

  /** Opens a .clipbench file (or a legacy timeline JSON). Verified completely before the editor changes. */
  openFile(bytes: Uint8Array, file: { name: string; handle?: FileSystemFileHandle }): Promise<OpenResult> {
    return this.exclusive(async () => {
      const warnings: string[] = [];
      let docJson: string;
      const pngs = new Map<string, Uint8Array>();
      if (bytes.length > 0 && bytes[0] === 0x7b /* "{" — legacy JSON save */) {
        docJson = new TextDecoder().decode(bytes);
      } else {
        const b = await decodeBundle(bytes, { tolerateDamaged: (n) => n.startsWith("blobs/") });
        const pj = b.entries.get(DOCUMENT_ENTRY);
        if (!pj) throw new ProjectCorruptError("The project file has no project data.");
        docJson = new TextDecoder().decode(pj);
        for (const [name, data] of b.entries) if (name.startsWith("blobs/")) pngs.set(name.slice(6, 70), data);
        for (const name of b.damaged) {
          const sha = name.slice(6, 70);
          if (await this.o.store.hasBlob(sha)) warnings.push(`An embedded media frame was damaged in the file; restored it from this browser's copy (${sha.slice(0, 12)}…).`);
          else warnings.push(`An embedded media frame is damaged (${sha.slice(0, 12)}…); the media using it is marked damaged.`);
        }
      }
      const parsed = parseProjectDocument(docJson, { id: this.newId, now: () => new Date(this.now()).toISOString() });
      warnings.push(...parsed.warnings);
      const doc = parsed.doc;
      await this.storeCurrentIfDirty("before-open");
      for (const [sha, data] of pngs) {
        this.o.registry.addPng(sha, data);
        if (!(await this.o.store.hasBlob(sha))) await this.o.store.putBlob(sha, data);
      }
      const assets = await this.load(doc);
      // The migration note about relinking only matters if something actually is missing.
      if (parsed.migratedFrom && assets.every((x) => x.state === "ok")) {
        const i = warnings.findIndex((w) => w.includes("has to be relinked"));
        if (i >= 0) warnings.splice(i, 1, "This older timeline-only save didn't record media locations; every file it uses is open in this session, so nothing needs relinking. Save it to record them.");
      }
      const meta = await this.o.store.getMeta(doc.id);
      const head = Math.max(meta?.headRevision ?? 0, doc.revision);
      const versions = await this.o.store.listVersions(doc.id);
      if (!versions.some((v) => v.revision === doc.revision) || parsed.migratedFrom) {
        const rev = parsed.migratedFrom ? head + 1 : doc.revision;
        await this.persist({ ...doc, revision: rev }, "save", { lastSavedRevision: Math.max(meta?.lastSavedRevision ?? 0, rev), fileName: file.name, fileHandle: file.handle, headRevision: Math.max(head, rev) });
      } else {
        await this.o.store.putMeta({ ...(meta as ProjectMeta), fileName: file.name, fileHandle: file.handle, lastSavedRevision: Math.max(meta?.lastSavedRevision ?? 0, doc.revision) });
        this.lastContentHash = await this.contentHash(doc);
      }
      const after = await this.o.store.getMeta(doc.id);
      this.set({ id: doc.id, name: doc.name, createdAt: doc.createdAt, headRevision: after!.headRevision, savedRevision: after!.lastSavedRevision, fileName: file.name, fileHandle: file.handle ?? null, dirty: false, assets });
      this.autosaver?.clear();
      await this.o.tracker?.setProject(doc.id);
      return { warnings, assets, migratedFrom: parsed.migratedFrom };
    });
  }

  listVersions(projectId = this.s.id): Promise<VersionSummary[]> {
    return this.o.store.listVersions(projectId);
  }

  /** Reads and verifies a stored version (checksum, then full document validation). */
  private async readVersion(projectId: string, revision: number): Promise<ProjectDocument> {
    const v = await this.o.store.getVersion(projectId, revision);
    if (!v) throw new Error(`Version ${revision} isn't in this browser's history.`);
    if ((await sha256Hex(new TextEncoder().encode(v.json))) !== v.sha256) throw new ProjectCorruptError(`Version ${revision} in local history is damaged (checksum mismatch).`);
    return parseProjectDocument(v.json).doc;
  }

  /** Restores an earlier version as the current state (itself stored as a new version, so it can be undone). */
  restoreVersion(revision: number, projectId = this.s.id, reason: VersionReason = "restored"): Promise<OpenResult> {
    return this.exclusive(async () => {
      const doc = await this.readVersion(projectId, revision);
      await this.storeCurrentIfDirty("before-restore");
      const assets = await this.load(doc);
      const meta = await this.o.store.getMeta(projectId);
      const rev = Math.max(meta?.headRevision ?? 0, this.s.id === projectId ? this.s.headRevision : 0) + 1;
      this.set({ id: doc.id, name: doc.name, createdAt: doc.createdAt, fileName: meta?.fileName ?? null, fileHandle: meta?.fileHandle ?? null, savedRevision: meta?.lastSavedRevision ?? 0, headRevision: rev - 1, assets });
      await this.persist({ ...this.buildDocument(rev), name: doc.name }, reason);
      // Restored state differs from the file on disk unless it IS the saved revision.
      this.set({ headRevision: rev, dirty: revision !== (meta?.lastSavedRevision ?? -1) || reason === "recovered" });
      await this.o.tracker?.setProject(doc.id);
      return { warnings: [], assets, migratedFrom: null };
    });
  }

  /** Opens the newest version a crashed session left behind. Unsaved-to-file until the user saves. */
  async recover(r: Recoverable): Promise<OpenResult> {
    const res = await this.restoreVersion(r.version.revision, r.projectId, "recovered");
    this.set({ dirty: true });
    await cleanupSessions(this.o.store, [r.sessionId], this.now(), this.o.cleanFlags);
    return res;
  }

  async dismissRecovery(r: Recoverable): Promise<void> {
    await cleanupSessions(this.o.store, [r.sessionId], this.now(), this.o.cleanFlags);
  }

  private async storeCurrentIfDirty(reason: VersionReason) {
    if (!this.s.dirty) return;
    const doc = this.buildDocument(this.s.headRevision + 1);
    await this.persist(doc, reason);
    this.set({ headRevision: doc.revision });
  }

  /** Loads media then state into the editor; registry adopts the document's records. */
  private async load(doc: ProjectDocument): Promise<AssetStatus[]> {
    const assets = await this.o.host.materialize(doc, async (sha) => this.o.registry.png(sha) ?? (await this.o.store.getBlob(sha)));
    // Records of media that couldn't be found are kept too: relinking compares against their fingerprints.
    for (const r of doc.assets) if (!this.o.registry.get(r.id)) this.o.registry.adopt(r);
    this.o.host.apply(doc);
    return assets;
  }

  // ---------------------------------------------------------------------------------------------- missing media

  /** Re-resolves media (e.g. after granting file permission, or to re-check). */
  refreshMedia(opts: { requestPermission?: boolean } = {}): Promise<AssetStatus[]> {
    return this.exclusive(async () => {
      const doc = this.buildDocument(this.s.headRevision);
      const pending = this.s.assets.filter((a) => a.state !== "ok").map((a) => a.id);
      if (pending.length === 0) return this.s.assets;
      const updated = await this.o.host.materialize(doc, async (sha) => this.o.registry.png(sha) ?? (await this.o.store.getBlob(sha)), { ...opts, only: pending });
      const byId = new Map(updated.map((a) => [a.id, a]));
      const assets = this.s.assets.map((a) => byId.get(a.id) ?? a);
      this.set({ assets });
      return assets;
    });
  }

  private usage(): Map<string, AssetUsage> {
    return assetUsage(this.o.host.snapshot().timeline);
  }

  private recordFor(id: string): AssetRecord {
    const r = this.o.registry.get(id);
    if (r) return r;
    // No record (older project): what the timeline says about it.
    const u = this.usage().get(id);
    const tl = this.o.host.snapshot().timeline;
    const clip = u ? tl.clips[u.clipIds[0]] : undefined;
    const k = clip?.content.kind;
    const kind: AssetKind = u?.roles.has("matte") && !u.roles.has("media") ? "still" : k === "audio" ? "audio" : k === "video" || k === "overlay" ? "video" : "image";
    return { id, kind, label: u?.label ?? id, origin: { type: "url", url: "" } };
  }

  /**
   * Relinks one asset to `file`. Wrong kind or too short: refused (nothing changes). Not provably the same file:
   * returns `needsConfirm` with the warnings unless `confirm` is set. The source file is only read.
   */
  relink(id: string, file: File, opts: { confirm?: boolean; handle?: FileSystemFileHandle } = {}): Promise<{ ok: boolean; needsConfirm?: boolean; match: RelinkMatch; errors: string[]; warnings: string[] }> {
    return this.exclusive(async () => {
      const record = this.recordFor(id);
      const match = await matchRelink(record, file);
      let probe: Awaited<ReturnType<ProjectHost["probeAndRegister"]>>;
      try {
        probe = await this.o.host.probeAndRegister(id, record.kind === "still" ? "image" : record.kind, file);
      } catch (e) {
        return { ok: false, match, errors: [`"${file.name}" couldn't be decoded: ${(e as Error).message}`], warnings: [] };
      }
      const check = checkRelink(record, probe, this.usage().get(id), this.o.host.snapshot().timeline.frameRate, match);
      const certain = match === "exact" || match === "renamed";
      if (!check.ok || (!certain && check.warnings.length && !opts.confirm)) {
        this.o.host.unregister(id);
        return { ok: false, needsConfirm: check.ok, match, errors: check.errors, warnings: check.warnings };
      }
      // Measured values win; anything the probe doesn't measure (e.g. fps) is kept from the original record.
      const media = { ...record.media, ...Object.fromEntries(Object.entries({ width: probe.width, height: probe.height, durationSec: probe.durationSec }).filter(([, v]) => v !== undefined)) };
      const rec = await this.o.registry.setFile(id, record.kind === "still" ? "image" : record.kind, file, media, opts.handle);
      if (opts.handle && rec.origin.type === "file") await this.o.store.putHandle(rec.origin.fingerprint, opts.handle);
      this.set({ assets: this.s.assets.map((a) => (a.id === id ? { ...a, label: rec.label, state: "ok", detail: undefined } : a)) });
      // A different file, or the same file under a new name/date, changes what the project records (save it to keep
      // the new location); the very same file found again doesn't.
      const o0 = record.origin, o1 = rec.origin;
      const same = o0.type === "file" && o1.type === "file" && o0.fingerprint === o1.fingerprint && o0.name === o1.name && o0.lastModified === o1.lastModified;
      if (!same) this.markEdited();
      return { ok: true, match, errors: [], warnings: check.warnings };
    });
  }

  /** Relinks every missing asset that one of `files` provably IS (same content, any name). Returns ids relinked. */
  async relinkMany(files: { file: File; handle?: FileSystemFileHandle }[]): Promise<string[]> {
    const done: string[] = [];
    for (const a of this.s.assets.filter((x) => x.state !== "ok")) {
      const record = this.o.registry.get(a.id);
      if (!record || record.origin.type !== "file") continue;
      for (const f of files) {
        const m = await matchRelink(record, f.file);
        if (m !== "exact" && m !== "renamed") continue;
        const r = await this.relink(a.id, f.file, { handle: f.handle });
        if (r.ok) done.push(a.id);
        break;
      }
    }
    return done;
  }

  dispose() {
    this.autosaver?.dispose();
    this.listeners.clear();
  }
}
