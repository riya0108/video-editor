/**
 * PROJECT STORAGE (PROJECT_PERSISTENCE_ARCHITECTURE.md §5) — the browser-side database behind autosave, recovery and
 * version history. One interface, two implementations: IndexedDB in the app, memory in tests.
 *
 *   versions   every persisted state of a project (explicit saves, autosaves, restore points), newest kept by policy
 *   meta       per project: name, last saved / autosaved revision, the project file's handle
 *   blobs      generated media frames (PNG), content-addressed by SHA-256, shared by all versions
 *   sessions   one row per open editor tab: heartbeat + "closed cleanly" flag — how a crash is detected
 *   handles    file handles of the user's source media, keyed by fingerprint, READ access only — automatic relink
 *
 * `commit` writes a version and its project meta in ONE transaction: an interrupted write (tab killed, quota error)
 * leaves the previous state entirely intact, never a version without its meta or vice versa.
 */

export type VersionReason = "save" | "autosave" | "before-restore" | "before-open" | "restored" | "recovered";

export interface VersionSummary {
  projectId: string;
  revision: number;
  /** ms since epoch. */
  savedAt: number;
  reason: VersionReason;
  name: string;
  sha256: string;
  bytes: number;
}

export interface VersionEntry extends VersionSummary {
  json: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Revision of the last explicit Save (0 = never saved to a file). */
  lastSavedRevision: number;
  /** Highest revision persisted in any way. */
  headRevision: number;
  fileName?: string;
  fileHandle?: FileSystemFileHandle;
}

export interface SessionRecord {
  id: string;
  projectId: string | null;
  startedAt: number;
  heartbeat: number;
  /** Set when the tab closed normally. A session that's not clean and not beating any more crashed. */
  clean: boolean;
}

export interface ProjectStore {
  commit(version: VersionEntry, meta: ProjectMeta): Promise<void>;
  listVersions(projectId: string): Promise<VersionSummary[]>;
  getVersion(projectId: string, revision: number): Promise<VersionEntry | undefined>;
  deleteVersions(projectId: string, revisions: number[]): Promise<void>;
  getMeta(projectId: string): Promise<ProjectMeta | undefined>;
  putMeta(meta: ProjectMeta): Promise<void>;
  listMeta(): Promise<ProjectMeta[]>;
  putBlob(sha256: string, data: Uint8Array): Promise<void>;
  getBlob(sha256: string): Promise<Uint8Array | undefined>;
  hasBlob(sha256: string): Promise<boolean>;
  listBlobKeys(): Promise<string[]>;
  deleteBlobs(keys: string[]): Promise<void>;
  putSession(s: SessionRecord): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;
  putHandle(fingerprint: string, handle: FileSystemFileHandle): Promise<void>;
  getHandle(fingerprint: string): Promise<FileSystemFileHandle | undefined>;
  listHandles(): Promise<FileSystemFileHandle[]>;
}

/** Retention: newest N explicit saves and newest M of everything else, per project. */
export const KEEP_SAVES = 50;
export const KEEP_OTHER = 20;

export function versionsToPrune(versions: VersionSummary[], keepSaves = KEEP_SAVES, keepOther = KEEP_OTHER): number[] {
  const sorted = [...versions].sort((a, b) => b.revision - a.revision);
  const saves = sorted.filter((v) => v.reason === "save");
  const other = sorted.filter((v) => v.reason !== "save");
  // Never prune the newest version of all, whatever its kind.
  const newest = sorted[0]?.revision;
  return [...saves.slice(keepSaves), ...other.slice(keepOther)].map((v) => v.revision).filter((r) => r !== newest);
}

// ------------------------------------------------------------------------------------------------ memory (tests)

export class MemoryProjectStore implements ProjectStore {
  readonly versions = new Map<string, VersionEntry>();
  readonly meta = new Map<string, ProjectMeta>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly handles = new Map<string, FileSystemFileHandle>();
  /** Test hook: throw inside the next commit, after the version is staged but before anything is visible. */
  failNextCommit: Error | null = null;

  private key = (p: string, r: number) => `${p}#${r}`;

  async commit(version: VersionEntry, meta: ProjectMeta) {
    const staged = { version: { ...version }, meta: { ...meta } };
    if (this.failNextCommit) {
      const e = this.failNextCommit;
      this.failNextCommit = null;
      throw e; // nothing applied: same guarantee as an aborted IndexedDB transaction
    }
    this.versions.set(this.key(version.projectId, version.revision), staged.version);
    this.meta.set(meta.id, staged.meta);
  }
  async listVersions(projectId: string) {
    return [...this.versions.values()].filter((v) => v.projectId === projectId).map(({ json: _j, ...s }) => s).sort((a, b) => a.revision - b.revision);
  }
  async getVersion(projectId: string, revision: number) {
    const v = this.versions.get(this.key(projectId, revision));
    return v && { ...v };
  }
  async deleteVersions(projectId: string, revisions: number[]) {
    for (const r of revisions) this.versions.delete(this.key(projectId, r));
  }
  async getMeta(id: string) {
    const m = this.meta.get(id);
    return m && { ...m };
  }
  async putMeta(m: ProjectMeta) {
    this.meta.set(m.id, { ...m });
  }
  async listMeta() {
    return [...this.meta.values()].map((m) => ({ ...m }));
  }
  async putBlob(k: string, d: Uint8Array) {
    this.blobs.set(k, d.slice());
  }
  async getBlob(k: string) {
    return this.blobs.get(k)?.slice();
  }
  async hasBlob(k: string) {
    return this.blobs.has(k);
  }
  async listBlobKeys() {
    return [...this.blobs.keys()];
  }
  async deleteBlobs(keys: string[]) {
    for (const k of keys) this.blobs.delete(k);
  }
  async putSession(s: SessionRecord) {
    this.sessions.set(s.id, { ...s });
  }
  async listSessions() {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async putHandle(fp: string, h: FileSystemFileHandle) {
    this.handles.set(fp, h);
  }
  async getHandle(fp: string) {
    return this.handles.get(fp);
  }
  async listHandles() {
    return [...this.handles.values()];
  }
}

// ------------------------------------------------------------------------------------------------ IndexedDB (app)

const DB_NAME = "clipbench-projects";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  // An explicitly aborted transaction (or a request error that aborts it) can report a null tx.error: always reject
  // with a real Error so callers (autosave status) can say what happened.
  const why = (ev?: Event) => tx.error ?? (ev?.target as IDBRequest | null)?.error ?? new DOMException("The browser database write was aborted; nothing was stored.", "AbortError");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = (ev) => reject(why(ev));
    tx.onerror = (ev) => reject(why(ev));
  });
}

