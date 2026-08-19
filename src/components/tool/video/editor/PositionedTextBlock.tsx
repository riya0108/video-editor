import { useEffect, useRef, useState, type ReactNode } from "react";
import { clamp } from "../../../../lib/time";

const SNAP_THRESHOLD_PCT = 1.5;

interface SnapResult {
  value: number;
  guideAt: number | null;
}

/** Snaps a center coordinate (percent) to frame-center or to either edge of the frame, given the block's own half-size (percent) along that axis. */
function snapAxis(centerPct: number, halfSizePct: number): SnapResult {
  const candidates = [
    { value: 50, guideAt: 50 }, // frame center
    { value: halfSizePct, guideAt: 0 }, // flush with the near edge
    { value: 100 - halfSizePct, guideAt: 100 }, // flush with the far edge
  ];
  for (const c of candidates) {
    if (Math.abs(centerPct - c.value) <= SNAP_THRESHOLD_PCT) {
      return { value: c.value, guideAt: c.guideAt };
    }
  }
  return { value: centerPct, guideAt: null };
}

/**
 * Wraps a text/caption block so it can be dragged anywhere over the preview
 * (not just a fixed top/center/bottom slot). `x`/`y` are a percent (0-100)
 * of the frame, anchored at the block's own center — matches the
 * frame-relative x/y the ffmpeg drawtext filters position from, so what you
 * see here is where it burns in on export. While dragging, it snaps to and
 * shows guide lines for the frame's center and edges.
 */
export default function PositionedTextBlock({
  x,
  y,
  box,
  draggable,
  onChange,
  children,
}: {
  x: number;
  y: number;
  box: { width: number; height: number };
  /** Only draggable while its panel is the active one — avoids accidental drags while working on something else. */
  draggable: boolean;
  onChange: (patch: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const dragStart = useRef({ pointerX: 0, pointerY: 0, x, y });
  const blockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: PointerEvent) => {
      const dxPct = box.width > 0 ? ((e.clientX - dragStart.current.pointerX) / box.width) * 100 : 0;
      const dyPct = box.height > 0 ? ((e.clientY - dragStart.current.pointerY) / box.height) * 100 : 0;
      const rawX = clamp(dragStart.current.x + dxPct, 0, 100);
      const rawY = clamp(dragStart.current.y + dyPct, 0, 100);

      const rect = blockRef.current?.getBoundingClientRect();
      const halfWPct = rect && box.width > 0 ? ((rect.width / 2) / box.width) * 100 : 0;
      const halfHPct = rect && box.height > 0 ? ((rect.height / 2) / box.height) * 100 : 0;

      const snapX = snapAxis(rawX, halfWPct);
      const snapY = snapAxis(rawY, halfHPct);

      setGuides({ v: snapX.guideAt, h: snapY.guideAt });
      onChange({ x: snapX.value, y: snapY.value });
    };
    const handleUp = () => {
      setDragging(false);
      setGuides({ v: null, h: null });
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragging, box.width, box.height, onChange]);

  const startDrag = (e: React.PointerEvent) => {
    if (!draggable) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = { pointerX: e.clientX, pointerY: e.clientY, x, y };
    setDragging(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!draggable) return;
    const step = e.shiftKey ? 5 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    onChange({ x: clamp(x + dx, 0, 100), y: clamp(y + dy, 0, 100) });
  };

  return (
    <>
      {guides.v !== null && (
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary-400"
          style={{ left: `${guides.v}%` }}
          aria-hidden="true"
        />
      )}
      {guides.h !== null && (
        <div
          className="pointer-events-none absolute left-0 right-0 h-px bg-primary-400"
          style={{ top: `${guides.h}%` }}
          aria-hidden="true"
        />
      )}
      <div
        ref={blockRef}
        role={draggable ? "button" : undefined}
        tabIndex={draggable ? 0 : undefined}
        aria-label={draggable ? "Drag to reposition. Arrow keys move, hold shift to move further." : undefined}
        className="absolute max-w-[92%] px-4 text-center"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          transform: "translate(-50%, -50%)",
          pointerEvents: draggable ? "auto" : "none",
          cursor: draggable ? (dragging ? "grabbing" : "grab") : undefined,
          outline: draggable ? "1px dashed rgba(255,255,255,0.5)" : undefined,
          outlineOffset: draggable ? "4px" : undefined,
        }}
        onPointerDown={startDrag}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </>
  );
}
