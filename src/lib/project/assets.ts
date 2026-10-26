import type { TimelineModel } from "../timeline/model";
import { isTrimmableContent } from "../timeline/clip";
import { sha256Hex } from "./bundle";

/**
 * PROJECT ASSETS (PROJECT_PERSISTENCE_ARCHITECTURE.md §4). Every `sourceId` the timeline (or an AI result) uses has an
 * AssetRecord saying where its media comes from:
 *
 *  - "file"      the user's own media (video / image / audio). REFERENCED ONLY: name, size, date and a content
 *                fingerprint. The bytes are never copied into the project and the file is never opened for writing.
 *  - "url"       media the app itself serves (e.g. the demo clip).
 *  - "generated" media this app CREATED — background-removal mattes, AI-registered images, procedural stills. It
 *                exists nowhere else, so its data is stored IN the project (blobs content-addressed by SHA-256):
 *                stills and (pre-B-05) sequences as one PNG per frame; a "matte-track" as matte-track.ts chunks, one
 *                blob per chunk of frames.
 */

export type AssetKind = "video" | "image" | "audio" | "still" | "sequence" | "matte-track";

/** One stored blob of generated media: a frame's PNG (still / sequence) or a chunk of frames (matte-track). */
export interface GeneratedFrame {
  /** Source frame (sequences), first source frame of the chunk (matte-track); 0 for a still. */
  frame: number;
  sha256: string;
  size: number;
  width: number;
  height: number;
}

export type AssetOrigin =
  | { type: "file"; name: string; size: number; lastModified: number; mimeType: string; fingerprint: string }
  | { type: "url"; url: string }
  | { type: "generated"; generator: string; frames: GeneratedFrame[] };

export interface AssetRecord {
  /** = the timeline's sourceId. */
  id: string;
  kind: AssetKind;
  label: string;
  origin: AssetOrigin;
  /** What the media was when it was added; used to validate a relink. */
  media?: { width?: number; height?: number; durationSec?: number; fps?: number; hasAudio?: boolean };
}

/** Bytes hashed from each end of a file for its fingerprint. */
export const FINGERPRINT_EDGE = 1 << 20;

/**
 * Content fingerprint of a media file: SHA-256 over its size and its first and last MiB. Reads at most 2 MiB however
 * large the file is, and tells apart two different takes with the same name — a renamed copy still matches.
 */
export async function fingerprintBlob(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, FINGERPRINT_EDGE)).arrayBuffer());
  const tail = blob.size > FINGERPRINT_EDGE ? new Uint8Array(await blob.slice(Math.max(FINGERPRINT_EDGE, blob.size - FINGERPRINT_EDGE)).arrayBuffer()) : new Uint8Array(0);
  const size = new TextEncoder().encode(`${blob.size}|`);
  const all = new Uint8Array(size.length + head.length + tail.length);
  all.set(size, 0);
  all.set(head, size.length);
  all.set(tail, size.length + head.length);
  return sha256Hex(all);
}

export async function fileOrigin(file: File): Promise<Extract<AssetOrigin, { type: "file" }>> {
  return { type: "file", name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type, fingerprint: await fingerprintBlob(file) };
}

export interface AssetUsage {
  sourceId: string;
  clipIds: string[];
  /** "media": a clip's content; "matte": a clip's matte. */
  roles: Set<"media" | "matte">;
  /** Furthest source frame any clip reads (exclusive), project frames — a relinked file must be at least this long. */
  maxSourceFrame: number;
  label?: string;
}

/** Every source the timeline references, with what it needs from that source. */
export function assetUsage(timeline: TimelineModel): Map<string, AssetUsage> {
  const out = new Map<string, AssetUsage>();
  const use = (id: string, clipId: string, role: "media" | "matte", maxFrame: number, label?: string) => {
    let u = out.get(id);
    if (!u) out.set(id, (u = { sourceId: id, clipIds: [], roles: new Set(), maxSourceFrame: 0, label }));
    if (!u.clipIds.includes(clipId)) u.clipIds.push(clipId);
    u.roles.add(role);
    u.maxSourceFrame = Math.max(u.maxSourceFrame, maxFrame);
    u.label ??= label;
  };
  for (const c of Object.values(timeline.clips)) {
    const src = c.content.source;
    if (src) use(src.sourceId, c.id, "media", isTrimmableContent(c.content) ? c.content.sourceOutFrame : 0, src.label);
    if (c.visual?.matte) use(c.visual.matte.sourceId, c.id, "matte", isTrimmableContent(c.content) ? c.content.sourceOutFrame : 0);
  }
  return out;
}

export type RelinkMatch = "exact" | "renamed" | "same-name-different-content" | "none";

/** How a candidate file relates to a missing asset. Exact / renamed (same content) relink automatically; a different file with the same name needs the user's confirmation. */
export async function matchRelink(record: AssetRecord, file: File): Promise<RelinkMatch> {
  if (record.origin.type !== "file") return "none";
  const sameContent = file.size === record.origin.size && (await fingerprintBlob(file)) === record.origin.fingerprint;
  if (sameContent) return file.name === record.origin.name ? "exact" : "renamed";
  return file.name === record.origin.name ? "same-name-different-content" : "none";
}

export interface RelinkCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Can `probe` (the replacement media, as decoded) stand in for `record` given how the timeline uses it? Wrong kind or
 * too short = refused (clips would read past its end). Different size or content = allowed with a warning.
 */
export function checkRelink(record: AssetRecord, probe: { kind: AssetKind; width?: number; height?: number; durationSec?: number }, usage: AssetUsage | undefined, fps: number, match: RelinkMatch): RelinkCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const visual = (k: AssetKind) => k === "video" || k === "image" || k === "still";
  const compatible = probe.kind === record.kind || (visual(probe.kind) && visual(record.kind) && record.kind !== "video" && probe.kind !== "video") || (record.kind === "audio" && probe.kind === "video");
  if (!compatible) errors.push(`"${record.label}" was ${article(record.kind)} ${record.kind}; the chosen file is ${article(probe.kind)} ${probe.kind}.`);
  if (usage && usage.maxSourceFrame > 0 && probe.durationSec !== undefined) {
    const needSec = usage.maxSourceFrame / fps;
    if (probe.durationSec + 0.5 / fps < needSec) errors.push(`The timeline uses "${record.label}" up to ${needSec.toFixed(2)} s, but the chosen file is only ${probe.durationSec.toFixed(2)} s long.`);
  }
  const m = record.media;
  if (m?.width && probe.width && (m.width !== probe.width || m.height !== probe.height)) warnings.push(`Size differs: was ${m.width}×${m.height}, now ${probe.width}×${probe.height}. Fit and crop are kept, so framing may shift.`);
  if (match === "same-name-different-content") warnings.push(`This file has the same name as "${record.label}" but different content.`);
  if (match === "none") warnings.push(`This isn't the original "${record.label}" (different name and content).`);
  return { ok: errors.length === 0, errors, warnings };
}

const article = (w: string) => (/^[aeiou]/.test(w) ? "an" : "a");
