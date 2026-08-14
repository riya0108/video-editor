import type { RefObject } from "react";
import type { EditorExtraClipState } from "../../../../lib/ffmpeg/editor-state";

/**
 * The intro/outro clip's own preview layer — rendered via FramedVideoStage's
 * `stageOverlay` slot (full-stage, not the main video's letterboxed content
 * box, since the extra clip has its own unrelated natural dimensions).
 * Stays permanently mounted and is toggled with opacity/visibility rather
 * than being created/destroyed or `src`-swapped, so scrubbing back and
 * forth across a boundary never triggers a reload/seek stall.
 */
export default function ExtraClipLayer({
  extraClip,
  extraVideoRef,
  sourceUrl,
  visible,
  onVideoLoadedMetadata,
}: {
  extraClip: EditorExtraClipState;
  extraVideoRef: RefObject<HTMLVideoElement | null>;
  sourceUrl: string | null;
  visible: boolean;
  onVideoLoadedMetadata?: () => void;
}) {
  if (!sourceUrl) return null;

  return (
    <div
      aria-hidden={!visible}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black"
      style={{ opacity: visible ? 1 : 0, visibility: visible ? "visible" : "hidden", pointerEvents: "none" }}
    >
      {extraClip.kind === "video" ? (
        <video
          ref={extraVideoRef}
          src={sourceUrl}
          playsInline
          onLoadedMetadata={onVideoLoadedMetadata}
          className="max-h-full max-w-full"
        />
      ) : (
        <img src={sourceUrl} alt="" className="max-h-full max-w-full object-contain" />
      )}
    </div>
  );
}
