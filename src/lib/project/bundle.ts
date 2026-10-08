/**
 * PROJECT BUNDLE (PROJECT_PERSISTENCE_ARCHITECTURE.md §3) — the single `.clipbench` file Save writes and Open reads.
 *
 *   "CLIPBNDL"  u32 version  u32 manifestLength  manifest JSON (utf-8)
 *   entry bytes, back to back, in manifest order
 *   "CLIPEND!"  u64 totalLength (incl. trailer)  SHA-256 of every byte before the trailer (32 bytes)
 *
 * The manifest lists every entry with its offset, length and SHA-256. Decoding checks, in order: magic, trailer
 * present, declared length = actual length (catches truncation, the usual result of an interrupted write), the
 * whole-file hash, then each entry's hash — so a damaged file is refused with WHAT is damaged, never half-loaded.
 * Pure (Uint8Array in/out, WebCrypto for hashing): runs in the browser and in Node tests alike.
 */

export const BUNDLE_MAGIC = "CLIPBNDL";
export const BUNDLE_TRAILER = "CLIPEND!";
export const BUNDLE_VERSION = 1;
const TRAILER_LENGTH = 8 + 8 + 32;

export interface BundleEntryInfo {
  name: string;
  offset: number;
  length: number;
  sha256: string;
}

export interface BundleManifest {
  bundleVersion: number;
  entries: BundleEntryInfo[];
}

export class ProjectCorruptError extends Error {
  constructor(
    message: string,
    /** Entry names whose content failed verification (empty when the file as a whole is unreadable). */
    readonly damagedEntries: string[] = [],
  ) {
    super(message);
    this.name = "ProjectCorruptError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encodeBundle(entries: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const names = new Set<string>();
  for (const e of entries) {
    if (!e.name || names.has(e.name)) throw new Error(`Bundle entry names must be unique and non-empty ("${e.name}").`);
    names.add(e.name);
  }
  const infos: BundleEntryInfo[] = [];
  let offset = 0;
  for (const e of entries) {
    infos.push({ name: e.name, offset, length: e.data.length, sha256: await sha256Hex(e.data) });
    offset += e.data.length;
  }
  const manifest = enc.encode(JSON.stringify({ bundleVersion: BUNDLE_VERSION, entries: infos } satisfies BundleManifest));
  const headerLength = 8 + 4 + 4 + manifest.length;
  const total = headerLength + offset + TRAILER_LENGTH;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(enc.encode(BUNDLE_MAGIC), 0);
  view.setUint32(8, BUNDLE_VERSION, true);
  view.setUint32(12, manifest.length, true);
  out.set(manifest, 16);
  let p = headerLength;
  for (const e of entries) {
    out.set(e.data, p);
    p += e.data.length;
  }
  out.set(enc.encode(BUNDLE_TRAILER), p);
  view.setBigUint64(p + 8, BigInt(total), true);
  const whole = await crypto.subtle.digest("SHA-256", out.subarray(0, p) as Uint8Array<ArrayBuffer>);
  out.set(new Uint8Array(whole), p + 16);
  return out;
}

export interface DecodedBundle {
  manifest: BundleManifest;
  /** Entries whose hash verified. */
  entries: Map<string, Uint8Array>;
}

/**
 * Verifies and splits a bundle. `tolerateDamagedEntries`: entries listed here may fail their own hash without failing
 * the whole file (they're reported in `damaged` and left out) — used for embedded generated media, so a flipped byte
 * in one matte costs that matte, not the project. The whole-file hash must still hold unless the damage is confined
 * to tolerated entries.
 */
export async function decodeBundle(bytes: Uint8Array, opts: { tolerateDamaged?: (name: string) => boolean } = {}): Promise<DecodedBundle & { damaged: string[] }> {
  if (bytes.length < 16 + TRAILER_LENGTH) throw new ProjectCorruptError(`The file is too short to be a project (${bytes.length} bytes).`);
  if (String.fromCharCode(...bytes.subarray(0, 8)) !== BUNDLE_MAGIC) throw new ProjectCorruptError("Not a Clipbench project file (wrong signature).");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  if (version < 1 || version > BUNDLE_VERSION) throw new ProjectCorruptError(`Unsupported bundle version ${version} (this build reads 1–${BUNDLE_VERSION}).`);
  const t = bytes.length - TRAILER_LENGTH;
  if (String.fromCharCode(...bytes.subarray(t, t + 8)) !== BUNDLE_TRAILER) {
    throw new ProjectCorruptError("The project file is incomplete: its end marker is missing (the save was probably interrupted).");
  }
  const declared = Number(view.getBigUint64(t + 8, true));
  if (declared !== bytes.length) throw new ProjectCorruptError(`The project file is ${bytes.length} bytes but declares ${declared}: it was truncated or extended.`);
  const manifestLength = view.getUint32(12, true);
  const headerLength = 16 + manifestLength;
  if (headerLength > t) throw new ProjectCorruptError("The project file's table of contents is damaged.");
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(dec.decode(bytes.subarray(16, headerLength))) as BundleManifest;
  } catch {
    throw new ProjectCorruptError("The project file's table of contents is damaged (unreadable).");
  }
  if (!manifest || !Array.isArray(manifest.entries)) throw new ProjectCorruptError("The project file's table of contents is damaged (no entries).");
  const dataLength = t - headerLength;
  for (const e of manifest.entries) {
    if (typeof e.name !== "string" || !Number.isInteger(e.offset) || !Number.isInteger(e.length) || e.offset < 0 || e.length < 0 || e.offset + e.length > dataLength || typeof e.sha256 !== "string") {
      throw new ProjectCorruptError(`The project file's table of contents is damaged (entry "${String(e.name)}").`);
    }
  }
  const entries = new Map<string, Uint8Array>();
  const damaged: string[] = [];
  for (const e of manifest.entries) {
    const data = bytes.subarray(headerLength + e.offset, headerLength + e.offset + e.length);
    if ((await sha256Hex(data)) === e.sha256) entries.set(e.name, data);
    else damaged.push(e.name);
  }
  const whole = await sha256Hex(bytes.subarray(0, t));
  const wholeOk = whole === [...bytes.subarray(t + 16, t + 48)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const fatal = damaged.filter((n) => !opts.tolerateDamaged?.(n));
  if (fatal.length) throw new ProjectCorruptError(`The project file is damaged: ${fatal.join(", ")} failed verification.`, fatal);
  // Whole-file hash failing with every entry intact = the header/manifest bytes changed in a way JSON still parses.
  if (!wholeOk && damaged.length === 0) throw new ProjectCorruptError("The project file is damaged (checksum mismatch outside the stored entries).");
  return { manifest, entries, damaged };
}
