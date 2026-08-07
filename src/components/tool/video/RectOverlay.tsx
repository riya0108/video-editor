import { useEffect, useRef, useState } from "react";

export interface FractionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode = null | "move" | "nw" | "ne" | "sw" | "se";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function applyDelta(
  mode: Exclude<DragMode, null>,
  dxFrac: number,
  dyFrac: number,
  start: FractionRect,
  minFraction: number,
): FractionRect {
  const next: FractionRect = { ...start };

  if (mode === "move") {
    next.x = clamp(start.x + dxFrac, 0, 1 - start.w);
    next.y = clamp(start.y + dyFrac, 0, 1 - start.h);
    return next;
  }

  if (mode.includes("w")) {
    const newX = clamp(start.x + dxFrac, 0, start.x + start.w - minFraction);
    next.w = start.w + (start.x - newX);
    next.x = newX;
  }
  if (mode.includes("e")) {
    next.w = clamp(start.w + dxFrac, minFraction, 1 - start.x);
  }
  if (mode.includes("n")) {
    const newY = clamp(start.y + dyFrac, 0, start.y + start.h - minFraction);
    next.h = start.h + (start.y - newY);
    next.y = newY;
  }
  if (mode.includes("s")) {
    next.h = clamp(start.h + dyFrac, minFraction, 1 - start.y);
  }
  return next;
}

const CORNERS = ["nw", "ne", "sw", "se"] as const;
const CORNER_POSITION: Record<(typeof CORNERS)[number], string> = {
  nw: "-left-1.5 -top-1.5",
  ne: "-right-1.5 -top-1.5",
  sw: "-left-1.5 -bottom-1.5",
  se: "-right-1.5 -bottom-1.5",
};
const CORNER_LABEL: Record<(typeof CORNERS)[number], string> = {
  nw: "Resize from top-left corner",
  ne: "Resize from top-right corner",
  sw: "Resize from bottom-left corner",
  se: "Resize from bottom-right corner",
};
const KEYBOARD_STEP = 0.02;

/** A draggable, resizable rectangle (in 0–1 fractions) over a fixed-size stage. Arrow keys move/resize too. */
export default function RectOverlay({
  boxWidth,
  boxHeight,
  rect,
  onChange,
  minFraction = 0.05,
  color = "primary",
}: {
  boxWidth: number;
  boxHeight: number;
  rect: FractionRect;
  onChange: (r: FractionRect) => void;
  minFraction?: number;
  color?: "primary" | "danger";
}) {
  const [mode, setMode] = useState<DragMode>(null);
  const dragStart = useRef({ pointerX: 0, pointerY: 0, rect });

  useEffect(() => {
    if (!mode) return;

    const handleMove = (e: PointerEvent) => {
      const dxFrac = (e.clientX - dragStart.current.pointerX) / boxWidth;
      const dyFrac = (e.clientY - dragStart.current.pointerY) / boxHeight;
      onChange(applyDelta(mode, dxFrac, dyFrac, dragStart.current.rect, minFraction));
    };

    const handleUp = () => setMode(null);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [mode, boxWidth, boxHeight, minFraction, onChange]);

  const startDrag = (m: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = { pointerX: e.clientX, pointerY: e.clientY, rect };
    setMode(m);
  };

  const handleKeyDown = (m: Exclude<DragMode, null>) => (e: React.KeyboardEvent) => {
    const step = KEYBOARD_STEP * (e.shiftKey ? 5 : 1);
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    onChange(applyDelta(m, dx, dy, rect, minFraction));
  };

  const px = {
    left: rect.x * boxWidth,
    top: rect.y * boxHeight,
    width: rect.w * boxWidth,
    height: rect.h * boxHeight,
  };
  const right = px.left + px.width;
  const bottom = px.top + px.height;

  const borderColor = color === "danger" ? "border-danger-500" : "border-primary-500";
  const bgColor = color === "danger" ? "bg-danger-500/10" : "bg-primary-500/10";
  const handleColor = color === "danger" ? "bg-danger-500" : "bg-primary-500";

  return (
    <>
      <div className="absolute bg-black/60" style={{ left: 0, top: 0, width: boxWidth, height: px.top }} />
      <div
        className="absolute bg-black/60"
        style={{ left: 0, top: bottom, width: boxWidth, height: boxHeight - bottom }}
      />
      <div className="absolute bg-black/60" style={{ left: 0, top: px.top, width: px.left, height: px.height }} />
      <div
        className="absolute bg-black/60"
        style={{ left: right, top: px.top, width: boxWidth - right, height: px.height }}
      />

      <div
        role="button"
        tabIndex={0}
        aria-label="Move selection. Use arrow keys to move, hold shift to move further."
        className={`absolute cursor-move border-2 ${borderColor} ${bgColor}`}
        style={px}
        onPointerDown={startDrag("move")}
        onKeyDown={handleKeyDown("move")}
      >
        {CORNERS.map((corner) => (
          <div
            key={corner}
            role="button"
            tabIndex={0}
            aria-label={`${CORNER_LABEL[corner]}. Use arrow keys to resize, hold shift to resize further.`}
            onPointerDown={startDrag(corner)}
            onKeyDown={handleKeyDown(corner)}
            className={`absolute h-3.5 w-3.5 rounded-full border-2 border-white ${handleColor} ${CORNER_POSITION[corner]}`}
            style={{ cursor: `${corner}-resize` }}
          />
        ))}
      </div>
    </>
  );
}
