import FramedVideoStage from "./FramedVideoStage";
import CaptionOverlay from "./editor/CaptionOverlay";
import FloatingTextToolbar from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import { nearestCutoutFrame } from "../../../lib/captions/person-cutout";
import { useVideoClock } from "../../../lib/hooks/useVideoClock";
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
  const previewTime = useVideoClock(video.videoRef);
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
      controls
      overlayInteractive={false}
    >
      {(box) => {
        const scale = video.videoWidth > 0 ? box.width / video.videoWidth : 1;
        return (
          <>
            {activeCue && (
              <PositionedTextBlock x={style.x} y={style.y} box={box} draggable onChange={captions.updateStyle}>
                <CaptionOverlay
                  style={style}
                  cue={activeCue}
                  currentTime={previewTime}
                  scale={scale}
                  maxWidthPx={Math.max(0, box.width * 0.92 - 32)}
                />
              </PositionedTextBlock>
            )}
            {activeCue && (
              <FloatingTextToolbar
                y={style.y}
                fontId={style.fontId}
                fontSize={activeCue.fontSize ?? style.fontSize}
                color={style.color}
                onChange={({ fontSize, ...stylePatch }) => {
                  // Size applies to just this one caption (the one currently
                  // under the scrubber) rather than every caption; font/color
                  // stay style-wide. See CaptionCue.fontSize.
                  if (fontSize !== undefined) captions.updateCue(activeCue.id, { fontSize });
                  if (Object.keys(stylePatch).length > 0) captions.updateStyle(stylePatch);
                }}
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
