/**
 * AUTOSAVE (PROJECT_PERSISTENCE_ARCHITECTURE.md §6). Edits mark the project dirty; a save runs `delayMs` after the
 * last edit, and at the latest `maxDelayMs` after the first unsaved edit (continuous editing can't postpone it
 * forever). Saves never overlap: an edit made while one is running schedules another afterwards. A failed autosave
 * keeps the project dirty and retries on the next edit or after `retryMs`; its error is reported, never swallowed.
 */

export type AutosaveStatus = { state: "idle" | "pending" | "saving" | "error"; lastSavedAt: number | null; error: string | null };

export interface AutosaveOptions {
  save: () => Promise<void>;
  delayMs?: number;
  maxDelayMs?: number;
  retryMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Autosaver {
  private timer: unknown = null;
  private firstDirtyAt: number | null = null;
  private running: Promise<void> | null = null;
  private dirtyDuringSave = false;
  private disposed = false;
  private status: AutosaveStatus = { state: "idle", lastSavedAt: null, error: null };
  private readonly listeners = new Set<(s: AutosaveStatus) => void>();
  private readonly o: Required<AutosaveOptions>;

  constructor(opts: AutosaveOptions) {
    this.o = {
      delayMs: 2000,
      maxDelayMs: 15000,
      retryMs: 10000,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  get current(): AutosaveStatus {
    return this.status;
  }

  onStatus(fn: (s: AutosaveStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  /** Call after every edit. */
  markDirty(): void {
    if (this.disposed) return;
    if (this.running) {
      this.dirtyDuringSave = true;
      return;
    }
    const now = this.o.now();
    this.firstDirtyAt ??= now;
    const wait = Math.max(0, Math.min(this.o.delayMs, this.firstDirtyAt + this.o.maxDelayMs - now));
    this.schedule(wait);
    if (this.status.state !== "error") this.set({ state: "pending" });
  }

  /** Saves now if anything is pending (e.g. before the tab hides). Resolves when the save (if any) finished. */
  async flush(): Promise<void> {
    if (this.running) await this.running;
    if (this.firstDirtyAt !== null || this.dirtyDuringSave) await this.run();
  }

  /** Forget pending work (e.g. right after an explicit Save wrote the same state). */
  clear(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.firstDirtyAt = null;
    this.dirtyDuringSave = false;
    if (!this.running) this.set({ state: "idle", error: null });
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }

  private schedule(ms: number) {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.running) return;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.firstDirtyAt = null;
    this.dirtyDuringSave = false;
    this.set({ state: "saving" });
    this.running = (async () => {
      try {
        await this.o.save();
        this.set({ state: "idle", lastSavedAt: this.o.now(), error: null });
      } catch (e) {
        this.firstDirtyAt = this.o.now();
        this.set({ state: "error", error: (e as Error | null)?.message || "Saving to this browser's storage failed." });
        this.schedule(this.o.retryMs);
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    if (this.dirtyDuringSave && !this.disposed) {
      this.dirtyDuringSave = false;
      this.markDirty();
    }
  }

  private set(patch: Partial<AutosaveStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }
}
