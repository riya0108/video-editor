import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Renders a <video> inside a fixed-height box, correctly scaled and centered
 * for a live rotate/flip preview — including 90°/270° turns, where the
 * on-screen bounding box swaps from landscape to portrait (or vice versa).
 */
export default function TransformedVideoPreview({
  videoRef,
  sourceUrl,
  turns = 0,
  flipH = false,
  flipV = false,
  naturalWidth,
  naturalHeight,
  onLoadedMetadata,
  onError,
  onTimeUpdate,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourceUrl: string;
  turns?: 0 | 1 | 2 | 3;
  flipH?: boolean;
  flipV?: boolean;
  naturalWidth: number;
  naturalHeight: number;
  onLoadedMetadata?: () => void;
  onError?: () => void;
  onTimeUpdate?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 384 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const swapped = turns === 1 || turns === 3;
  let renderWidth = containerSize.width;
  let renderHeight = containerSize.height;

  if (naturalWidth > 0 && naturalHeight > 0) {
    const availableW = swapped ? containerSize.height : containerSize.width;
    const availableH = swapped ? containerSize.width : containerSize.height;
    const scale = Math.min(availableW / naturalWidth, availableH / naturalHeight);
    renderWidth = naturalWidth * scale;
    renderHeight = naturalHeight * scale;
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-96 w-full items-center justify-center overflow-hidden rounded-lg bg-black"
    >
      <video
        ref={videoRef}
        src={sourceUrl}
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
        onTimeUpdate={onTimeUpdate}
        style={{
          width: renderWidth || undefined,
          height: renderHeight || undefined,
          transform: `rotate(${turns * 90}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
        }}
      />
    </div>
  );
}
