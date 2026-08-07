/** Returns the first MediaRecorder-supported mime type from the candidate list. */
export function pickSupportedMimeType(candidates: string[]): string {
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
}

export const VIDEO_RECORDER_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export const AUDIO_RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}
