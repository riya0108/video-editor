import type { ProjectStore, SessionRecord, VersionSummary } from "./storage";

/**
 * CRASH DETECTION & RECOVERY (PROJECT_PERSISTENCE_ARCHITECTURE.md §7).
 *
 * Every editor tab writes a session row and refreshes its heartbeat every HEARTBEAT_MS. Closing the tab normally
 * (pagehide) marks the row clean. On the next start, a row that is NOT clean and whose heartbeat is older than
 * STALE_MS belongs to a tab that died (crash, killed process, power loss). Rows still beating belong to other open
 * tabs and are left alone, so two tabs never steal each other's work.
 *
 * The clean flag is ALSO written to a synchronous store (localStorage in the app): an IndexedDB write started in
 * `pagehide` is aborted when Chrome tears the page down (found live: every normally closed tab looked crashed), while
 * a synchronous write completes before the handler returns.
 *
 * A dead session's project is RECOVERABLE when its newest stored version is newer than the last explicit save, i.e.
 * there is autosaved work the user never saved. Recovery opens that version; dismissing keeps it in version history.
 */

export const HEARTBEAT_MS = 5000;
export const STALE_MS = 15000;

/** Synchronous "closed cleanly" marks, keyed by session id. */
export interface CleanFlags {
  set(id: string): void;
  has(id: string): boolean;
  clear(id: string): void;
}

export function localStorageCleanFlags(prefix = "clipbench.session.clean."): CleanFlags {
  return {
    set: (id) => {
      try {
        localStorage.setItem(prefix + id, "1");
      } catch {
        /* storage unavailable: falls back to the IndexedDB flag */
      }
    },
    has: (id) => {
      try {
        return localStorage.getItem(prefix + id) === "1";
      } catch {
        return false;
      }
    },
    clear: (id) => {
      try {
        localStorage.removeItem(prefix + id);
      } catch {
        /* ignore */
      }
    },
  };
}

export interface Recoverable {
  sessionId: string;
  projectId: string;
  name: string;
  version: VersionSummary;
  lastSavedRevision: number;
}

export class SessionTracker {
  private record: SessionRecord;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ProjectStore,
    readonly id: string,
    private readonly now: () => number = () => Date.now(),
    private readonly flags?: CleanFlags,
  ) {
    const t = now();
    this.record = { id, projectId: null, startedAt: t, heartbeat: t, clean: false };
  }

  async start(intervalMs = HEARTBEAT_MS): Promise<void> {
    await this.store.putSession(this.record);
    if (intervalMs > 0) this.timer = setInterval(() => void this.beat(), intervalMs);
  }

  async beat(): Promise<void> {
    this.record = { ...this.record, heartbeat: this.now() };
    await this.store.putSession(this.record);
  }

  async setProject(projectId: string | null): Promise<void> {
    this.record = { ...this.record, projectId };
    await this.beat();
  }

  /** Normal close: the row stays (clean) so a later start can tell this tab didn't crash. Safe to call from pagehide: the synchronous flag is set before anything async. */
  async end(): Promise<void> {
    this.flags?.set(this.id);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.record = { ...this.record, clean: true, heartbeat: this.now() };
    await this.store.putSession(this.record);
  }

  stopBeating(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Projects left with unsaved autosaved work by tabs that died. Clean or still-beating sessions are ignored. */
export async function findRecoverable(store: ProjectStore, opts: { now?: number; ownSessionId?: string; staleMs?: number; flags?: CleanFlags; pruneDead?: boolean } = {}): Promise<Recoverable[]> {
  const now = opts.now ?? Date.now();
  const stale = opts.staleMs ?? STALE_MS;
  const out: Recoverable[] = [];
  const seen = new Set<string>();
  for (const s of await store.listSessions()) {
    if (s.id === opts.ownSessionId || now - s.heartbeat < stale) continue;
    const clean = s.clean || !!opts.flags?.has(s.id);
    const meta = s.projectId && !clean ? await store.getMeta(s.projectId) : undefined;
    const newest = meta ? (await store.listVersions(meta.id)).at(-1) : undefined;
    const recoverable = !!(meta && newest && newest.revision > meta.lastSavedRevision && !seen.has(meta.id));
    if (recoverable) {
      seen.add(meta!.id);
      out.push({ sessionId: s.id, projectId: meta!.id, name: meta!.name, version: newest!, lastSavedRevision: meta!.lastSavedRevision });
    } else if (opts.pruneDead && !clean) {
      // Dead with nothing to recover (or its project already offered): nothing will ever need this row.
      await store.deleteSession(s.id);
    }
  }
  return out.sort((a, b) => b.version.savedAt - a.version.savedAt);
}

/** Drops the given (recovered / dismissed) sessions and every cleanly closed one — those never need recovery. */
export async function cleanupSessions(store: ProjectStore, ids: string[], now = Date.now(), flags?: CleanFlags): Promise<void> {
  for (const s of await store.listSessions()) {
    const clean = s.clean || !!flags?.has(s.id);
    if (ids.includes(s.id) || (clean && now - s.heartbeat >= 0)) {
      await store.deleteSession(s.id);
      flags?.clear(s.id);
    }
  }
}
