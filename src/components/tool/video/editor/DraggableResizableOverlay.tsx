import { useEffect, useRef, useState, type ReactNode } from "react";
import { clamp } from "../../../../lib/time";

const SNAP_THRESHOLD_PCT = 1.5;
const MIN_SIZE_PCT = 4;
const MAX_SIZE_PCT = 100;

interface SnapResult {
  value: number;
  guideAt: number | null;
}

function snapAxis(centerPct: number, halfSizePct: number): SnapResult {
  const candidates = [
    { value: 50, guideAt: 50 },
    { value: halfSizePct, guideAt: 0 },
    { value: 100 - halfSizePct, guideAt: 100 },
  ];
  for (const c of candidates) {
    if (Math.abs(centerPct - c.value) <= SNAP_THRESHOLD_PCT) {
      return { value: c.value, guideAt: c.guideAt };
    }
  }
  return { value: centerPct, guideAt: null };
}

/**
 * Free-drag-anywhere + corner-resize overlay for images/clips on the video
 * preview, with alignment guides that snap to the frame's center and edges —
 * the same interaction PositionedTextBlock gives text. `x`/`y` are the
 * overlay's center as a percent of the frame; `sizePercent` is its width as
 * a percent of the frame width (height follows the content's own aspect ratio).
 */
export default function DraggableResizableOverlay({
  x,
  y,
  sizePercent,
  box,
  aspectRatio,
  draggable,
  onChange,
  children,
}: {
  x: number;
  y: number;
  sizePercent: number;
  box: { width: number; height: number };
  /** width / height of the content, used so the resize handle scales uniformly. */
  aspectRatio: number;
  draggable: boolean;
  onChange: (patch: { x: number; y: number; sizePercent: number }) => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<null | "move" | "resize">(null);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const dragStart = useRef({ pointerX: 0, pointerY: 0, x, y, sizePercent });
  const blockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mode) return;

    const handleMove = (e: PointerEvent) => {
      if (mode === "move") {
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
        onChange({ x: snapX.value, y: snapY.value, sizePercent: dragStart.current.sizePercent });
        return;
      }

      // Resize from the bottom-right handle: grow with the pointer's
      // distance from the block's fixed center.
      const dxPct = box.width > 0 ? ((e.clientX - dragStart.current.pointerX) / box.width) * 100 : 0;
      const nextSize = Math.round(clamp(dragStart.current.sizePercent + dxPct * 2, MIN_SIZE_PCT, MAX_SIZE_PCT) * 10) / 10;
      onChange({ x: dragStart.current.x, y: dragStart.current.y, sizePercent: nextSize });
    };

    const handleUp = () => {
      setMode(null);
      setGuides({ v: null, h: null });
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [mode, box.width, box.height, onChange]);

  const startMove = (e: React.PointerEvent) => {
    if (!draggable) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = { pointerX: e.clientX, pointerY: e.clientY, x, y, sizePercent };
    setMode("move");
  };

  const startResize = (e: React.PointerEvent) => {
    if (!draggable) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = { pointerX: e.clientX, pointerY: e.clientY, x, y, sizePercent };
    setMode("resize");
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
    onChange({ x: clamp(x + dx, 0, 100), y: clamp(y + dy, 0, 100), sizePercent });
  };

  const widthPx = box.width * (sizePercent / 100);
  const heightPx = aspectRatio > 0 ? widthPx / aspectRatio : widthPx;

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
        className="absolute"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: widthPx,
          height: heightPx,
          transform: "translate(-50%, -50%)",
          pointerEvents: draggable ? "auto" : "none",
          cursor: draggable ? (mode === "move" ? "grabbing" : "grab") : undefined,
          outline: draggable ? "1px dashed rgba(255,255,255,0.6)" : undefined,
          outlineOffset: draggable ? "2px" : undefined,
        }}
        onPointerDown={startMove}
        onKeyDown={handleKeyDown}
      >
        {children}
        {draggable && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Resize. Drag to scale, hold shift to resize further."
            onPointerDown={startResize}
            className="absolute -right-1.5 -bottom-1.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-primary-500"
            style={{ cursor: "nwse-resize" }}
          />
        )}
      </div>
    </>
  );
}
