import { useEffect, useRef, useState } from "react";
import { Captions, Music, Scissors, Shapes, Type } from "lucide-react";
import AudioWaveform from "./AudioWaveform";
import type { WaveformPeaks } from "../../../../lib/audio/engine-core";
import { isAudibleKind } from "../../../../lib/audio/model";
import { isTrimmableContent } from "../../../../lib/timeline/clip";
import type { TimelineModel } from "../../../../lib/timeline/model";
import { clipDurationFrames, clipTimelineEnd, type Clip } from "../../../../lib/timeline/clip";
import { collectSnapPoints, snapToNearest } from "../../../../lib/timeline/snapping";
import { formatTimecode } from "../../../../lib/timeline/time-model";
import { transitionWindow } from "../../../../lib/transitions/model";
import { getTransitionDefinition } from "../../../../lib/transitions/registry";

/**
 * TIMELINE VIEW for the composition engine (TEXT_ENGINE_ARCHITECTURE.md §7).
 * A thin view over existing engine operations — no timeline logic lives
 * here: moving calls moveClip, edge-dragging calls trimClip (which already
 * clamps and rejects overlaps), snapping uses timeline/snapping.ts. A drag
 * renders live locally and commits ONE engine edit (one undo step) on release.
 *
 * Rows follow the layer stack: top row = front-most track (same order as the
 * Layers list and the canvas z-order).
 */
export interface TimelinePanelProps {
  timeline: TimelineModel;
  frame: number;
  selectedClipIds: readonly string[];
  onSeek: (frame: number) => void;
  onSelectionChange: (ids: string[]) => void;
  onMoveClip: (clipId: string, newStart: number) => void;
  onTrimClip: (clipId: string, edge: "start" | "end", newFrame: number) => void;
  onDelete: (ids: string[]) => void;
  /** Drag a keyframe diamond: move every property's keyframe at that frame. Absolute frames. */
  onMoveKeyframes?: (clipId: string, fromFrame: number, toFrame: number) => void;
  /** Transitions (Phase 10): bars over their windows (click = select, drag an edge = resize), ＋ at bare cuts between adjacent clips. */
  selectedTransitionId?: string | null;
  onSelectTransition?: (transitionId: string | null) => void;
  onAddTransition?: (fromClipId: string | null, toClipId: string | null) => void;
  onResizeTransition?: (transitionId: string, duration: number) => void;
  onDeleteTransition?: (transitionId: string) => void;
  /** Split the selected clip at the playhead (makes two adjacent clips — the place transitions go between). */
  onSplit?: (clipId: string, atFrame: number) => void;
  /** Audio (Phase 11): per-source decode state + waveform peaks, and track mute/solo. */
  audio?: {
    state: (sourceId: string) => string;
    peaks: (sourceId: string) => WaveformPeaks | undefined;
  };
  onToggleTrackMute?: (trackId: string) => void;
  onToggleTrackSolo?: (trackId: string) => void;
}

type Drag =
  | { type: "move"; clipId: string; startX: number; origStart: number; moved: boolean }
  | { type: "trim"; clipId: string; edge: "start" | "end"; startX: number; orig: number; moved: boolean }
  | { type: "seek" };

const HEADER_W = 164;
const ROW_H = 28;
/** Audio rows are taller so the waveform is readable. */
const AUDIO_ROW_H = 44;
const EDGE_PX = 6;
const SNAP_PX = 8;

