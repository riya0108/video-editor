import { useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Trash2, Play, Pause, Maximize2, Scissors } from "lucide-react";
import { clamp } from "../../../../lib/time";
import { formatTime } from "../../../../lib/time";

type TrackHandle = "start" | "end" | "playhead" | null;

export interface TimelineSegment {
  id: string;
  start: number;
  end: number;
  label?: string;
}

export interface TimelineLane {
  id: string;
  label: string;
  /** Tailwind background class for this lane's segments. */
  colorClass: string;
  segments: TimelineSegment[];
  /** Present => segments can be dragged (move the whole thing, or its start/end edges). */
  onSegmentChange?: (segmentId: string, patch: { start: number; end: number }) => void;
  /** Present => a selected segment shows a delete affordance (click or Delete/Backspace key). */
  onSegmentDelete?: (segmentId: string) => void;
  minSegmentLength?: number;
}

type SegMode = "move" | "resize-start" | "resize-end";
type SegDrag = {
  laneId: string;
  segId: string;
  mode: SegMode;
  pointerX: number;
  origStart: number;
  origEnd: number;
  barWidth: number;
  moved: boolean;
} | null;

const GUTTER_WIDTH = 84;
const RULER_HEIGHT = 20;
const MAIN_TRACK_HEIGHT = 40;
const SUB_ROW_HEIGHT = 22;
const SUB_ROW_GAP = 3;
const LANE_GAP = 6;

/**
 * Greedily packs a lane's segments into the fewest sub-rows such that no two
 * overlapping-in-time segments share a row — same idea as "busy" calendar
 * views stacking conflicting events side by side instead of on top of each
 * other. Segments are placed into the first sub-row whose last segment ends
 * before the new one starts.
 */
function packIntoSubRows(segments: TimelineSegment[]): { seg: TimelineSegment; row: number }[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const rowEnds: number[] = [];
  const placed: { seg: TimelineSegment; row: number }[] = [];
  for (const seg of sorted) {
    let row = rowEnds.findIndex((end) => seg.start >= end);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(seg.end);
    } else {
      rowEnds[row] = seg.end;
    }
    placed.push({ seg, row });
  }
  return placed;
}

/**
 * The editor's bottom timeline: a zoomable ruler, the main trim track
 * (drag the two handles to change what's kept), a draggable playhead, and a
 * lane per active feature (captions, text, music, overlays). Lanes that pass
 * `onSegmentChange`/`onSegmentDelete` get selectable, draggable, resizable,
 * deletable segments; the others stay read-only indicators.
 *
 * Lane labels live in a fixed gutter column OUTSIDE the horizontally
 * scrollable/zoomable time area, so every row (ruler, trim track, each lane)
 * maps time -> pixel identically — a label's width can't throw off where a
 * segment lands the way it would if it shared a flex row with the track.
 * Within a lane, segments that overlap in time stack into their own
 * sub-row instead of drawing on top of each other.
 */
