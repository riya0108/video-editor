export const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  m4v: "video/mp4",
};

export const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  weba: "audio/webm",
};

export const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Overlay layers (emoji/stickers rendered to canvas) are plain Blobs with no
// filename, only a File has `.name` — fall back to sniffing MIME type alone.
function guessFromMap(file: File | Blob, map: Record<string, string>, fallback: string): string {
  const fromName = "name" in file ? file.name.split(".").pop()?.toLowerCase() : undefined;
  if (fromName && map[fromName]) return fromName;
  const entry = Object.entries(map).find(([, mime]) => mime === file.type);
  return entry?.[0] ?? fallback;
}

export function guessVideoExtension(file: File | Blob): string {
  return guessFromMap(file, VIDEO_EXT_MIME, "mp4");
}

export function guessAudioExtension(file: File | Blob): string {
  return guessFromMap(file, AUDIO_EXT_MIME, "mp3");
}

export function guessImageExtension(file: File | Blob): string {
  return guessFromMap(file, IMAGE_EXT_MIME, "png");
}

export function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}