export class IdbProjectStore implements ProjectStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME): Promise<IdbProjectStore> {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const v = db.createObjectStore("versions", { keyPath: ["projectId", "revision"] });
      v.createIndex("byProject", "projectId");
      db.createObjectStore("meta", { keyPath: "id" });
      db.createObjectStore("blobs");
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("handles");
    };
    return new IdbProjectStore(await req(open));
  }

  close() {
    this.db.close();
  }

  /** Test hook (interrupted-save simulation): abort the next commit's transaction after its writes are queued. */
  abortNextCommit = false;

  async commit(version: VersionEntry, meta: ProjectMeta) {
    const tx = this.db.transaction(["versions", "meta"], "readwrite");
    const finished = done(tx);
    tx.objectStore("versions").put(version);
    tx.objectStore("meta").put(meta);
    if (this.abortNextCommit) {
      this.abortNextCommit = false;
      tx.abort();
    }
    await finished;
  }
  async listVersions(projectId: string) {
    const tx = this.db.transaction("versions");
    // Summaries only: the cursor would load every json; versions are bounded by retention, so this stays small.
    const all = (await req(tx.objectStore("versions").index("byProject").getAll(projectId))) as VersionEntry[];
    return all.map(({ json: _j, ...s }) => s).sort((a, b) => a.revision - b.revision);
  }
  async getVersion(projectId: string, revision: number) {
    return (await req(this.db.transaction("versions").objectStore("versions").get([projectId, revision]))) as VersionEntry | undefined;
  }
  async deleteVersions(projectId: string, revisions: number[]) {
    const tx = this.db.transaction("versions", "readwrite");
    const finished = done(tx);
    for (const r of revisions) tx.objectStore("versions").delete([projectId, r]);
    await finished;
  }
  async getMeta(id: string) {
    return (await req(this.db.transaction("meta").objectStore("meta").get(id))) as ProjectMeta | undefined;
  }
  async putMeta(m: ProjectMeta) {
    const tx = this.db.transaction("meta", "readwrite");
    const finished = done(tx);
    tx.objectStore("meta").put(m);
    await finished;
  }
  async listMeta() {
    return (await req(this.db.transaction("meta").objectStore("meta").getAll())) as ProjectMeta[];
  }
  async putBlob(k: string, d: Uint8Array) {
    const tx = this.db.transaction("blobs", "readwrite");
    const finished = done(tx);
    tx.objectStore("blobs").put(new Blob([d as Uint8Array<ArrayBuffer>], { type: "image/png" }), k);
    await finished;
  }
  async getBlob(k: string) {
    const b = (await req(this.db.transaction("blobs").objectStore("blobs").get(k))) as Blob | undefined;
    return b ? new Uint8Array(await b.arrayBuffer()) : undefined;
  }
  async hasBlob(k: string) {
    return (await req(this.db.transaction("blobs").objectStore("blobs").count(k))) > 0;
  }
  async listBlobKeys() {
    return (await req(this.db.transaction("blobs").objectStore("blobs").getAllKeys())) as string[];
  }
  async deleteBlobs(keys: string[]) {
    const tx = this.db.transaction("blobs", "readwrite");
    const finished = done(tx);
    for (const k of keys) tx.objectStore("blobs").delete(k);
    await finished;
  }
  async putSession(s: SessionRecord) {
    const tx = this.db.transaction("sessions", "readwrite");
    const finished = done(tx);
    tx.objectStore("sessions").put(s);
    await finished;
  }
  async listSessions() {
    return (await req(this.db.transaction("sessions").objectStore("sessions").getAll())) as SessionRecord[];
  }
  async deleteSession(id: string) {
    const tx = this.db.transaction("sessions", "readwrite");
    const finished = done(tx);
    tx.objectStore("sessions").delete(id);
    await finished;
  }
  async putHandle(fp: string, h: FileSystemFileHandle) {
    const tx = this.db.transaction("handles", "readwrite");
    const finished = done(tx);
    tx.objectStore("handles").put(h, fp);
    await finished;
  }
  async getHandle(fp: string) {
    return (await req(this.db.transaction("handles").objectStore("handles").get(fp))) as FileSystemFileHandle | undefined;
  }
  async listHandles() {
    return (await req(this.db.transaction("handles").objectStore("handles").getAll())) as FileSystemFileHandle[];
  }
}