export default function EditorTimeline({
  duration,
  start,
  end,
  currentTime,
  onChangeStart,
  onChangeEnd,
  onSeek,
  isPlaying,
  onTogglePlay,
  lanes = [],
  onSplit,
}: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  onChangeStart: (t: number) => void;
  onChangeEnd: (t: number) => void;
  onSeek: (t: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  lanes?: TimelineLane[];
  /** Present => shows a "Split" (scissors) button that cuts the clip at the current
   * playhead position — click a point on the timeline to move the playhead, then
   * click Split to divide it there. The resulting piece can then be selected in the
   * Cuts lane and deleted to actually remove it (ripple-closing the gap). */
  onSplit?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<TrackHandle>(null);
  const [segDrag, setSegDrag] = useState<SegDrag>(null);
  const [selected, setSelected] = useState<{ laneId: string; segId: string } | null>(null);
  const [zoom, setZoom] = useState(1);

  const latest = useRef({ duration, start, end, dragging, segDrag, onChangeStart, onChangeEnd, onSeek, lanes });
  latest.current = { duration, start, end, dragging, segDrag, onChangeStart, onChangeEnd, onSeek, lanes };

  const packedLanes = useMemo(
    () =>
      lanes.map((lane) => {
        const packed = packIntoSubRows(lane.segments);
        const rowCount = Math.max(1, packed.reduce((max, p) => Math.max(max, p.row + 1), 0));
        return { lane, packed, rowCount };
      }),
    [lanes],
  );

  useEffect(() => {
    const timeAtClientX = (clientX: number) => {
      const track = trackRef.current;
      const { duration } = latest.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
      return fraction * duration;
    };

    const handleMove = (e: PointerEvent) => {
      const { dragging, segDrag, start, end, duration, onChangeStart, onChangeEnd, onSeek, lanes } = latest.current;

      if (segDrag) {
        const dxTime = ((e.clientX - segDrag.pointerX) / segDrag.barWidth) * duration;
        if (Math.abs(e.clientX - segDrag.pointerX) > 2) segDrag.moved = true;
        const lane = lanes.find((l) => l.id === segDrag.laneId);
        if (!lane?.onSegmentChange) return;
        const minLen = lane.minSegmentLength ?? 0.1;
        const segLen = segDrag.origEnd - segDrag.origStart;
        let nextStart = segDrag.origStart;
        let nextEnd = segDrag.origEnd;
        if (segDrag.mode === "move") {
          nextStart = clamp(segDrag.origStart + dxTime, 0, Math.max(0, duration - segLen));
          nextEnd = nextStart + segLen;
        } else if (segDrag.mode === "resize-start") {
          nextStart = clamp(segDrag.origStart + dxTime, 0, segDrag.origEnd - minLen);
        } else if (segDrag.mode === "resize-end") {
          nextEnd = clamp(segDrag.origEnd + dxTime, segDrag.origStart + minLen, duration);
        }
        lane.onSegmentChange(segDrag.segId, { start: nextStart, end: nextEnd });
        return;
      }

      if (!dragging) return;
      const t = timeAtClientX(e.clientX);
      if (dragging === "start") onChangeStart(clamp(t, 0, end - 0.05));
      else if (dragging === "end") onChangeEnd(clamp(t, start + 0.05, duration));
      else onSeek(clamp(t, 0, duration));
    };

    const handleUp = () => {
      setDragging(null);
      setSegDrag(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  // Delete/Backspace removes the selected segment, unless the user is typing somewhere else.
  useEffect(() => {
    if (!selected) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (active as HTMLElement | null)?.isContentEditable) return;
      const lane = latest.current.lanes.find((l) => l.id === selected.laneId);
      if (!lane?.onSegmentDelete) return;
      e.preventDefault();
      lane.onSegmentDelete(selected.segId);
      setSelected(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected]);

  const timeAtClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    return fraction * duration;
  };

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const tickCount = 8;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (duration * i) / tickCount);

  const startSegDrag = (
    e: React.PointerEvent,
    lane: TimelineLane,
    seg: TimelineSegment,
    mode: SegMode,
    barEl: HTMLElement,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ laneId: lane.id, segId: seg.id });
    // Selecting a segment also moves the playhead to it, so panels that key
    // off `currentTime` (e.g. the captions editor's per-cue floating
    // toolbar) treat "select from the timeline" as selecting that segment.
    onSeek(seg.start);
    if (!lane.onSegmentChange) return;
    setSegDrag({
      laneId: lane.id,
      segId: seg.id,
      mode,
      pointerX: e.clientX,
      origStart: seg.start,
      origEnd: seg.end,
      barWidth: barEl.getBoundingClientRect().width,
      moved: false,
    });
  };

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
          </button>
          <span className="text-caption tabular-nums text-(--color-text-muted)">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
        <div className="flex items-center gap-1 text-(--color-text-muted)">
          {onSplit && (
            <button
              type="button"
              onClick={onSplit}
              title="Split the clip at the current playhead position"
              className="mr-1 inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-2 py-1 text-caption font-medium transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
            >
              <Scissors size={13} />
              Split
            </button>
          )}
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
            className="rounded p-1 hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            min={1}
            max={4}
            step={0.5}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-20 accent-(--color-primary-500)"
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
            className="rounded p-1 hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-caption font-medium hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
          >
            <Maximize2 size={12} />
            Fit
          </button>
        </div>
      </div>

      <div className="flex">
        {/* Gutter: lane labels, outside the scrolled/zoomed time area so every row below lines up with the ruler above it. */}
        <div className="shrink-0" style={{ width: GUTTER_WIDTH }}>
          <div style={{ height: RULER_HEIGHT }} />
          <div style={{ height: MAIN_TRACK_HEIGHT }} />
          {packedLanes.map(({ lane, rowCount }) => (
            <div
              key={lane.id}
              className="flex items-center truncate pr-2 text-caption text-(--color-text-faint)"
              style={{ height: rowCount * SUB_ROW_HEIGHT + (rowCount - 1) * SUB_ROW_GAP, marginTop: LANE_GAP }}
              title={lane.label}
            >
              {lane.label}
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div style={{ width: `${zoom * 100}%`, minWidth: "100%" }}>
            {/* Ruler */}
            <div
              className="relative select-none border-b border-(--color-border) text-caption text-(--color-text-faint)"
              style={{ height: RULER_HEIGHT }}
            >
              {ticks.map((t, i) => (
                <span key={i} className="absolute top-0 -translate-x-1/2 tabular-nums" style={{ left: `${pct(t)}%` }}>
                  {formatTime(t)}
                </span>
              ))}
            </div>

            {/* Main trim track + playhead */}
            <div className="relative select-none" style={{ height: MAIN_TRACK_HEIGHT }}>
              <div
                ref={trackRef}
                className="absolute top-1/2 h-4 w-full -translate-y-1/2 cursor-pointer rounded-full bg-(--color-bg-subtle)"
                onClick={(e) => {
                  if (dragging) return;
                  onSeek(timeAtClientX(e.clientX));
                }}
              >
                <div
                  className="absolute inset-y-0 rounded-full bg-primary-200 dark:bg-primary-900"
                  style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
                />
                <button
                  type="button"
                  aria-label="Trim start"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging("start");
                  }}
                  className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary-500 shadow-sm ring-2 ring-white dark:ring-neutral-900"
                  style={{ left: `${pct(start)}%` }}
                />
                <button
                  type="button"
                  aria-label="Trim end"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging("end");
                  }}
                  className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-primary-500 shadow-sm ring-2 ring-white dark:ring-neutral-900"
                  style={{ left: `${pct(end)}%` }}
                />
              </div>

              {/* Playhead spans the trim track + lanes below it */}
              <div
                className="pointer-events-none absolute top-0 z-10 h-full"
                style={{ left: `${pct(currentTime)}%` }}
                aria-hidden="true"
              >
                <div className="h-full w-0.5 bg-danger-500" />
              </div>
              <button
                type="button"
                aria-label="Playhead"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragging("playhead");
                }}
                className="absolute top-1 h-3 w-3 -translate-x-1/2 cursor-ew-resize rounded-full bg-danger-500 ring-2 ring-white dark:ring-neutral-900"
                style={{ left: `${pct(currentTime)}%` }}
              />
            </div>

            {/* Feature lanes */}
            {packedLanes.map(({ lane, packed, rowCount }) => {
              const editable = !!lane.onSegmentChange;
              const laneHeight = rowCount * SUB_ROW_HEIGHT + (rowCount - 1) * SUB_ROW_GAP;
              return (
                <div
                  key={lane.id}
                  className="relative cursor-pointer rounded bg-(--color-bg-subtle)"
                  style={{ height: laneHeight, marginTop: LANE_GAP }}
                  onClick={(e) => {
                    if (dragging || segDrag) return;
                    setSelected(null);
                    onSeek(timeAtClientX(e.clientX));
                  }}
                >
                  {packed.map(({ seg, row }) => {
                    const isSelected = selected?.laneId === lane.id && selected.segId === seg.id;
                    const left = pct(seg.start);
                    const width = Math.max(0.5, pct(seg.end) - pct(seg.start));
                    const top = row * (SUB_ROW_HEIGHT + SUB_ROW_GAP);
                    return (
                      <div
                        key={seg.id}
                        title={seg.label}
                        role="button"
                        tabIndex={0}
                        aria-label={seg.label ? `${lane.label} segment: ${seg.label}` : `${lane.label} segment`}
                        aria-pressed={isSelected}
                        className={`absolute overflow-hidden truncate rounded-sm border border-black/10 px-1 text-caption leading-none text-white shadow-sm dark:border-white/10 ${lane.colorClass} ${
                          editable ? "cursor-grab active:cursor-grabbing" : ""
                        } ${isSelected ? "ring-2 ring-offset-1 ring-(--color-text) dark:ring-offset-neutral-900" : ""}`}
                        style={{ left: `${left}%`, width: `${width}%`, top, height: SUB_ROW_HEIGHT }}
                        onPointerDown={(e) => startSegDrag(e, lane, seg, "move", e.currentTarget.parentElement as HTMLElement)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelected({ laneId: lane.id, segId: seg.id });
                          }
                        }}
                      >
                        <span className="flex h-full items-center">{seg.label}</span>
                        {editable && isSelected && (
                          <>
                            <div
                              aria-hidden="true"
                              onPointerDown={(e) =>
                                startSegDrag(e, lane, seg, "resize-start", e.currentTarget.parentElement?.parentElement as HTMLElement)
                              }
                              className="absolute -left-1 top-0 h-full w-2.5 cursor-ew-resize"
                            />
                            <div
                              aria-hidden="true"
                              onPointerDown={(e) =>
                                startSegDrag(e, lane, seg, "resize-end", e.currentTarget.parentElement?.parentElement as HTMLElement)
                              }
                              className="absolute -right-1 top-0 h-full w-2.5 cursor-ew-resize"
                            />
                          </>
                        )}
                        {isSelected && lane.onSegmentDelete && (
                          <button
                            type="button"
                            aria-label={`Delete ${lane.label.toLowerCase()} segment`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              lane.onSegmentDelete?.(seg.id);
                              setSelected(null);
                            }}
                            className="absolute -top-5 left-1/2 z-20 grid h-4 w-4 -translate-x-1/2 place-items-center rounded-full bg-danger-500 text-white shadow"
                          >
                            <Trash2 size={10} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-1 flex justify-between text-caption tabular-nums text-(--color-text-muted)">
        <span>{formatTime(start, true)}</span>
        <span>Selected: {formatTime(Math.max(0, end - start))}</span>
        <span>{formatTime(end, true)}</span>
      </div>
    </div>
  );
}
