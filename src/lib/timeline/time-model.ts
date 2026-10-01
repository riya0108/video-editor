/**
 * TIME MODEL. The only sanctioned boundary between seconds (what playback
 * APIs, UI display, and the rest of this app speak) and frames (what the
 * timeline engine speaks internally — see TIMELINE_ARCHITECTURE.md §3).
 * Every other module in src/lib/timeline/** takes and returns frames only.
 */

export type RoundMode = "nearest" | "floor" | "ceil";

export function secondsToFrames(seconds: number, fps: number, round: RoundMode = "nearest"): number {
  const raw = seconds * fps;
  switch (round) {
    case "floor":
      return Math.floor(raw);
    case "ceil":
      return Math.ceil(raw);
    case "nearest":
    default:
      return Math.round(raw);
  }
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/** HH:MM:SS:FF — the standard non-drop-frame timecode format. `frames` must be a non-negative integer. */
export function formatTimecode(frames: number, fps: number): string {
  const safeFrames = Math.max(0, Math.round(frames));
  const wholeFps = Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(safeFrames / wholeFps);
  const ff = safeFrames % wholeFps;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** Inverse of formatTimecode. Throws on a malformed string rather than silently returning 0 — a bad timecode is a caller bug worth surfacing. */
export function parseTimecode(timecode: string, fps: number): number {
  const match = /^(\d+):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode.trim());
  if (!match) throw new Error(`Malformed timecode "${timecode}" — expected HH:MM:SS:FF.`);
  const [, hh, mm, ss, ff] = match;
  const wholeFps = Math.max(1, Math.round(fps));
  const frameNum = Number(ff);
  if (frameNum >= wholeFps) {
    throw new Error(`Malformed timecode "${timecode}" — frame ${frameNum} is >= the ${wholeFps}fps rate.`);
  }
  const totalSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  return totalSeconds * wholeFps + frameNum;
}

export function clampFrame(frame: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, frame));
}
