import { useRef, useState } from "react";
import { Type } from "lucide-react";
import type { TimelineModel } from "../../../../lib/timeline/model";
import { clipDurationFrames, clipTimelineEnd, type Clip } from "../../../../lib/timeline/clip";
import { collectSnapPoints, snapToNearest } from "../../../../lib/timeline/snapping";
import { formatTimecode } from "../../../../lib/timeline/time-model";

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
}

type Drag =
  | { type: "move"; clipId: string; startX: number; origStart: number; moved: boolean }
  | { type: "trim"; clipId: string; edge: "start" | "end"; startX: number; orig: number; moved: boolean }
  | { type: "seek" };

const HEADER_W = 132;
const ROW_H = 28;
const EDGE_PX = 6;
const SNAP_PX = 8;

export default function TimelinePanel({ timeline, frame, selectedClipIds, onSeek, onSelectionChange, onMoveClip, onTrimClip, onDelete }: TimelinePanelProps) {
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

  const seconds = Array.from({ length: Math.floor(totalFrames / fps) + 1 }, (_, i) => i);

  return (
    <section
      className="select-none rounded-xl border border-(--color-border) bg-(--color-surface) text-caption"
      aria-label="Timeline"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && selectedClipIds.length > 0) {
          e.preventDefault();
          onDelete([...selectedClipIds]);
        }
      }}
      data-testid="timeline-panel"
    >
      <div className="flex border-b border-(--color-border)">
        <div style={{ width: HEADER_W }} className="shrink-0 px-2 py-1 font-medium">
          Timeline <span className="font-normal text-(--color-text-faint)">{formatTimecode(frame, fps)}</span>
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
              {s}s
            </span>
          ))}
          <span className="pointer-events-none absolute top-0 z-10 h-full w-0.5 bg-primary-500" style={{ left: `${(frame / totalFrames) * 100}%` }} />
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {timeline.trackIds.map((trackId) => {
          const track = timeline.tracks[trackId];
          return (
            <div key={trackId} className="flex border-b border-(--color-border) last:border-b-0" style={{ height: ROW_H }}>
              <div style={{ width: HEADER_W }} className={`flex shrink-0 items-center gap-1 truncate px-2 ${track.visible ? "" : "text-(--color-text-faint) line-through"}`} title={track.name}>
                {track.kind === "text" && <Type className="h-3 w-3 shrink-0" />}
                <span className="truncate">{track.name}</span>
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
                  const label = clip.content.kind === "text" ? clip.content.text || "(empty)" : clip.content.source?.label ?? track.name;
                  return (
                    <div
                      key={id}
                      role="button"
                      aria-label={`${clip.content.kind} clip ${label}`}
                      aria-pressed={selected}
                      data-clip-id={id}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      className={`absolute top-1 bottom-1 flex cursor-grab items-center overflow-hidden rounded px-1.5 text-white ${clip.content.kind === "text" ? "bg-amber-600" : clip.content.kind === "graphic" ? "bg-emerald-600" : clip.content.kind === "image" ? "bg-sky-600" : "bg-indigo-600"} ${selected ? "ring-2 ring-primary-300 ring-offset-1 ring-offset-(--color-surface)" : ""} ${track.locked ? "cursor-not-allowed opacity-60" : ""}`}
                      style={{ left: `${(start / totalFrames) * 100}%`, width: `${Math.max(0.3, ((end - start) / totalFrames) * 100)}%` }}
                      title={`${label} · ${formatTimecode(start, fps)} → ${formatTimecode(end, fps)}`}
                    >
                      <span className="pointer-events-none absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/30" />
                      <span className="truncate">{label}</span>
                      <span className="pointer-events-none absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/30" />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
