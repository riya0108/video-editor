import { useEffect, useRef, useState, useCallback } from "react";
import { MoveHorizontal } from "lucide-react";
import { keyChromaForeground, drawCover } from "../../lib/media/bg-removal-canvas";

const W = 960;
const H = 600;

const PERSON_SRC = "/images/bg-removal-person.webp";
const BACKGROUND_SRC = "/images/bg-removal-office.webp";
const PERSON_GREEN = "#12d94a";

export default function BgRemovalDemo() {
  const beforeCanvasRef = useRef<HTMLCanvasElement>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const before = beforeCanvasRef.current;
    const after = afterCanvasRef.current;
    if (!before || !after) return;
    before.width = W;
    before.height = H;
    after.width = W;
    after.height = H;

    const beforeCtx = before.getContext("2d");
    const afterCtx = after.getContext("2d");
    if (!beforeCtx || !afterCtx) return;

    const person = new Image();
    const background = new Image();
    let cancelled = false;

    const render = () => {
      if (cancelled || !person.complete || !background.complete) return;

      drawCover(beforeCtx, person, person.naturalWidth, person.naturalHeight, W, H);

      const work = document.createElement("canvas");
      const foreground = keyChromaForeground(
        before,
        W,
        H,
        { colorHex: PERSON_GREEN, similarity: 0.22, blend: 0.12 },
        work,
      );

      drawCover(afterCtx, background, background.naturalWidth, background.naturalHeight, W, H);
      afterCtx.drawImage(foreground, 0, 0, W, H);
    };

    person.onload = render;
    background.onload = render;
    person.src = PERSON_SRC;
    background.src = BACKGROUND_SRC;

    return () => {
      cancelled = true;
    };
  }, []);

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(100, Math.max(0, pct)));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => updateFromClientX(e.clientX);
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, updateFromClientX]);

  return (
    <div
      ref={containerRef}
      className="relative aspect-[16/10] w-full touch-none select-none overflow-hidden rounded-2xl border border-(--color-border) bg-black shadow-lg"
      onPointerDown={(e) => {
        setDragging(true);
        updateFromClientX(e.clientX);
      }}
    >
      <canvas ref={afterCanvasRef} className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <canvas ref={beforeCanvasRef} className="h-full w-full object-cover" />
      </div>

      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 text-caption font-semibold text-white backdrop-blur-sm">
        Green screen
      </span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-caption font-semibold text-white backdrop-blur-sm">
        Background removed
      </span>

      <div className="pointer-events-none absolute inset-y-0" style={{ left: `${split}%` }}>
        <div className="absolute inset-y-0 left-0 w-px bg-white/80" />
        <div className="pointer-events-auto absolute top-1/2 left-0 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full bg-white text-(--color-primary-600) shadow-lg">
          <MoveHorizontal size={18} />
        </div>
      </div>
    </div>
  );
}
