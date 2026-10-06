import { validateUploadedMediaFile } from "../media/upload-validation";
import { checkAudioFile, isAudioFileName } from "../audio/safety";

/**
 * MEDIA IMPORT for the composition editor: decides whether a picked/dropped
 * file can become a layer, and turns every failure into a message a user can
 * act on. Wraps (doesn't replace) the app's existing upload validation.
 *
 * Pure apart from reading File metadata — unit-testable in Node.
 */

export type ImportClassification = { ok: true; kind: "image" | "video" | "svg" | "audio" } | { ok: false; message: string };
const HEIC_EXT = /\.(heic|heif)$/i;

export function classifyImport(file: File): ImportClassification {
  // Audio (Phase 11): music, voiceover, SFX, ambient — checked for format and size before anything is read.
  if (isAudioFileName(file.name, file.type)) {
    const a = checkAudioFile(file);
    return a.ok ? { ok: true, kind: "audio" } : { ok: false, message: a.message };
  }
  if (/image\/hei[cf]/i.test(file.type) || HEIC_EXT.test(file.name)) {
    return { ok: false, message: `${file.name}: HEIC/HEIF photos (the iPhone default) can't be decoded by this browser. Export it as JPG or PNG (on iPhone: Settings › Camera › Formats › Most Compatible) and add that instead.` };
  }
  // SVG is vector: it becomes an editable, sharp-at-any-size SVG graphic (sanitized and embedded), not a fixed-resolution bitmap.
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    if (file.size > 1024 * 1024) return { ok: false, message: `${file.name}: SVG files over 1 MB aren't supported.` };
    return { ok: true, kind: "svg" };
  }
  const v = validateUploadedMediaFile(file);
  if (!v.ok || !v.kind) return { ok: false, message: `${file.name}: ${v.message ?? "unsupported file type."}` };
  return { ok: true, kind: v.kind };
}

/** A decode failure (file passed validation but the browser couldn't open it), phrased for the user. */
export function describeDecodeFailure(file: File, kind: "image" | "video" | "svg" | "audio", error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (kind === "svg") return `${file.name}: ${error instanceof Error ? error.message : "this SVG couldn't be read."}`;
  if (kind === "video") {
    return `${file.name}: this browser couldn't play the video (${detail}). It may use a codec your browser lacks (e.g. HEVC/H.265 or ProRes) — try an H.264 MP4 or a WebM.`;
  }
  return `${file.name}: this browser couldn't open the image (${detail}). Try a JPG, PNG or WebP.`;
}

/** Files carried by a drag event (only real files — not dragged text/links). */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []);
}

/** Whether a drag is carrying files (checked on dragenter/over, before the files themselves are readable). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}
