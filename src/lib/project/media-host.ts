import type { MediaFrameProvider } from "../composition/media-frame-provider";
import type { AudioSourceStore } from "../audio/source-store";
import { assetUsage, fingerprintBlob, type AssetKind, type AssetRecord } from "./assets";
import { sameOrigin, type AssetRegistry } from "./asset-registry";
import type { ProjectDocument } from "./document";
import type { AssetStatus, EditorState, ProjectHost } from "./manager";
import type { ProjectStore } from "./storage";

/**
 * MEDIA HOST (PROJECT_PERSISTENCE_ARCHITECTURE.md §4, browser only) — resolves a document's asset records back into
 * decoded media in the frame provider (pictures) and audio store (sound), and reports what it couldn't:
 *
 *   generated  PNG frames from the project file / local blob store        → "damaged" if a frame is gone or corrupt
 *   url        fetched from the app                                        → "missing" if it no longer loads
 *   file       1. the same file already open in this session (by fingerprint)
 *              2. a stored READ handle for that fingerprint (permission granted, content re-verified)
 *              3. otherwise "needs-permission" (handle known, browser must ask) or "missing" (relink)
 *
 * Source files are only ever READ (getFile / object URLs).
 */

type PermHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
};

export interface MediaHostDeps {
  provider: MediaFrameProvider;
  audio: AudioSourceStore;
  registry: AssetRegistry;
  store: ProjectStore;
  fps: number;
}

export function kindOfFile(file: File): AssetKind | null {
  const t = file.type;
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (["mp4", "mov", "webm", "mkv", "m4v"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].includes(ext)) return "image";
  if (["wav", "mp3", "m4a", "aac", "ogg", "flac", "opus"].includes(ext)) return "audio";
  return null;
}

