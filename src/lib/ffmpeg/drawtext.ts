/** Escapes text for safe use inside an ffmpeg drawtext filter's text= value. */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’") // ffmpeg's quoting for apostrophes is finicky — use a typographic apostrophe instead
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}
