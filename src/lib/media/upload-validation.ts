import { IMAGE_EXT_MIME, VIDEO_EXT_MIME } from "../ffmpeg/format";

/**
 * PHASE 17 — MEDIA SECURITY (#6/#7, "validate file types" / "validate file
 * size"). Runs BEFORE a file is turned into an object URL or handed to any
 * decoder — rejecting here means we never even attempt to load an
 * obviously-wrong or oversized file, rather than relying solely on a
 * decoder's own onerror (which already exists as a second line of defense,
 * see handleImageError/handleVideoError in RemoveBackgroundTool.tsx, for
 * files that pass this check but still fail to decode).
 */

// Generous enough for a real high-resolution photo (a 24MP uncompressed
// RGBA frame — this app's own MAX_PIXELS ceiling — is ~96MB decoded) without
// letting an arbitrarily huge file sit in memory before we even know its
// dimensions.
const MAX_IMAGE_BYTES = 150 * 1024 * 1024; // 150MB
// ffmpeg.wasm loads whichever file it's given entirely into its wasm heap;
// this is a safety ceiling against exhausting that, not a claim about what
// the UI elsewhere considers a "reasonable" video.
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

export interface UploadValidationResult {
  ok: boolean;
  /** Present only when ok is false — a user-facing explanation. */
  message?: string;
  /** Present only when ok is true. */
  kind?: "image" | "video";
}

function extensionOf(file: File): string | undefined {
  return file.name.split(".").pop()?.toLowerCase();
}

/** Same allowlist-by-extension approach as guessVideoExtension/guessImageExtension in format.ts — never trusts an arbitrary extension string, only ones present as a key in the known MIME maps. */
function guessKindFromExtension(file: File): "image" | "video" | undefined {
  const ext = extensionOf(file);
  if (!ext) return undefined;
  if (ext in IMAGE_EXT_MIME) return "image";
  if (ext in VIDEO_EXT_MIME) return "video";
  return undefined;
}

/**
 * Validates a file picked for the Remove Background tool before it's used
 * for anything. Rejects unsupported file types and oversized files with a
 * clear message; never throws.
 */
export function validateUploadedMediaFile(file: File): UploadValidationResult {
  let kind: "image" | "video" | undefined;
  if (file.type.startsWith("image/")) kind = "image";
  else if (file.type.startsWith("video/")) kind = "video";
  else kind = guessKindFromExtension(file);

  if (!kind) {
    return {
      ok: false,
      message: "That file doesn't look like an image or video we support. Try a JPG, PNG, WebP, MP4, MOV, or WebM file.",
    };
  }

  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > maxBytes) {
    const limitLabel = kind === "image" ? "150MB" : "2GB";
    return {
      ok: false,
      message: `That file is too large (over ${limitLabel}) for this tool to process in-browser. Try a smaller or compressed file.`,
    };
  }

  if (file.size === 0) {
    return { ok: false, message: "That file is empty." };
  }

  return { ok: true, kind };
}