export default function TimelinePanel({
  timeline,
  frame,
  selectedClipIds,
  onSeek,
  onSelectionChange,
  onMoveClip,
  onTrimClip,
  onDelete,
  onMoveKeyframes,
  selectedTransitionId,
  onSelectTransition,
  onAddTransition,
  onResizeTransition,
  onDeleteTransition,
  onSplit,
  audio,
  onToggleTrackMute,
  onToggleTrackSolo,
}: TimelinePanelProps) {
  const transDrag = useRef<{ id: string; startX: number; orig: number; sign: number; moved: boolean } | null>(null);
  const [transLive, setTransLive] = useState<{ id: string; duration: number } | null>(null);
  const keyDrag = useRef<{ clipId: string; from: number; startX: number; moved: boolean } | null>(null);
  const [keyLive, setKeyLive] = useState<{ clipId: string; from: number; to: number } | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [live, setLive] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const fps = timeline.frameRate;
  const contentEnd = Math.max(fps * 5, ...Object.values(timeline.clips).map(clipTimelineEnd));
  const totalFrames = Math.ceil((contentEnd + fps) / fps) * fps;

  const laneWidth = () => laneRef.current?.clientWidth ?? 1;
  const pxPerFrame = () => laneWidth() / totalFrames;
  const frameAt = (clientX: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - r.left) / pxPerFrame()));
  };
  const snap = (f: number, excludeId: string) => snapToNearest(f, collectSnapPoints(timeline, { excludeClipIds: [excludeId], extra: [frame] }), SNAP_PX / pxPerFrame());

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const additive = e.shiftKey;
    if (additive) onSelectionChange(selectedClipIds.includes(clip.id) ? selectedClipIds.filter((id) => id !== clip.id) : [...selectedClipIds, clip.id]);
    else if (!selectedClipIds.includes(clip.id)) onSelectionChange([clip.id]);
    if (additive || timeline.tracks[clip.trackId]?.locked) return;
    const nearStart = e.clientX - r.left <= EDGE_PX;
    const nearEnd = r.right - e.clientX <= EDGE_PX;
    dragRef.current = nearStart || nearEnd
      ? { type: "trim", clipId: clip.id, edge: nearStart ? "start" : "end", startX: e.clientX, orig: nearStart ? clip.timelineStart : clipTimelineEnd(clip), moved: false }
      : { type: "move", clipId: clip.id, startX: e.clientX, origStart: clip.timelineStart, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.type === "seek") return onSeek(Math.min(totalFrames - 1, frameAt(e.clientX)));
    const df = Math.round((e.clientX - d.startX) / pxPerFrame());
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    d.moved = true;
    const clip = timeline.clips[d.clipId];
    if (d.type === "move") {
      const dur = clipDurationFrames(clip);
      let start = Math.max(0, d.origStart + df);
      // Snap whichever edge is closer to a snap point.
      const sStart = snap(start, clip.id);
      const sEnd = snap(start + dur, clip.id) - dur;
      start = Math.abs(sStart - start) <= Math.abs(sEnd - start) ? sStart : Math.max(0, sEnd);
      setLive({ clipId: clip.id, start, end: start + dur });
    } else {
      const f = snap(Math.max(0, d.orig + df), clip.id);
      setLive(d.edge === "start" ? { clipId: clip.id, start: Math.min(f, clipTimelineEnd(clip) - 1), end: clipTimelineEnd(clip) } : { clipId: clip.id, start: clip.timelineStart, end: Math.max(f, clip.timelineStart + 1) });
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.type !== "seek" && d.moved && live) {
      if (d.type === "move") onMoveClip(d.clipId, live.start);
      else onTrimClip(d.clipId, d.edge, d.edge === "start" ? live.start : live.end);
    }
    setLive(null);
  };

  /** Transition bars + ＋ buttons for one track row (positions in % of the lane, like the clips). */
  const renderTransitions = (trackId: string) => {
    const track = timeline.tracks[trackId];
    const list = Object.values(timeline.transitions ?? {}).filter((t) => t.trackId === trackId);
    const pct = (f: number) => `${(f / totalFrames) * 100}%`;
    const out: React.ReactNode[] = [];
    for (const t of list) {
      const shown = transLive?.id === t.id ? { ...t, duration: transLive.duration } : t;
      const w = transitionWindow(timeline, shown);
      if (!w) continue;
      const selected = t.id === selectedTransitionId;
      const label = getTransitionDefinition(t.type)?.label ?? t.type;
      const edge = (side: "start" | "end") => (
        <span
          role="separator"
          aria-label={`Resize ${label} transition (${side})`}
          className="absolute inset-y-0 z-10 w-1.5 cursor-ew-resize bg-white/70"
          style={side === "start" ? { left: 0 } : { right: 0 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelectTransition?.(t.id);
            if (track.locked) return;
            // Centered windows grow on both sides, so an edge moves half as fast as the duration changes.
            const k = t.fromClipId !== null && t.toClipId !== null && t.alignment === "center" ? 2 : 1;
            transDrag.current = { id: t.id, startX: e.clientX, orig: t.duration, sign: (side === "end" ? 1 : -1) * k, moved: false };
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
              /* best-effort */
            }
          }}
          onPointerMove={(e) => {
            const d = transDrag.current;
            if (!d || d.id !== t.id) return;
            if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
            d.moved = true;
            setTransLive({ id: t.id, duration: Math.max(1, d.orig + d.sign * Math.round((e.clientX - d.startX) / pxPerFrame())) });
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            const d = transDrag.current;
            transDrag.current = null;
            if (d?.moved && transLive && transLive.id === t.id) {
              const fitted = transitionWindow(timeline, { ...t, duration: transLive.duration });
              if (fitted && fitted.duration !== t.duration) onResizeTransition?.(t.id, fitted.duration);
            }
            setTransLive(null);
          }}
        />
      );
      out.push(
        <div
          key={t.id}
          role="button"
          aria-label={`${label} transition`}
          aria-pressed={selected}
          data-transition-id={t.id}
          title={`${label} · ${w.duration} frames (${formatTimecode(w.start, fps)} → ${formatTimecode(w.end, fps)})${t.enabled ? "" : " · disabled"}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelectTransition?.(t.id);
          }}
          className={`absolute top-0.5 bottom-0.5 z-30 flex items-center justify-center overflow-hidden rounded border text-[10px] font-semibold text-white shadow ${selected ? "border-primary-300 ring-2 ring-primary-300" : "border-white/80"} ${t.enabled ? "" : "opacity-50"}`}
          style={{
            left: pct(w.start),
            width: pct(w.end - w.start),
            minWidth: 8,
            // Solid backing so the clip label underneath doesn't show through the stripes.
            backgroundColor: "rgba(17,24,39,.85)",
            backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.22) 0 4px, transparent 4px 8px)",
          }}
        >
          {edge("start")}
          <span className="pointer-events-none truncate px-1.5">{label}</span>
          {edge("end")}
        </div>,
      );
    }
    // ＋ at every bare cut between adjacent clips — not on caption tracks (dozens of back-to-back cues would bury the
    // row; caption transitions are added from the Transitions panel), and not where the clips are too narrow to click.
    const clips = track.kind === "caption" ? [] : track.clipIds.map((id) => timeline.clips[id]);
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1];
      const b = clips[i];
      if (clipTimelineEnd(a) !== b.timelineStart || list.some((t) => t.fromClipId === a.id || t.toClipId === b.id)) continue;
      if (Math.min(clipDurationFrames(a), clipDurationFrames(b)) * (laneW / totalFrames) < 16) continue;
      out.push(
        <button
          key={`add-${a.id}-${b.id}`}
          type="button"
          disabled={track.locked}
          aria-label={`Add transition at ${formatTimecode(b.timelineStart, fps)}`}
          title="Add a transition here"
          data-add-transition={`${a.id}|${b.id}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onAddTransition?.(a.id, b.id)}
          className="absolute top-1/2 z-30 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white bg-(--color-text) text-[11px] leading-none text-(--color-bg) shadow hover:scale-110 disabled:opacity-30"
          style={{ left: pct(b.timelineStart) }}
        >
          +
        </button>,
      );
    }
    return out;
  };

  const selectedOne = selectedClipIds.length === 1 ? timeline.clips[selectedClipIds[0]] : undefined;
  const splittable = selectedOne && frame > selectedOne.timelineStart && frame < clipTimelineEnd(selectedOne) && !timeline.tracks[selectedOne.trackId]?.locked ? selectedOne : undefined;

  // Ruler step adapts to the timeline length so labels never pile up (a ~50 px minimum gap between labels).
  const [laneW, setLaneW] = useState(800);
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const totalSec = totalFrames / fps;
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((st) => (laneW / totalSec) * st >= 50) ?? 600;
  const seconds = Array.from({ length: Math.floor(totalSec / step) + 1 }, (_, i) => i * step);
  const fmtRuler = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : `${sec}s`);

  return (
    <section
      className="select-none rounded-xl border border-(--color-border) bg-(--color-surface) text-caption"
      aria-label="Timeline"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey && splittable && onSplit) {
          e.preventDefault();
          onSplit(splittable.id, frame);
        } else if ((e.key === "Delete" || e.key === "Backspace") && selectedTransitionId && onDeleteTransition) {
          e.preventDefault();
          onDeleteTransition(selectedTransitionId);
        } else if ((e.key === "Delete" || e.key === "Backspace") && selectedClipIds.length > 0) {
          e.preventDefault();
          onDelete([...selectedClipIds]);
        }
      }}
      data-testid="timeline-panel"
    >
      <div className="flex border-b border-(--color-border)">
        <div style={{ width: HEADER_W }} className="flex shrink-0 items-center gap-1 px-2 py-1 font-medium">
          Timeline <span className="font-normal text-(--color-text-faint)">{formatTimecode(frame, fps)}</span>
          {onSplit && (
            <button
              type="button"
              disabled={!splittable}
              onClick={() => splittable && onSplit(splittable.id, frame)}
              className="ml-auto rounded p-0.5 hover:bg-(--color-bg-subtle) disabled:opacity-30"
              aria-label="Split selected clip at playhead"
              title="Split the selected clip at the playhead (S)"
            >
              <Scissors className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div
          className="relative h-6 flex-1 cursor-pointer"
          onPointerDown={(e) => {
            dragRef.current = { type: "seek" };
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            onSeek(Math.min(totalFrames - 1, frameAt(e.clientX)));
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          ref={laneRef}
        >
          {seconds.map((s) => (
            <span key={s} className="absolute top-0 h-full border-l border-(--color-border) pl-1 text-(--color-text-faint)" style={{ left: `${((s * fps) / totalFrames) * 100}%` }}>
              {fmtRuler(s)}
            </span>
          ))}
          <span className="pointer-events-none absolute top-0 z-10 h-full w-0.5 bg-primary-500" style={{ left: `${(frame / totalFrames) * 100}%` }} />
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {timeline.trackIds.map((trackId) => {
          const track = timeline.tracks[trackId];
          return (
            <div key={trackId} className="flex border-b border-(--color-border) last:border-b-0" style={{ height: track.kind === "audio" ? AUDIO_ROW_H : ROW_H }}>
              <div style={{ width: HEADER_W }} className={`flex shrink-0 items-center gap-1 truncate px-2 ${track.visible ? "" : "text-(--color-text-faint) line-through"}`} title={track.name}>
                {track.kind === "text" && <Type className="h-3 w-3 shrink-0" />}
                {track.kind === "graphic" && <Shapes className="h-3 w-3 shrink-0" />}
                {track.kind === "audio" && <Music className="h-3 w-3 shrink-0" />}
                {track.kind === "caption" && <Captions className="h-3 w-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{track.name}</span>
                {isAudibleKind(track.kind) && onToggleTrackMute && (
                  <>
                    <button
                      type="button"
                      onClick={() => onToggleTrackMute(trackId)}
                      className={`shrink-0 rounded px-1 text-[10px] font-bold leading-4 ${track.muted ? "bg-danger-500 text-white" : "text-(--color-text-faint) hover:bg-(--color-bg-subtle)"}`}
                      aria-label={`${track.muted ? "Unmute" : "Mute"} track ${track.name}`}
                      aria-pressed={track.muted}
                      title="Mute track"
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleTrackSolo?.(trackId)}
                      className={`shrink-0 rounded px-1 text-[10px] font-bold leading-4 ${track.solo ? "bg-amber-400 text-black" : "text-(--color-text-faint) hover:bg-(--color-bg-subtle)"}`}
                      aria-label={`${track.solo ? "Unsolo" : "Solo"} track ${track.name}`}
                      aria-pressed={track.solo}
                      title="Solo track (only soloed tracks are heard)"
                    >
                      S
                    </button>
                  </>
                )}
              </div>
              <div
                className="relative flex-1"
                onPointerDown={(e) => {
                  onSelectionChange([]);
                  dragRef.current = { type: "seek" };
                  onSeek(Math.min(totalFrames - 1, frameAt(e.clientX)));
                }}
              >
                <span className="pointer-events-none absolute top-0 z-10 h-full w-px bg-primary-500/60" style={{ left: `${(frame / totalFrames) * 100}%` }} />
                {track.clipIds.map((id) => {
                  const clip = timeline.clips[id];
                  const start = live?.clipId === id ? live.start : clip.timelineStart;
                  const end = live?.clipId === id ? live.end : clipTimelineEnd(clip);
                  const selected = selectedClipIds.includes(id);
                  const c = clip.content;
                  const label = c.kind === "text" || c.kind === "caption" ? (c.speaker ? `${c.speaker}: ` : "") + (c.text || "(empty)") : c.kind === "graphic" && c.shape ? `${track.name} · ${c.shape.type}` : c.kind === "graphic" && c.svg ? `${track.name} · SVG` : c.source?.label ?? track.name;
                  const audioState = c.kind === "audio" && isTrimmableContent(c) && audio ? audio.state(c.source.sourceId) : null;
                  const audioProblem = audioState === "missing" || audioState === "error";
                  const peaks = c.kind === "audio" && isTrimmableContent(c) ? audio?.peaks(c.source.sourceId) : undefined;
                  return (
                    <div
                      key={id}
                      role="button"
                      aria-label={`${clip.content.kind} clip ${label}`}
                      aria-pressed={selected}
                      data-clip-id={id}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      data-audio-state={audioState ?? undefined}
                      className={`absolute top-1 bottom-1 flex cursor-grab items-center overflow-hidden rounded px-1.5 text-white ${clip.content.kind === "text" ? "bg-amber-600" : clip.content.kind === "caption" ? "bg-fuchsia-700" : clip.content.kind === "graphic" ? "bg-emerald-600" : clip.content.kind === "image" ? "bg-sky-600" : clip.content.kind === "audio" ? (audioProblem ? "bg-danger-600" : "bg-teal-700") : "bg-indigo-600"} ${selected ? "ring-2 ring-primary-300 ring-offset-1 ring-offset-(--color-surface)" : ""} ${track.locked ? "cursor-not-allowed opacity-60" : ""}`}
                      style={{ left: `${(start / totalFrames) * 100}%`, width: `${Math.max(0.3, ((end - start) / totalFrames) * 100)}%` }}
                      title={`${label} · ${formatTimecode(start, fps)} → ${formatTimecode(end, fps)}`}
                    >
                      <span className="pointer-events-none absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/30" />
                      {peaks && <AudioWaveform clip={clip} peaks={peaks} fps={fps} comp={timeline.composition} />}
                      <span className={`relative truncate drop-shadow ${peaks ? "self-start rounded bg-black/45 px-1 text-[10px] leading-4" : ""}`}>
                        {label}
                        {audioState === "loading" && " · decoding…"}
                        {audioProblem && (audioState === "missing" ? " · missing audio" : " · can't play")}
                      </span>
                      {selected && selectedClipIds.length === 1 && clip.animation && (
                        // Keyframe diamonds (union of all animated properties), positioned within the bar.
                        [...new Set(Object.values(clip.animation.tracks).flatMap((t) => t.keyframes.map((k) => k.frame)))]
                          .filter((f) => f >= 0 && f < clipDurationFrames(clip)) // keys outside the clip still shape the curve, but aren't shown
                          .map((f) => {
                            const abs = clip.timelineStart + f;
                            const shown = keyLive && keyLive.clipId === id && keyLive.from === abs ? keyLive.to : abs;
                            return (
                              <span
                                key={f}
                                role="button"
                                aria-label={`Keyframe at ${formatTimecode(abs, fps)}`}
                                title={`Keyframe ${formatTimecode(abs, fps)} — click to jump, drag to move`}
                                data-keyframe-frame={abs}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  keyDrag.current = { clipId: id, from: abs, startX: e.clientX, moved: false };
                                  try {
                                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                                  } catch {
                                    /* best-effort */
                                  }
                                }}
                                onPointerMove={(e) => {
                                  const k = keyDrag.current;
                                  if (!k) return;
                                  if (!k.moved && Math.abs(e.clientX - k.startX) < 3) return;
                                  k.moved = true;
                                  const to = Math.max(clip.timelineStart, Math.min(clipTimelineEnd(clip) - 1, k.from + Math.round((e.clientX - k.startX) / pxPerFrame())));
                                  setKeyLive({ clipId: id, from: k.from, to });
                                }}
                                onPointerUp={(e) => {
                                  e.stopPropagation();
                                  const k = keyDrag.current;
                                  keyDrag.current = null;
                                  if (k?.moved && keyLive && keyLive.to !== k.from) onMoveKeyframes?.(id, k.from, keyLive.to);
                                  else if (k) onSeek(k.from);
                                  setKeyLive(null);
                                }}
                                className="absolute top-1/2 z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize border border-white bg-amber-400 shadow"
                                style={{ left: `${((shown - start) / Math.max(1, end - start)) * 100}%` }}
                              />
                            );
                          })
                      )}
                      <span className="pointer-events-none absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/30" />
                    </div>
                  );
                })}
                {track.kind !== "audio" && renderTransitions(trackId)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
