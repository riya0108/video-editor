import { useState } from "react";
import { Type, Captions } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import CaptionsEditor from "./CaptionsEditor";
import CaptionsPreview from "./CaptionsPreview";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { useCaptions } from "../../../lib/hooks/useCaptions";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { escapeDrawtext } from "../../../lib/ffmpeg/drawtext";
import { TEXT_FONTS, getTextFont, DEFAULT_TEXT_FONT } from "../../../lib/ffmpeg/fonts";
import { buildCaptionsFilter } from "../../../lib/captions/build-captions-filter";
import { measureKaraokeLayouts } from "../../../lib/captions/karaoke-layout";

type Position = "top" | "center" | "bottom";
type Mode = "text" | "captions";

const POSITION_Y: Record<Position, string> = {
  top: "40",
  center: "(h-text_h)/2",
  bottom: "h-text_h-40",
};

const POSITION_CLASS: Record<Position, string> = {
  top: "items-start pt-[6%]",
  center: "items-center",
  bottom: "items-end pb-[6%]",
};

const COLORS = ["#ffffff", "#000000", "#facc15", "#ef4444", "#22c55e", "#38bdf8"];

export default function AddTextTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const captions = useCaptions();
  const [mode, setMode] = useState<Mode>("text");

  const [text, setText] = useState("Your text here");
  const [color, setColor] = useState("#ffffff");
  const [fontSize, setFontSize] = useState(56);
  const [position, setPosition] = useState<Position>("bottom");
  const [withBackground, setWithBackground] = useState(true);
  const [fontId, setFontId] = useState(DEFAULT_TEXT_FONT.id);

  const handleTextExport = async () => {
    if (!video.file || !text.trim()) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";
    const font = getTextFont(fontId);

    const fontBlob = await fetch(font.url).then((r) => r.blob());

    const colorHex = color.replace("#", "0x");
    const boxArg = withBackground ? ":box=1:boxcolor=0x000000@0.45:boxborderw=16" : "";
    const drawtext = [
      `drawtext=fontfile=${font.ffmpegName}`,
      `text='${escapeDrawtext(text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${colorHex}`,
      "x=(w-text_w)/2",
      `y=${POSITION_Y[position]}`,
    ].join(":") + boxArg;

    await exportState.run(
      {
        inputs: [
          { name: inputName, data: video.file },
          { name: font.ffmpegName, data: fontBlob },
        ],
        args: [
          "-i",
          inputName,
          "-vf",
          drawtext,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `text-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const handleCaptionsExport = async () => {
    if (!video.file || captions.cues.length === 0 || video.videoWidth === 0) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";
    const font = getTextFont(captions.style.fontId);

    const fontBlob = await fetch(font.url).then((r) => r.blob());
    const karaokeLayouts = captions.style.karaoke
      ? await measureKaraokeLayouts(captions.cues, captions.style, font.cssFontFamily, video.videoWidth)
      : undefined;
    const vf = buildCaptionsFilter(captions.cues, captions.style, font.ffmpegName, karaokeLayouts);

    await exportState.run(
      {
        inputs: [
          { name: inputName, data: video.file },
          { name: font.ffmpegName, data: fontBlob },
        ],
        args: [
          "-i",
          inputName,
          "-vf",
          vf,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "copy",
          outputName,
        ],
        outputName,
        outputMimeType: "video/mp4",
      },
      `captions-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const handleExport = mode === "text" ? handleTextExport : handleCaptionsExport;
  const canExport =
    mode === "text"
      ? !!text.trim()
      : captions.cues.length > 0 &&
        video.videoWidth > 0 &&
        !video.isMetadataLoading &&
        !video.metadataError;

  const reset = () => {
    exportState.reset();
    video.reset();
    setText("Your text here");
    captions.reset();
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Add captions, titles, or lower-thirds"
        onFiles={video.handleFiles}
      />
    );
  }

  if (exportState.result) {
    return (
      <ResultPanel
        url={exportState.result.url}
        blob={exportState.result.blob}
        filename={exportState.result.filename}
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <ToolSplitLayout
      controls={
        <>
          <div className="flex w-fit items-center gap-1 rounded-md border border-(--color-border) p-1">
            <button
              type="button"
              onClick={() => setMode("text")}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-caption font-medium transition-colors ${
                mode === "text" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
              }`}
            >
              <Type size={13} />
              Text Overlay
            </button>
            <button
              type="button"
              onClick={() => setMode("captions")}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-caption font-medium transition-colors ${
                mode === "captions"
                  ? "bg-primary-500 text-white"
                  : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
              }`}
            >
              <Captions size={13} />
              Captions
            </button>
          </div>

          {mode === "text" ? (
            <ToolPanelSection icon={Type} label="Text">
              <div className="space-y-4">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={2}
                  placeholder="Type your text…"
                  className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
                />

                <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                  Font
                  <select
                    value={fontId}
                    onChange={(e) => setFontId(e.target.value)}
                    className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                  >
                    {TEXT_FONTS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-center gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Text color ${c}`}
                      onClick={() => setColor(c)}
                      className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-primary-500" : "border-(--color-border)"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="h-6 w-6 cursor-pointer rounded border border-(--color-border) bg-transparent"
                    aria-label="Custom text color"
                  />
                </div>

                <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                  {(["top", "center", "bottom"] as Position[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPosition(p)}
                      className={`flex-1 rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${
                        position === p
                          ? "bg-primary-500 text-white"
                          : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                  <input
                    type="checkbox"
                    checked={withBackground}
                    onChange={(e) => setWithBackground(e.target.checked)}
                    className="accent-(--color-primary-500)"
                  />
                  Background box
                </label>

                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Size
                  <input
                    type="range"
                    min={16}
                    max={140}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-10 text-right tabular-nums">{fontSize}px</span>
                </label>
              </div>
            </ToolPanelSection>
          ) : (
            <CaptionsEditor video={video} captions={captions} />
          )}

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel={mode === "text" ? "Adding text…" : "Adding captions…"}
          />

          <button
            type="button"
            disabled={exportState.isProcessing || !canExport}
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mode === "text" ? <Type size={16} /> : <Captions size={16} />}
            {exportState.isProcessing
              ? mode === "text"
                ? "Adding text…"
                : "Adding captions…"
              : mode === "text"
                ? "Add text"
                : "Add captions"}
          </button>
        </>
      }
      preview={
        mode === "text" ? (
          video.sourceUrl && (
            <FramedVideoStage
              videoRef={video.videoRef}
              sourceUrl={video.sourceUrl}
              naturalWidth={video.videoWidth}
              naturalHeight={video.videoHeight}
              onLoadedMetadata={video.onLoadedMetadata}
              onError={video.onError}
            >
              {(box) => {
                const scale = video.videoWidth > 0 ? box.width / video.videoWidth : 1;
                return (
                  <div className={`flex h-full w-full justify-center px-4 text-center ${POSITION_CLASS[position]}`}>
                    <span
                      className="max-w-full whitespace-pre-wrap break-words font-semibold"
                      style={{
                        fontFamily: getTextFont(fontId).cssFontFamily,
                        fontSize: fontSize * scale,
                        color,
                        lineHeight: 1.1,
                        padding: withBackground ? `${8 * scale}px ${16 * scale}px` : 0,
                        backgroundColor: withBackground ? "rgba(0,0,0,0.45)" : "transparent",
                      }}
                    >
                      {text || " "}
                    </span>
                  </div>
                );
              }}
            </FramedVideoStage>
          )
        ) : (
          <CaptionsPreview video={video} captions={captions} />
        )
      }
    />
  );
}
