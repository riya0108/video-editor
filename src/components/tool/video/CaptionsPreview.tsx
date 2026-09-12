import { useState } from "react";
import FramedVideoStage from "./FramedVideoStage";
import CaptionOverlay from "./editor/CaptionOverlay";
import FloatingTextToolbar from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import { nearestCutoutFrame } from "../../../lib/captions/person-cutout";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";

/** Live video + burned-in caption preview, kept separate from CaptionsEditor's controls so it can sit in the shared preview column. */
export default function CaptionsPreview({
  video,
  captions,
  personCutout,
}: {
  video: ReturnType<typeof useVideoFile>;
  captions: ReturnType<typeof useCaptions>;
  personCutout?: ReturnType<typeof usePersonCutout>;
}) {
  const [previewTime, setPreviewTime] = useState(0);
  const { style, cues } = captions;
  const activeCue = cues.find((c) => previewTime >= c.start && previewTime < c.end);

  const cutoutFrame =
    style.occludeByPerson && personCutout ? nearestCutoutFrame(personCutout.frames, previewTime) : null;

  if (!video.sourceUrl) return null;

  return (
    <FramedVideoStage
      videoRef={video.videoRef}
      sourceUrl={video.sourceUrl}
      naturalWidth={video.videoWidth}
      naturalHeight={video.videoHeight}
      onLoadedMetadata={video.onLoadedMetadata}
      onError={video.onError}
      onTimeUpdate={() => setPreviewTime(video.videoRef.current?.currentTime ?? 0)}
      controls
      overlayInteractive={false}
    >
      {(box) => {
        const scale = video.videoWidth > 0 ? box.width / video.videoWidth : 1;
        return (
          <>
            {activeCue && (
              <PositionedTextBlock x={style.x} y={style.y} box={box} draggable onChange={captions.updateStyle}>
                <CaptionOverlay style={style} cue={activeCue} currentTime={previewTime} scale={scale} />
              </PositionedTextBlock>
            )}
            {activeCue && (
              <FloatingTextToolbar
                y={style.y}
                fontId={style.fontId}
                fontSize={style.fontSize}
                color={style.color}
                onChange={captions.updateStyle}
              />
            )}
            {cutoutFrame && (
              <img
                src={cutoutFrame.url}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full"
                style={{ width: box.width, height: box.height }}
              />
            )}
          </>
        );
      }}
    </FramedVideoStage>
  );
}
