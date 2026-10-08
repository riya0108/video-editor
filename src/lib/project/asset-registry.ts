import { sha256Hex } from "./bundle";
import { fingerprintBlob, type AssetKind, type AssetRecord, type GeneratedFrame } from "./assets";

/**
 * ASSET REGISTRY (PROJECT_PERSISTENCE_ARCHITECTURE.md §4) — the session's knowledge of where each sourceId's media
 * came from, kept next to the frame provider / audio store that hold the decoded media itself.
 *
 * User files are held as the File (and, when the browser gave one, a READ handle) for this session only; generated
 * media is held as the PNG bytes of each frame, keyed by SHA-256, ready to be written into a project or the local
 * blob store. Nothing here writes to a user file — there is no code path that could.
 */
export class AssetRegistry {
  private readonly records = new Map<string, AssetRecord>();
  private readonly pngs = new Map<string, Uint8Array>();
  private readonly files = new Map<string, { file: Blob; handle?: FileSystemFileHandle }>();
  private readonly listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  get(id: string): AssetRecord | undefined {
    return this.records.get(id);
  }

  all(): AssetRecord[] {
    return [...this.records.values()];
  }

  /** Records for the given ids, in id order (stable documents → stable checksums). */
  recordsFor(ids: Iterable<string>): AssetRecord[] {
    return [...new Set(ids)].sort().flatMap((id) => {
      const r = this.records.get(id);
      return r ? [r] : [];
    });
  }

  async setFile(id: string, kind: AssetKind, file: File, media?: AssetRecord["media"], handle?: FileSystemFileHandle): Promise<AssetRecord> {
    const record: AssetRecord = {
      id,
      kind,
      label: file.name,
      origin: { type: "file", name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type, fingerprint: await fingerprintBlob(file) },
      media,
    };
    this.records.set(id, record);
    this.files.set(id, { file, handle });
    this.emit();
    return record;
  }

  setUrl(id: string, kind: AssetKind, label: string, url: string, media?: AssetRecord["media"]): AssetRecord {
    const record: AssetRecord = { id, kind, label, origin: { type: "url", url }, media };
    this.records.set(id, record);
    this.emit();
    return record;
  }

  /** Generated media (still: one frame at 0; sequence: frames keyed by source frame), as encoded PNG bytes. */
  async setGenerated(id: string, kind: "still" | "sequence", label: string, generator: string, frames: { frame: number; png: Uint8Array; width: number; height: number }[], media?: AssetRecord["media"]): Promise<AssetRecord> {
    if (frames.length === 0) throw new Error(`Generated asset "${id}" has no frames.`);
    const out: GeneratedFrame[] = [];
    for (const f of [...frames].sort((a, b) => a.frame - b.frame)) {
      const sha256 = await sha256Hex(f.png);
      this.pngs.set(sha256, f.png);
      out.push({ frame: f.frame, sha256, size: f.png.length, width: f.width, height: f.height });
    }
    const record: AssetRecord = { id, kind, label, origin: { type: "generated", generator, frames: out }, media };
    this.records.set(id, record);
    this.files.delete(id);
    this.emit();
    return record;
  }

  /** Adopts a record loaded from a project (its media resolved elsewhere). */
  adopt(record: AssetRecord, file?: { file: Blob; handle?: FileSystemFileHandle }): void {
    this.records.set(record.id, record);
    if (file) this.files.set(record.id, file);
    else if (record.origin.type !== "file") this.files.delete(record.id);
    this.emit();
  }

  addPng(sha256: string, png: Uint8Array): void {
    this.pngs.set(sha256, png);
  }

  png(sha256: string): Uint8Array | undefined {
    return this.pngs.get(sha256);
  }

  fileFor(id: string): { file: Blob; handle?: FileSystemFileHandle } | undefined {
    return this.files.get(id);
  }

  /** A file already open in this session with this content (any sourceId) — reopening needs no relink. */
  fileByFingerprint(fingerprint: string): { file: Blob; handle?: FileSystemFileHandle } | undefined {
    for (const [id, r] of this.records) if (r.origin.type === "file" && r.origin.fingerprint === fingerprint && this.files.has(id)) return this.files.get(id);
    return undefined;
  }

  /** Every READ handle of user media this session knows (Save refuses to write onto any of them). */
  sourceHandles(): FileSystemFileHandle[] {
    return [...this.files.values()].flatMap((f) => (f.handle ? [f.handle] : []));
  }

  remove(id: string): void {
    this.records.delete(id);
    this.files.delete(id);
    this.emit();
  }
}

/** Same media origin (the comparison used to skip reloading an asset that is already in place). */
export function sameOrigin(a: AssetRecord, b: AssetRecord): boolean {
  if (a.kind !== b.kind || a.origin.type !== b.origin.type) return false;
  if (a.origin.type === "file" && b.origin.type === "file") return a.origin.fingerprint === b.origin.fingerprint;
  if (a.origin.type === "url" && b.origin.type === "url") return a.origin.url === b.origin.url;
  if (a.origin.type === "generated" && b.origin.type === "generated") return a.origin.frames.map((f) => `${f.frame}:${f.sha256}`).join() === b.origin.frames.map((f) => `${f.frame}:${f.sha256}`).join();
  return false;
}