export function createMediaHost(d: MediaHostDeps, editor: { snapshot(): EditorState; apply(doc: ProjectDocument): void }): ProjectHost {
  const unload = (id: string) => {
    d.provider.remove(id);
    d.audio.remove(id);
  };
  const isLoaded = (id: string, kind: AssetKind) => (kind === "audio" ? ["ready", "no-audio"].includes(d.audio.status(id).state) : d.provider.has(id));

  /** Loads media from a URL or Blob under `id`. Returns what was decoded. */
  async function load(id: string, kind: AssetKind, src: string | Blob, label: string) {
    unload(id);
    if (kind === "video") {
      const url = typeof src === "string" ? src : URL.createObjectURL(src);
      const { info, durationSec } = await d.provider.addVideo(id, url, d.fps, typeof src === "string" ? undefined : src);
      // Its soundtrack: awaited, so a render right after opening never finds the audio still decoding.
      await d.audio.add(id, url, label, { video: true });
      return { kind, width: info.width, height: info.height, durationSec };
    }
    if (kind === "audio") {
      const st = await d.audio.add(id, src, label);
      if (st.state !== "ready") throw new Error(st.state === "error" ? st.message : "no audio could be decoded");
      return { kind, durationSec: st.durationSec };
    }
    const info = await d.provider.addImage(id, src);
    return { kind, width: info.width, height: info.height };
  }

  async function resolveOne(rec: AssetRecord, pngFor: (sha: string) => Promise<Uint8Array | undefined>, requestPermission: boolean): Promise<AssetStatus> {
    const base = { id: rec.id, label: rec.label, kind: rec.kind };
    const existing = d.registry.get(rec.id);
    if (existing && sameOrigin(existing, rec) && isLoaded(rec.id, rec.kind)) {
      d.registry.adopt(rec, d.registry.fileFor(rec.id));
      return { ...base, state: "ok" };
    }
    const o = rec.origin;
    if (o.type === "generated") {
      const frames: { frame: number; image: ImageBitmap }[] = [];
      for (const f of o.frames) {
        const png = await pngFor(f.sha256);
        if (!png) return { ...base, state: "damaged", detail: `Its stored frame ${f.frame} is missing or damaged. Generate it again (e.g. re-run background removal).` };
        d.registry.addPng(f.sha256, png);
        frames.push({ frame: f.frame, image: await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" })) });
      }
      unload(rec.id);
      if (rec.kind === "sequence") d.provider.addFrameSequence(rec.id, frames);
      else d.provider.addStill(rec.id, frames[0].image);
      d.registry.adopt(rec);
      return { ...base, state: "ok" };
    }
    if (o.type === "url") {
      try {
        await load(rec.id, rec.kind, o.url, rec.label);
        d.registry.adopt(rec);
        return { ...base, state: "ok" };
      } catch (e) {
        return { ...base, state: "missing", detail: `Couldn't load ${o.url}: ${(e as Error).message}` };
      }
    }
    // User media: in this session already, or via a stored handle.
    let found = d.registry.fileByFingerprint(o.fingerprint);
    if (!found) {
      const h = (await d.store.getHandle(o.fingerprint)) as PermHandle | undefined;
      if (h) {
        let perm = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
        if (perm !== "granted" && requestPermission) perm = (await h.requestPermission?.({ mode: "read" })) ?? perm;
        if (perm !== "granted") return { ...base, state: "needs-permission", detail: `The browser needs your permission to read "${o.name}" again.` };
        try {
          const file = await h.getFile();
          if ((await fingerprintBlob(file)) !== o.fingerprint) return { ...base, state: "missing", detail: `"${o.name}" has changed on disk since it was added. Relink to accept the new version.` };
          found = { file, handle: h };
        } catch {
          return { ...base, state: "missing", detail: `"${o.name}" was moved or deleted.` };
        }
      }
    }
    if (!found) return { ...base, state: "missing", detail: `"${o.name}" (${(o.size / 1e6).toFixed(1)} MB) isn't available in this browser session.` };
    try {
      await load(rec.id, rec.kind, found.file, rec.label);
    } catch (e) {
      return { ...base, state: "missing", detail: `"${o.name}" couldn't be decoded: ${(e as Error).message}` };
    }
    d.registry.adopt(rec, found);
    return { ...base, state: "ok" };
  }

  return {
    snapshot: () => editor.snapshot(),
    apply: (doc) => editor.apply(doc),

    async materialize(doc, pngFor, opts = {}) {
      const usage = assetUsage(doc.timeline);
      const records = new Map(doc.assets.map((a) => [a.id, a]));
      if (!opts.only) {
        // Media of the previous project that this one doesn't use is released (ids could otherwise collide).
        for (const r of d.registry.all()) {
          if (!records.has(r.id) && !usage.has(r.id)) {
            unload(r.id);
            d.registry.remove(r.id);
          }
        }
      }
      const ids = opts.only ?? [...new Set([...usage.keys(), ...records.keys()])].sort();
      const out: AssetStatus[] = [];
      for (const id of ids) {
        const rec = records.get(id);
        if (rec) {
          out.push(await resolveOne(rec, pngFor, !!opts.requestPermission));
          continue;
        }
        // No record (pre-Phase-17 project): fine if the media happens to be loaded, otherwise it must be relinked.
        const u = usage.get(id);
        const clip = u ? doc.timeline.clips[u.clipIds[0]] : undefined;
        const k = clip?.content.kind;
        const kind: AssetKind = u?.roles.has("matte") && !u.roles.has("media") ? "still" : k === "audio" ? "audio" : k === "video" || k === "overlay" ? "video" : "image";
        out.push({ id, label: u?.label ?? id, kind, state: isLoaded(id, kind) ? "ok" : "missing", detail: isLoaded(id, kind) ? undefined : "The project doesn't record where this media came from (older save). Relink it." });
      }
      return out;
    },

    async probeAndRegister(id, _kind, file) {
      const kind = kindOfFile(file);
      if (!kind) throw new Error(`"${file.name}" isn't a supported video, image or audio file.`);
      return load(id, kind, file, file.name);
    },

    unregister: unload,
  };
}

/** PNG bytes of a canvas/bitmap (lossless, alpha preserved) — how generated media is stored. */
export async function encodePng(image: CanvasImageSource & { width: number; height: number }): Promise<Uint8Array> {
  const c = new OffscreenCanvas(image.width, image.height);
  c.getContext("2d")!.drawImage(image, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}
