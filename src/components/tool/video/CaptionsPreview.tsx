import { useState } from "react";
import FramedVideoStage from "./FramedVideoStage";
import FloatingTextToolbar from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import { nearestCutoutFrame } from "../../../lib/captions/person-cutout";
import { getTextFont } from "../../../lib/ffmpeg/fonts";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";

const FADE_DURATION = 0.35;

/** Mirrors the export-time alpha ramp (build-captions-filter.ts's fadeAlphaExpr) closely enough for a live preview. */
function fadeOpacity(time: number, start: number, end: number): number {
  const dur = Math.min(FADE_DURATION, Math.max(0.05, (end - start) / 2));
  if (time < start + dur) return Math.max(0, (time - start) / dur);
  if (time > end - dur) return Math.max(0, (end - time) / dur);
  return 1;
}

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
  const font = getTextFont(style.fontId);
  const activeCue = cues.find((c) => previewTime >= c.start && previewTime < c.end);

  const displayText = (text: string) => (style.uppercase ? text.toLocaleUpperCase() : text);
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
        const opacity = activeCue && style.fade ? fadeOpacity(previewTime, activeCue.start, activeCue.end) : 1;
        return (
          <>
            {activeCue && (
              <PositionedTextBlock x={style.x} y={style.y} box={box} draggable onChange={captions.updateStyle}>
                <span
                  className="inline-block max-w-full whitespace-pre-wrap break-words font-semibold"
                  style={{
                    fontFamily: font.cssFontFamily,
                    fontSize: style.fontSize * scale,
                    color: style.color,
                    lineHeight: 1.15,
                    opacity,
                    padding: style.background ? `${8 * scale}px ${16 * scale}px` : 0,
                    backgroundColor: style.background ? style.backgroundColor : "transparent",
                    WebkitTextStroke: style.outline ? `${Math.max(1, 2 * scale)}px ${style.outlineColor}` : undefined,
                    paintOrder: style.outline ? "stroke fill" : undefined,
                  }}
                >
                  {style.karaoke && activeCue.words
                    ? activeCue.words.map((word, i) => (
                        <span
                          key={i}
                          style={{
                            color: previewTime >= word.start && previewTime < word.end ? style.highlightColor : undefined,
                          }}
                        >
                          {displayText(word.text)}
                          {i < activeCue.words!.length - 1 ? " " : ""}
                        </span>
                      ))
                    : displayText(activeCue.text)}
                </span>
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
