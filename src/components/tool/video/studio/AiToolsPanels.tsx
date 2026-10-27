import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Download, Film, Loader2, Music2, Play, Scissors, Sparkles, Trash2, Wand2, Waves } from "lucide-react";
import type { TimelineWord } from "../../../../lib/transcript/transcript";
import { isFillerWord } from "../../../../lib/transcript/transcript";
import type { ClipCandidate } from "../../../../lib/transcript/clip-finder";
import type { BeatAnalysis } from "../../../../lib/audio/beats";
import { GIF_LIMITS } from "../../../../lib/export/gif";

/**
 * PHASE 3 PANELS — transcript editing, the clip maker, audio tools (Clean Audio, stems, ducking, beat sync),
 * background swap and GIF export. Presentation only: every action is a callback into the editor.
 */

const label = "mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase";
const btn = "flex items-center justify-center gap-1.5 rounded-lg border border-(--color-border) px-2.5 py-1.5 text-caption font-medium hover:border-primary-400 hover:bg-(--color-bg-subtle) disabled:pointer-events-none disabled:opacity-45";
const primary = "flex items-center justify-center gap-1.5 rounded-lg bg-primary-500 px-3 py-2 text-caption font-semibold text-white hover:bg-primary-600 disabled:pointer-events-none disabled:opacity-45";
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export interface Busy {
  label: string;
  fraction: number | null;
}

