import type { ReactEventHandler, RefObject } from "react";

/**
 * The plain upload → single-control → preview tools' media box: a letterboxed
 * black stage for the source video/image. Deliberately has no outer
 * border/shadow of its own — the surrounding ToolSplitLayout preview slot
 * already supplies that card chrome, so this only owns the inner "player
 * bezel" look.
 */
export default function SimplePreviewStage({
  kind = "video",
  videoRef,
  sourceUrl,
  onLoadedMetadata,
  onError,
  onLoad,
  muted,
}: {
  kind?: "video" | "image";
  videoRef?: RefObject<HTMLVideoElement | null>;
  sourceUrl: string;
  onLoadedMetadata?: () => void;
  onError?: () => void;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  muted?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg bg-black">
      {kind === "image" ? (
        <img src={sourceUrl} alt="" className="max-h-[32rem] w-full object-contain" onLoad={onLoad} />
      ) : (
        <video
          ref={videoRef}
          src={sourceUrl}
          controls
          muted={muted}
          className="max-h-[32rem] w-full"
          onLoadedMetadata={onLoadedMetadata}
          onError={onError}
        />
      )}
    </div>
  );
}
