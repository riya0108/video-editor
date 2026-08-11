import { useState } from "react";
import FramedVideoStage from "./FramedVideoStage";
import type { CaptionPosition } from "../../../lib/captions/types";
import { getTextFont } from "../../../lib/ffmpeg/fonts";
import type { useCaptions } from "../../../lib/hooks/useCaptions";
import type { useVideoFile } from "../../../lib/hooks/useVideoFile";

/** Live video + burned-in caption preview, kept separate from CaptionsEditor's controls so it can sit in the shared preview column. */
export default function CaptionsPreview({
  video,
  captions,
}: {
  video: ReturnType<typeof useVideoFile>;
  captions: ReturnType<typeof useCaptions>;
}) {
  const [previewTime, setPreviewTime] = useState(0);
  const { style, cues } = captions;
  const font = getTextFont(style.fontId);
  const activeCue = cues.find((c) => previewTime >= c.start && previewTime < c.end);

  const displayText = (text: string) => (style.uppercase ? text.toLocaleUpperCase() : text);

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
        const positionClass: Record<CaptionPosition, string> = {
          top: "items-start pt-[6%]",
          center: "items-center",
          bottom: "items-end pb-[6%]",
        };
        return (
          <div className={`flex h-full w-full justify-center px-4 text-center ${positionClass[style.position]}`}>
            {activeCue && (
              <span
                className="max-w-full whitespace-pre-wrap break-words font-semibold"
                style={{
                  fontFamily: font.cssFontFamily,
                  fontSize: style.fontSize * scale,
                  color: style.color,
                  lineHeight: 1.15,
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
            )}
          </div>
        );
      }}
    </FramedVideoStage>
  );
}
