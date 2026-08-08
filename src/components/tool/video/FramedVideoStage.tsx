import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * Fits a video (object-fit: contain, without relying on CSS which can't
 * report the letterboxed content box) inside a fixed-height stage, and
 * renders `children` in an absolutely-positioned layer sized to exactly
 * match the visible video content — so overlays (crop box, logo box) line
 * up with real pixels instead of any letterbox bars.
 */
export default function FramedVideoStage({
  videoRef,
  sourceUrl,
  naturalWidth,
  naturalHeight,
  onLoadedMetadata,
  onTimeUpdate,
  onPlay,
  onPause,
  controls = false,
  overlayInteractive = true,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  sourceUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  onLoadedMetadata?: () => void;
  onTimeUpdate?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  controls?: boolean;
  /** Set false for purely-visual overlays (e.g. caption preview) so clicks reach native video controls underneath. */
  overlayInteractive?: boolean;
  children?: (box: { width: number; height: number }) => ReactNode;
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

  let box = { width: containerSize.width, height: containerSize.height };
  if (naturalWidth > 0 && naturalHeight > 0 && containerSize.width > 0) {
    const scale = Math.min(containerSize.width / naturalWidth, containerSize.height / naturalHeight);
    box = { width: naturalWidth * scale, height: naturalHeight * scale };
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
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlay}
        onPause={onPause}
        controls={controls}
        style={{ width: box.width || undefined, height: box.height || undefined }}
      />
      {box.width > 0 && (
        <div
          className="pointer-events-none absolute"
          style={{ width: box.width, height: box.height }}
        >
          <div className={`absolute inset-0 ${overlayInteractive ? "pointer-events-auto" : "pointer-events-none"}`}>
            {children?.(box)}
          </div>
        </div>
      )}
    </div>
  );
}
