import { useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { pan, zoomAt, clampZoom, type ViewportState } from "../../../../lib/matting/pipeline/refine/viewport";

/**
 * MATTE COMPARISON VIEWER. A draggable-divider before/after comparison
 * slider — genuinely new; no such component existed anywhere in this
 * codebase before this tool (confirmed by search: `RefineMattePanel.tsx`'s
 * "hold to show original" is a press-and-hold toggle, not a swipeable
 * split). Purely a LAYOUT component: `before`/`after` are whatever content
 * the caller renders (a `ComparisonCanvas`, a `<video>`, anything) — this
 * component only owns the clip-path divider position and forwards
 * wheel/drag-to-pan on the open background to the shared `ViewportState`,
 * the same interaction math `ComparisonCanvas` itself uses (`refine/
 * viewport.ts`), so the two stay in sync with `ComparisonCanvas`-based
 * panes used elsewhere in side-by-side mode.
 */
export default function BeforeAfterSlider({
  before,
  after,
  beforeLabel = "Before",
  afterLabel = "After",
  viewport,
  onViewportChange,
}: {
  before: ReactNode;
  after: ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
  viewport: ViewportState;
  onViewportChange: (next: ViewportState) => void;
}) {
  const [splitPercent, setSplitPercent] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingHandle = useRef(false);
  const draggingPan = useRef<{ x: number; y: number } | null>(null);

  const updateSplitFromClientX = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.min(100, Math.max(0, pct)));
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = Math.exp(-e.deltaY * 0.0015);
    onViewportChange(zoomAt(viewport, anchor, clampZoom(viewport.zoom * factor)));
  };

  const handleBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingPan.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    draggingHandle.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingHandle.current) {
      updateSplitFromClientX(e.clientX);
      return;
    }
    if (draggingPan.current) {
      const dx = e.clientX - draggingPan.current.x;
      const dy = e.clientY - draggingPan.current.y;
      draggingPan.current = { x: e.clientX, y: e.clientY };
      onViewportChange(pan(viewport, dx, dy));
    }
  };

  const handlePointerUp = () => {
    draggingHandle.current = false;
    draggingPan.current = null;
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      className="relative h-full w-full cursor-grab overflow-hidden bg-(--color-bg-subtle) active:cursor-grabbing"
    >
      <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-black/60 px-2 py-1 text-caption font-medium text-white">
        {beforeLabel}
      </span>
      <div className="pointer-events-none absolute inset-0">{before}</div>

      <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 0 0 ${splitPercent}%)` }}>
        <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-md bg-black/60 px-2 py-1 text-caption font-medium text-white">
          {afterLabel}
        </span>
        {after}
      </div>

      <div
        className="absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize items-center justify-center"
        style={{ left: `${splitPercent}%` }}
        onPointerDown={handleHandlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" />
        <div className="absolute grid h-7 w-7 place-items-center rounded-full bg-white text-(--color-text) shadow-md">
          <GripVertical size={14} />
        </div>
      </div>
    </div>
  );
}
