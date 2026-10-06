import type { CaptionWordTiming } from "./caption-model";

/**
 * SUBTITLE FILES (CAPTIONS_ARCHITECTURE.md §5): SRT and WebVTT, both ways.
 *
 * A neutral, absolute-time cue list is the interchange shape; caption clips
 * are converted to/from it by the timeline ops. Parsing is lenient about what
 * real-world files contain (BOMs, CRLF, missing indices, comma or dot
 * decimals, hour-less VTT stamps, HTML-ish tags, ASS {\an8} overrides, VTT
 * NOTE/STYLE/REGION blocks, cue settings) and reports what it dropped rather
 * than failing the whole file. It preserves what the caption model can carry:
 * VTT voice spans (<v Speaker>) -> speaker, and VTT inline timestamps
 * (<00:00:01.500>) -> per-word timing.
 */

export interface SubtitleCue {
  /** Absolute seconds. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** Absolute seconds (converted to clip-relative by the importer). */
  words?: CaptionWordTiming[];
}

export interface ParseResult {
  format: "srt" | "vtt";
  cues: SubtitleCue[];
  /** Human-readable notes about blocks that were skipped or fixed. */
  warnings: string[];
}

const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const TIMING_LINE = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

export function parseStamp(s: string): number | null {
  const m = STAMP.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  if (min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/** "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT). Rounded to the millisecond. */
export function formatStamp(sec: number, sep: "," | "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

const decodeEntities = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** Removes markup a caption can't carry: HTML-ish tags (<i>, <b>, <font>, <c.cls>, <ruby>...) and ASS overrides ({\an8}). */
function stripMarkup(s: string): string {
  // Also VTT inline timestamps (<00:00:05.500>), which start with a digit.
  return decodeEntities(s.replace(/\{\\[^}]*\}/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "").replace(/<(?:\d+:)?\d{1,2}:\d{2}\.\d{3}>/g, ""))
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/** VTT payload -> text, speaker (from <v Name>) and word timings (from <hh:mm:ss.mmm> inline stamps). */
function parseVttPayload(raw: string, cueStart: number, cueEnd: number): { text: string; speaker?: string; words?: CaptionWordTiming[] } {
  let speaker: string | undefined;
  const v = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw);
  if (v) speaker = v[1].trim();
  let words: CaptionWordTiming[] | undefined;
  if (/<(?:\d+:)?\d{1,2}:\d{2}\.\d{3}>/.test(raw)) {
    // Karaoke-style: each word starts at the most recent inline timestamp (the cue start before the first one).
    const parts = raw.replace(/<\/?(?:v|c|b|i|u|lang|ruby|rt)(?:[.\s][^>]*)?>/g, "").split(/(<(?:\d+:)?\d{1,2}:\d{2}\.\d{3}>)/);
    let t = cueStart;
    const timed: { text: string; start: number }[] = [];
    for (const part of parts) {
      const stamp = /^<(.*)>$/.exec(part);
      if (stamp) {
        t = parseStamp(stamp[1]) ?? t;
        continue;
      }
      for (const w of decodeEntities(part).split(/\s+/).filter(Boolean)) timed.push({ text: w, start: t });
    }
    // Words sharing a stamp split its interval; each ends where the next begins.
    words = timed.map((w, i) => ({ text: w.text, start: w.start, end: i + 1 < timed.length ? Math.max(w.start, timed[i + 1].start) : cueEnd }));
    for (let i = 0; i < words.length; ) {
      let j = i;
      while (j + 1 < words.length && words[j + 1].start === words[i].start) j++;
      if (j > i) {
        const end = words[j].end;
        const step = (end - words[i].start) / (j - i + 1);
        for (let k = i; k <= j; k++) words[k] = { ...words[k], start: words[i].start + (k - i) * step, end: words[i].start + (k - i + 1) * step };
      }
      i = j + 1;
    }
  }
  return { text: stripMarkup(raw), ...(speaker ? { speaker } : {}), ...(words?.length ? { words } : {}) };
}

/** Detects SRT vs VTT and parses. */
export function parseSubtitles(content: string, fileName = ""): ParseResult {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const isVtt = /^WEBVTT\b/.test(text) || /\.vtt$/i.test(fileName);
  const format: ParseResult["format"] = isVtt ? "vtt" : "srt";
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];
  const blocks = text.split(/\n[ \t]*\n/);
  blocks.forEach((block, bi) => {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return;
    if (isVtt && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) return;
    const ti = lines.findIndex((l) => TIMING_LINE.test(l));
    if (ti === -1) {
      if (!/^\d+$/.test(lines[0].trim()) || lines.length > 1) warnings.push(`Block ${bi + 1}: no timing line — skipped.`);
      return;
    }
    const m = TIMING_LINE.exec(lines[ti])!;
    const start = parseStamp(m[1]);
    const end = parseStamp(m[2]);
    if (start === null || end === null) {
      warnings.push(`Block ${bi + 1}: invalid timestamp "${lines[ti].trim()}" — skipped.`);
      return;
    }
    if (end <= start) {
      warnings.push(`Block ${bi + 1}: ends before it starts (${m[1]} → ${m[2]}) — skipped.`);
      return;
    }
    const payload = lines.slice(ti + 1).join("\n");
    let cue: SubtitleCue;
    if (isVtt) cue = { start, end, ...parseVttPayload(payload, start, end) };
    else {
      // SRT has no speaker syntax; the SDH convention "NAME: text" (upper-case name) is recognized — mixed-case
      // "Note: ..." stays text. Speaker names therefore round-trip through SRT upper-cased (VTT keeps them exactly).
      let body = stripMarkup(payload);
      let speaker: string | undefined;
      const sp = /^-?\s*([A-Z][A-Z0-9 .'-]{0,30}):\s+(.+)$/s.exec(body);
      if (sp && !/^\d/.test(sp[1])) {
        speaker = sp[1].trim();
        body = sp[2].trim();
      }
      cue = { start, end, text: body, ...(speaker ? { speaker } : {}) };
    }
    if (!cue.text) {
      warnings.push(`Block ${bi + 1}: empty text — skipped.`);
      return;
    }
    cues.push(cue);
  });
  cues.sort((a, b) => a.start - b.start);
  return { format, cues, warnings };
}

/** SRT: numbered blocks, comma milliseconds; speaker as an SDH-style "NAME: " prefix. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatStamp(c.start, ",")} --> ${formatStamp(c.end, ",")}\n${c.speaker ? `${c.speaker.toUpperCase()}: ` : ""}${c.text}`)
      .join("\n\n") + "\n"
  );
}

const escapeVtt = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * WebVTT. Speakers as voice spans (<v Name>). With `wordTimings`, words carry inline timestamps (the karaoke form
 * players use for word highlighting) — the format this module also reads back.
 */
export function toVtt(cues: readonly SubtitleCue[], opts: { language?: string; wordTimings?: boolean } = {}): string {
  const header = `WEBVTT${opts.language ? `\nLanguage: ${opts.language}` : ""}`;
  const body = cues.map((c, i) => {
    let text: string;
    if (opts.wordTimings && c.words?.length) {
      text = c.words.map((w, k) => (k === 0 ? escapeVtt(w.text) : `<${formatStamp(w.start, ".")}>${escapeVtt(w.text)}`)).join(" ");
    } else text = escapeVtt(c.text);
    if (c.speaker) text = `<v ${c.speaker}>${text}`;
    return `${i + 1}\n${formatStamp(c.start, ".")} --> ${formatStamp(c.end, ".")}\n${text}`;
  });
  return `${header}\n\n${body.join("\n\n")}\n`;
}