export function BusyBar({ busy, onCancel }: { busy: Busy; onCancel?: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-primary-500/10 px-3 py-2.5 text-caption" role="status">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-500" />
        <span className="flex-1">{busy.label}</span>
        {busy.fraction !== null && <span className="tabular-nums text-(--color-text-muted)">{Math.round(busy.fraction * 100)}%</span>}
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-(--color-text-muted) underline hover:text-(--color-text)">
            Cancel
          </button>
        )}
      </div>
      {busy.fraction !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-(--color-border)">
          <div className="h-full bg-primary-500 transition-[width]" style={{ width: `${Math.round(busy.fraction * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript editing
// ---------------------------------------------------------------------------

export function TranscriptPanel({
  words,
  hasSpeechClips,
  untranscribed,
  busy,
  currentSec,
  pauseCount,
  onTranscribe,
  onSeek,
  onDelete,
  onRemoveFillers,
  onShortenPauses,
}: {
  words: TimelineWord[];
  hasSpeechClips: boolean;
  untranscribed: number;
  busy: Busy | null;
  currentSec: number;
  pauseCount: number;
  onTranscribe: () => void;
  onSeek: (sec: number) => void;
  onDelete: (keys: Set<string>) => void;
  onRemoveFillers: () => void;
  onShortenPauses: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const fillers = useMemo(() => words.filter((w) => isFillerWord(w.text)).length, [words]);
  // Words that vanished (deleted, undone) leave the selection.
  useEffect(() => setSel((s) => new Set([...s].filter((k) => words.some((w) => w.key === k)))), [words]);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const range = (a: number, b: number) => new Set(words.slice(Math.min(a, b), Math.max(a, b) + 1).map((w) => w.key));
  const activeIdx = words.findIndex((w, i) => currentSec >= w.start && currentSec < (words[i + 1]?.start ?? w.end + 0.3));

  if (!hasSpeechClips) return <p className="mx-2 rounded-xl bg-(--color-bg-subtle) px-3 py-4 text-caption text-(--color-text-muted)">Add a video or voice recording with speech — then edit it here by deleting words.</p>;

  return (
    <div className="flex flex-col gap-3 px-2" data-testid="transcript-panel">
      {busy ? (
        <BusyBar busy={busy} />
      ) : untranscribed > 0 ? (
        <button type="button" onClick={onTranscribe} className={primary} data-testid="transcribe-button">
          <Wand2 className="h-4 w-4" /> {words.length ? `Transcribe ${untranscribed} new clip${untranscribed > 1 ? "s" : ""}` : "Transcribe speech"}
        </button>
      ) : null}
      {words.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" className={btn} disabled={fillers === 0} onClick={onRemoveFillers} title="Cut every um, uh, erm…">
              Remove fillers ({fillers})
            </button>
            <button type="button" className={btn} disabled={pauseCount === 0} onClick={onShortenPauses} title="Shorten every pause longer than 0.8 s">
              Shorten pauses ({pauseCount})
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-(--color-text-faint)">
            <span>{sel.size ? `${sel.size} word${sel.size > 1 ? "s" : ""} selected` : "Click or drag across words, then Delete"}</span>
            {sel.size > 0 && (
              <button type="button" onClick={() => onDelete(sel)} className="flex items-center gap-1 rounded-md bg-danger-500/15 px-2 py-0.5 font-medium text-danger-600 dark:text-danger-500" data-testid="delete-words">
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            )}
          </div>
          <div
            ref={box}
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === "Delete" || e.key === "Backspace") && sel.size) {
                e.preventDefault();
                e.stopPropagation();
                onDelete(sel);
              } else if (e.key === "Escape") setSel(new Set());
            }}
            className="rounded-xl bg-(--color-bg-subtle) p-3 text-body-sm leading-7 outline-none select-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            data-testid="transcript-words"
          >
            {words.map((w, i) => {
              const gap = i > 0 ? w.start - words[i - 1].end : 0;
              return (
                <span key={w.key}>
                  {gap > 0.8 && (
                    <span className="mx-0.5 rounded bg-(--color-border) px-1 font-mono text-[10px] text-(--color-text-faint)" title={`${gap.toFixed(1)} s pause`}>
                      ⏸ {gap.toFixed(1)}s
                    </span>
                  )}
                  <span
                    onMouseDown={(e) => {
                      box.current?.focus();
                      if (e.shiftKey && anchor.current !== null) setSel(range(anchor.current, i));
                      else {
                        anchor.current = i;
                        setSel(new Set([w.key]));
                        dragging.current = true;
                        onSeek(w.start);
                      }
                    }}
                    onMouseEnter={() => dragging.current && anchor.current !== null && setSel(range(anchor.current, i))}
                    className={`cursor-pointer rounded px-0.5 transition-colors ${sel.has(w.key) ? "bg-primary-500/35 text-(--color-text)" : i === activeIdx ? "bg-accent-500/25" : "hover:bg-(--color-border)"} ${isFillerWord(w.text) ? "text-warning-600 underline decoration-dotted dark:text-warning-500" : ""}`}
                  >
                    {w.text.trim()}
                  </span>{" "}
                </span>
              );
            })}
          </div>
          <p className="px-1 text-[11px] text-(--color-text-faint)">Deleting words cuts them from every track at once, so captions, music and overlays stay in sync. ⌘Z brings them back.</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clip maker
// ---------------------------------------------------------------------------

const LENGTHS = [
  { id: "short", label: "15–30 s", min: 15, max: 30 },
  { id: "mid", label: "30–60 s", min: 30, max: 60 },
  { id: "long", label: "45–90 s", min: 45, max: 90 },
];

export function ClipsPanel({
  hasTranscript,
  candidates,
  busy,
  onFind,
  onPreview,
  onExport,
  onEdit,
}: {
  hasTranscript: boolean;
  candidates: ClipCandidate[] | null;
  busy: Busy | null;
  onFind: (minSec: number, maxSec: number) => void;
  onPreview: (c: ClipCandidate) => void;
  onExport: (c: ClipCandidate) => void;
  onEdit: (c: ClipCandidate) => void;
}) {
  const [len, setLen] = useState(LENGTHS[1]);
  return (
    <div className="flex flex-col gap-3 px-2" data-testid="clips-panel">
      <p className="px-1 text-caption text-(--color-text-muted)">Finds the strongest standalone moments in a long video and turns each into a vertical short with captions.</p>
      <div className="flex gap-1 rounded-lg bg-(--color-bg-subtle) p-1">
        {LENGTHS.map((l) => (
          <button key={l.id} type="button" onClick={() => setLen(l)} aria-pressed={len.id === l.id} className={`flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${len.id === l.id ? "bg-(--color-surface-raised) shadow-sm" : "text-(--color-text-muted)"}`}>
            {l.label}
          </button>
        ))}
      </div>
      {busy ? (
        <BusyBar busy={busy} />
      ) : (
        <button type="button" onClick={() => onFind(len.min, len.max)} className={primary} data-testid="find-clips">
          <Sparkles className="h-4 w-4" /> {hasTranscript ? "Find clips" : "Transcribe & find clips"}
        </button>
      )}
      {candidates && candidates.length === 0 && <p className="rounded-xl bg-(--color-bg-subtle) px-3 py-3 text-caption text-(--color-text-muted)">No standalone moments of that length — try another length, or a longer video.</p>}
      {candidates?.map((c, i) => (
        <div key={`${c.start}-${c.end}`} className="flex flex-col gap-2 rounded-xl border border-(--color-border) p-3" data-testid="clip-candidate">
          <div className="flex items-start gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-500/15 text-[11px] font-bold text-primary-500">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-caption font-semibold leading-snug">“{c.title}”</p>
              <p className="mt-0.5 text-[11px] text-(--color-text-muted) tabular-nums">
                {fmt(c.start)}–{fmt(c.end)} · {Math.round(c.end - c.start)} s · {c.reasons.join(", ")}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-(--color-bg-subtle) px-1.5 text-[10px] font-medium tabular-nums text-(--color-text-muted)" title="Heuristic score, relative to this video">
              {Math.round(c.score * 100)}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button type="button" className={btn} onClick={() => onPreview(c)}>
              <Play className="h-3.5 w-3.5" /> Preview
            </button>
            <button type="button" className={btn} onClick={() => onExport(c)} title="Export a 9:16 short with captions — your project stays as it is">
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            <button type="button" className={btn} onClick={() => onEdit(c)} title="Turn the project into this short to fine-tune it (⌘Z to go back)">
              <Film className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
        </div>
      ))}
      {candidates && candidates.length > 0 && <p className="px-1 text-[11px] text-(--color-text-faint)">Scored by a heuristic (opening hook, pace, pauses, energy) — a starting point, not a verdict.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audio tools
// ---------------------------------------------------------------------------

export function AudioToolsSection({
  clipLabel,
  canProcess,
  isMusic,
  busy,
  beats,
  canDuck,
  onClean,
  onStems,
  onDetectBeats,
  onSplitBeats,
  onSnapBeats,
  onDuck,
  onCancel,
}: {
  clipLabel: string | null;
  canProcess: boolean;
  isMusic: boolean;
  busy: Busy | null;
  beats: BeatAnalysis | null;
  canDuck: boolean;
  onClean: (strength: number) => void;
  onStems: () => void;
  onDetectBeats: () => void;
  onSplitBeats: (every: number) => void;
  onSnapBeats: () => void;
  onDuck: (duckDb: number) => void;
  onCancel: () => void;
}) {
  const [strength, setStrength] = useState(0.5);
  const [duck, setDuck] = useState(-12);
  return (
    <div className="flex flex-col gap-4" data-testid="audio-tools">
      {busy && <BusyBar busy={busy} onCancel={onCancel} />}
      <section>
        <h3 className={label}>Voice</h3>
        <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) p-3">
          <p className="text-caption">
            <b>Clean audio</b> — removes hiss, hum and room noise, then levels the voice.
          </p>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            Strength
            <input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} className="flex-1 accent-primary-500" />
            <span className="w-8 text-right tabular-nums">{Math.round(strength * 100)}</span>
          </label>
          <button type="button" className={primary} disabled={!canProcess || !!busy} onClick={() => onClean(strength)} data-testid="clean-audio">
            <AudioLines className="h-4 w-4" /> Clean {clipLabel ? `“${clipLabel}”` : "selected clip"}
          </button>
        </div>
      </section>
      <section>
        <h3 className={label}>Separate</h3>
        <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) p-3">
          <p className="text-caption">
            <b>Vocals & music</b> — splits the selected clip into two tracks with an AI model (Spleeter). First use downloads ~40 MB.
          </p>
          <button type="button" className={btn} disabled={!canProcess || !!busy} onClick={onStems} data-testid="separate-stems">
            <Waves className="h-3.5 w-3.5" /> Separate vocals & music
          </button>
        </div>
      </section>
      <section>
        <h3 className={label}>Music</h3>
        <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) p-3">
          <p className="text-caption">
            <b>Auto-duck</b> — lowers music whenever someone speaks.
          </p>
          <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
            Duck by
            <input type="range" min={-24} max={-4} step={1} value={duck} onChange={(e) => setDuck(Number(e.target.value))} className="flex-1 accent-primary-500" />
            <span className="w-12 text-right tabular-nums">{duck} dB</span>
          </label>
          <button type="button" className={btn} disabled={!canDuck || !!busy} onClick={() => onDuck(duck)} title={canDuck ? undefined : "Needs a music clip and a speech track"} data-testid="auto-duck">
            <Music2 className="h-3.5 w-3.5" /> Duck music under speech
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-xl border border-(--color-border) p-3">
          <p className="text-caption">
            <b>Beat sync</b> — finds the beat of the selected music and cuts your video to it.
          </p>
          {!beats ? (
            <button type="button" className={btn} disabled={!canProcess || !isMusic || !!busy} onClick={onDetectBeats} title={isMusic ? undefined : "Select a music clip"} data-testid="detect-beats">
              Detect beats
            </button>
          ) : (
            <>
              <p className="text-[11px] text-(--color-text-muted) tabular-nums">
                {beats.bpm} BPM · {beats.beats.length} beats {beats.confidence < 0.3 ? "· weak beat — results may wander" : ""}
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {[1, 2, 4].map((n) => (
                  <button key={n} type="button" className={btn} disabled={!!busy} onClick={() => onSplitBeats(n)} title={`Split the main video every ${n === 1 ? "beat" : `${n} beats`}`}>
                    <Scissors className="h-3 w-3" /> {n === 1 ? "Every beat" : `Every ${n}`}
                  </button>
                ))}
              </div>
              <button type="button" className={btn} disabled={!!busy} onClick={onSnapBeats} title="Trim each clip on the main track so every cut lands on a beat">
                Snap existing cuts to the beat
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Background swap
// ---------------------------------------------------------------------------

const BG_COLORS = ["#000000", "#ffffff", "#0f172a", "#7c3aed", "#0891b2", "#16a34a", "#f97316", "#db2777"];

export function BackgroundSwapSection({ hasCutout, canBlur, brandColors, onColor, onImage, onBlur }: { hasCutout: boolean; canBlur: boolean; brandColors: string[]; onColor: (c: string) => void; onImage: (f: File) => void; onBlur: (radius: number) => void }) {
  const colors = [...new Set([...brandColors, ...BG_COLORS])].slice(0, 12);
  return (
    <section className="mx-3 mb-3 flex flex-col gap-2 rounded-xl border border-(--color-border) p-3" data-testid="background-swap">
      <h3 className="text-caption font-semibold">Replace background</h3>
      {!hasCutout ? (
        <p className="text-[11px] text-(--color-text-muted)">Click “Remove background” below first — then put a color, an image or a blurred copy behind the subject.</p>
      ) : (
        <>
          <div className="grid grid-cols-6 gap-1.5">
            {colors.map((c) => (
              <button key={c} type="button" onClick={() => onColor(c)} className="aspect-square rounded-md border border-(--color-border-strong) transition-transform hover:scale-110" style={{ background: c }} aria-label={`Background color ${c}`} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <label className={`${btn} cursor-pointer`}>
              Image…
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onImage(f);
                }}
              />
            </label>
            <button type="button" className={btn} disabled={!canBlur} onClick={() => onBlur(28)} title="The original footage, blurred, behind the subject">
              Blur original
            </button>
          </div>
          <p className="text-[11px] text-(--color-text-faint)">Want a video background? Add one from Stock or Media, then drag its track below this one.</p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GIF export
// ---------------------------------------------------------------------------

export function GifExportBox({ durationSec, compWidth, busy, result, onExport, onCancel }: { durationSec: number; compWidth: number; busy: Busy | null; result: { url: string; bytes: number } | null; onExport: (o: { fps: number; width: number; startSec: number; endSec: number; loop: boolean }) => void; onCancel: () => void }) {
  const [fps, setFps] = useState(12);
  const [width, setWidth] = useState(Math.min(480, compWidth));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(durationSec, 6));
  const span = Math.max(0, end - start);
  const sel = "rounded-md border border-(--color-border) bg-(--color-surface) px-1.5 py-1 text-caption";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-(--color-border) px-3 py-2.5 text-caption" data-testid="gif-export">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Animated GIF</span>
        <label className="flex items-center gap-1 text-(--color-text-muted)">
          from
          <input type="number" min={0} max={durationSec} step={0.1} value={start} onChange={(e) => setStart(Math.max(0, Number(e.target.value)))} className={`${sel} w-16`} aria-label="GIF start (seconds)" />
          to
          <input type="number" min={0} max={durationSec} step={0.1} value={end} onChange={(e) => setEnd(Math.min(durationSec, Number(e.target.value)))} className={`${sel} w-16`} aria-label="GIF end (seconds)" />s
        </label>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className={sel} aria-label="GIF frame rate">
          {GIF_LIMITS.fps.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <select value={width} onChange={(e) => setWidth(Number(e.target.value))} className={sel} aria-label="GIF width">
          {[240, 320, 480, 640, 800, 960].filter((w) => w <= Math.max(240, compWidth)).map((w) => (
            <option key={w} value={w}>
              {w} px wide
            </option>
          ))}
        </select>
      </div>
      {span > GIF_LIMITS.maxSeconds && <p className="text-warning-600">GIFs are capped at {GIF_LIMITS.maxSeconds} s — only the first {GIF_LIMITS.maxSeconds} s will be exported.</p>}
      {busy ? (
        <BusyBar busy={busy} onCancel={onCancel} />
      ) : (
        <div className="flex items-center gap-3">
          <button type="button" className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50" disabled={span <= 0} onClick={() => onExport({ fps, width, startSec: start, endSec: end, loop: true })} data-testid="export-gif">
            <Download className="h-3.5 w-3.5" /> Export GIF
          </button>
          {result && (
            <span className="flex items-center gap-2" data-testid="gif-result">
              <img src={result.url} alt="GIF preview" className="h-10 rounded border border-(--color-border)" />
              <span className="tabular-nums text-(--color-text-muted)">{(result.bytes / 1024 / 1024).toFixed(1)} MB</span>
              <a href={result.url} download="clipbench.gif" className="underline">
                Download
              </a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
