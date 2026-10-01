import { useEffect, useRef } from "react";
import { pan, zoomAt, clampZoom, type ViewportState } from "../../../../lib/matting/pipeline/refine/viewport";

/**
 * MATTE COMPARISON VIEWER. A `<canvas>` whose pixel content is drawn once
 * per `draw` change (view-mode switches), while zoom/pan is applied purely
 * via a CSS `transform` driven by a SHARED `ViewportState` — this is what
 * makes "synchronized zoom/pan" trivial across multiple panes: every
 * visible canvas reads the same state object and re-renders the same
 * transform, with no per-pixel redraw work on pan/zoom itself.
 * `refine/viewport.ts`'s pure coordinate math (previously unused anywhere
 * in the app) is reused as-is for the interaction math only — converting a
 * wheel/drag event into a new `ViewportState`.
 */
export default function ComparisonCanvas({
  width,
  height,
  draw,
  viewport,
  onViewportChange,
  interactive = true,
  checkerboardBackdrop = false,
  label,
  className = "",
}: {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
  viewport: ViewportState;
  onViewportChange: (next: ViewportState) => void;
  interactive?: boolean;
  /** Shows the app's transparency-indicator checkerboard behind the canvas — for a view mode that draws with real per-pixel alpha (e.g. "AI Result"). */
  checkerboardBackdrop?: boolean;
  label?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, width, height]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = Math.exp(-e.deltaY * 0.0015);
    onViewportChange(zoomAt(viewport, anchor, clampZoom(viewport.zoom * factor)));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    dragState.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !dragState.current) return;
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    dragState.current = { x: e.clientX, y: e.clientY };
    onViewportChange(pan(viewport, dx, dy));
  };

  const handlePointerUp = () => {
    dragState.current = null;
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      className={`relative h-full w-full overflow-hidden ${checkerboardBackdrop ? "bg-checkerboard" : "bg-(--color-bg-subtle)"} ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${className}`}
    >
      {label && (
        <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-black/60 px-2 py-1 text-caption font-medium text-white">
          {label}
        </span>
      )}
      <canvas
        ref={canvasRef}
        style={{ transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`, transformOrigin: "0 0" }}
        className="absolute left-0 top-0"
      />
    </div>
  );
}
