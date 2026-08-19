import { useRef, useState } from "react";
import type { FractionPoint } from "../../../lib/ffmpeg/logo-removal";

const MIN_POINT_DIST = 0.006;

/** Lets the user paint over a logo/watermark by dragging a brush, rather than dragging a single precise outline. */
export default function BrushOverlay({
  boxWidth,
  boxHeight,
  points,
  brushRadius,
  onChange,
  color = "danger",
  mode = "paint",
}: {
  boxWidth: number;
  boxHeight: number;
  points: FractionPoint[];
  /** Fraction of min(videoWidth, videoHeight) — used here to size the on-screen stroke to match. */
  brushRadius: number;
  onChange: (points: FractionPoint[]) => void;
  color?: "primary" | "danger";
  /** "erase" drags remove any existing points within brushRadius of the cursor instead of adding new ones. */
  mode?: "paint" | "erase";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState(false);
  const drawnPoints = useRef<FractionPoint[]>([]);
  const erasingPoints = useRef<FractionPoint[]>([]);

  const toFraction = (e: { clientX: number; clientY: number }): FractionPoint | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / boxWidth));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / boxHeight));
    return { x, y };
  };

  const eraseNear = (pts: FractionPoint[], center: FractionPoint) =>
    pts.filter((pt) => Math.hypot(pt.x - center.x, pt.y - center.y) > brushRadius);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toFraction(e);
    if (!p) return;
    if (mode === "erase") {
      erasingPoints.current = eraseNear(points, p);
      onChange(erasingPoints.current);
      setDrawing(true);
      return;
    }
    drawnPoints.current = [p];
    onChange(drawnPoints.current);
    setDrawing(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const p = toFraction(e);
    if (!p) return;
    if (mode === "erase") {
      const next = eraseNear(erasingPoints.current, p);
      if (next.length !== erasingPoints.current.length) {
        erasingPoints.current = next;
        onChange(next);
      }
      return;
    }
    const last = drawnPoints.current[drawnPoints.current.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_DIST) return;
    drawnPoints.current = [...drawnPoints.current, p];
    onChange(drawnPoints.current);
  };

  const handlePointerUp = () => setDrawing(false);

  const strokeColor = color === "danger" ? "#ef4444" : "#3b82f6";
  const strokeWidthPx = brushRadius * 2 * Math.min(boxWidth, boxHeight);
  const pathD = points.length > 1 ? `M ${points.map((p) => `${p.x * boxWidth},${p.y * boxHeight}`).join(" L ")}` : "";
  const dotR = strokeWidthPx / 2;

  return (
    <div
      ref={containerRef}
      role="button"
      tabIndex={0}
      aria-label={
        mode === "erase" ? "Drag to erase part of the brush stroke" : "Drag to paint a brush stroke over the logo or watermark"
      }
      className={`absolute inset-0 touch-none ${mode === "erase" ? "cursor-cell" : "cursor-crosshair"}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <svg width={boxWidth} height={boxHeight} className="pointer-events-none absolute inset-0">
        {points.length === 1 && (
          <circle cx={points[0].x * boxWidth} cy={points[0].y * boxHeight} r={dotR} fill={`${strokeColor}55`} stroke={strokeColor} strokeWidth={2} />
        )}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={`${strokeColor}66`}
            strokeWidth={strokeWidthPx}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {pathD && <path d={pathD} fill="none" stroke={strokeColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
        {points.length === 0 && mode === "paint" && (
          <text x={boxWidth / 2} y={boxHeight / 2} textAnchor="middle" fill="white" fontSize={13} opacity={0.85}>
            Drag to paint over the watermark
          </text>
        )}
      </svg>
    </div>
  );
}
