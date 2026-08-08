import { nextCaptionId, type CaptionCue } from "./types";

const TIMESTAMP_LINE = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

function parseStamp(stamp: string): number {
  const [main, fracRaw] = stamp.trim().replace(",", ".").split(".");
  const frac = Number(`0.${fracRaw ?? "0"}`);
  const parts = main.split(":").map(Number);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds + frac;
}

/**
 * Parses SRT or WebVTT text into caption cues. Both formats are
 * "blocks separated by a blank line, containing a `start --> end` line and
 * one or more text lines" — SRT just adds a numeric index line before it,
 * and VTT can start with a "WEBVTT" header and NOTE/STYLE blocks, which we
 * skip since they don't contain a timestamp line.
 */
export function parseSubtitleText(content: string): CaptionCue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timestampIndex = lines.findIndex((l) => TIMESTAMP_LINE.test(l));
    if (timestampIndex === -1) continue;

    const match = lines[timestampIndex].match(
      /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/,
    );
    if (!match) continue;

    const start = parseStamp(match[1]);
    const end = parseStamp(match[2]);
    const text = lines
      .slice(timestampIndex + 1)
      .join("\n")
      .trim();
    if (!text) continue;

    cues.push({ id: nextCaptionId(), start, end, text });
  }

  return cues.sort((a, b) => a.start - b.start);
}

export function isSubtitleFile(filename: string): boolean {
  return /\.(srt|vtt)$/i.test(filename);
}
