import { useState } from "react";
import { Type, Captions, Play, Pause } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import FloatingTextToolbar, { MAX_TEXT_SIZE } from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import CaptionsEditor from "./CaptionsEditor";
import CaptionsPreview from "./CaptionsPreview";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { useCaptions } from "../../../lib/hooks/useCaptions";
import { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { escapeDrawtext } from "../../../lib/ffmpeg/drawtext";
import { TEXT_FONTS, getTextFont, DEFAULT_TEXT_FONT } from "../../../lib/ffmpeg/fonts";
import { positionExprs } from "../../../lib/ffmpeg/text-position";
import { POSITION_PRESETS, isAtPositionPreset, type TextPositionPreset } from "../../../lib/ffmpeg/text-position-presets";
import { buildCaptionsFilter } from "../../../lib/captions/build-captions-filter";
import { measureKaraokeLayouts } from "../../../lib/captions/karaoke-layout";
import { planCutoutOverlay } from "../../../lib/ffmpeg/person-cutout-filter";
import { formatTime } from "../../../lib/time";

type Mode = "text" | "captions";

const COLORS = ["#ffffff", "#000000", "#facc15", "#ef4444", "#22c55e", "#38bdf8"];

export default function AddTextTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const captions = useCaptions();
  const personCutout = usePersonCutout();
  const [mode, setMode] = useState<Mode>("text");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const togglePlay = () => {
    const el = video.videoRef.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  };

  const [text, setText] = useState("Your text here");
  const [color, setColor] = useState("#ffffff");
  const [fontSize, setFontSize] = useState(56);
  const [x, setX] = useState(50);
  const [y, setY] = useState(90);
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
    const { x: xExpr, y: yExpr } = positionExprs(x, y);
    const drawtext = [
      `drawtext=fontfile=${font.ffmpegName}`,
      `text='${escapeDrawtext(text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${colorHex}`,
      `x=${xExpr}`,
      `y=${yExpr}`,
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
          "-threads",
          "1",
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

    const cutoutPlan =
      captions.style.occludeByPerson && personCutout.frames.length > 0
        ? planCutoutOverlay({
            frames: personCutout.frames,
            timeOffset: 0,
            windowStart: 0,
            windowEnd: video.duration,
            targetWidth: video.videoWidth,
            targetHeight: video.videoHeight,
          })
        : null;

    if (!cutoutPlan) {
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
            "-threads",
            "1",
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
      return;
    }

    let labelCount = 0;
    const newLabel = () => `v${++labelCount}`;
    const { filters, outLabel } = cutoutPlan.buildFilters(1, "txt", newLabel);
    const filterComplex = [`[0:v]${vf}[txt]`, ...filters];

    await exportState.run(
      {
        inputs: [
          { name: inputName, data: video.file },
          { name: font.ffmpegName, data: fontBlob },
          ...cutoutPlan.inputs,
        ],
        args: [
          "-i",
          inputName,
          ...cutoutPlan.inputArgs,
          "-filter_complex",
          filterComplex.join(";"),
          "-map",
          `[${outLabel}]`,
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-threads",
          "1",
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
    personCutout.clear();
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
                  {(["top", "center", "bottom"] as TextPositionPreset[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setX(POSITION_PRESETS[p].x);
                        setY(POSITION_PRESETS[p].y);
                      }}
                      className={`flex-1 rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${
                        isAtPositionPreset(x, y, p)
                          ? "bg-primary-500 text-white"
                          : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <p className="text-caption text-(--color-text-muted)">Or drag the text in the preview to place it anywhere.</p>

                <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                  <input
                    type="checkbox"
                    checked={withBackground}
                    onChange={(e) => setWithBackground(e.target.checked)}
                    className="accent-(--color-primary-500)"
                  />
                  Background box
                </label>

                <label className="flex min-w-0 items-center gap-3 text-caption text-(--color-text-muted)">
                  Size
                  <input
                    type="range"
                    min={16}
                    max={MAX_TEXT_SIZE}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="min-w-0 flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-10 shrink-0 text-right tabular-nums">{fontSize}px</span>
                </label>
              </div>
            </ToolPanelSection>
          ) : (
            <CaptionsEditor video={video} captions={captions} personCutout={personCutout} rangeEnd={video.duration} />
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
            <div className="space-y-3">
              <FramedVideoStage
                videoRef={video.videoRef}
                sourceUrl={video.sourceUrl}
                naturalWidth={video.videoWidth}
                naturalHeight={video.videoHeight}
                onLoadedMetadata={video.onLoadedMetadata}
                onError={video.onError}
                onTimeUpdate={() => setCurrentTime(video.videoRef.current?.currentTime ?? 0)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              >
                {(box) => {
                  const scale = video.videoWidth > 0 ? box.width / video.videoWidth : 1;
                  return (
                    <>
                      <PositionedTextBlock
                        x={x}
                        y={y}
                        box={box}
                        draggable
                        onChange={(patch) => {
                          setX(patch.x);
                          setY(patch.y);
                        }}
                      >
                        <span
                          className="inline-block max-w-full whitespace-pre-wrap break-words font-semibold"
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
                      </PositionedTextBlock>
                      <FloatingTextToolbar
                        y={y}
                        fontId={fontId}
                        fontSize={fontSize}
                        color={color}
                        onChange={(patch) => {
                          if (patch.fontId !== undefined) setFontId(patch.fontId);
                          if (patch.fontSize !== undefined) setFontSize(patch.fontSize);
                          if (patch.color !== undefined) setColor(patch.color);
                        }}
                      />
                    </>
                  );
                }}
              </FramedVideoStage>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={isPlaying ? "Pause" : "Play"}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-500 text-white transition-colors hover:bg-primary-600"
                >
                  {isPlaying ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
                </button>
                <span className="text-caption tabular-nums text-(--color-text-muted)">
                  {formatTime(currentTime)} / {formatTime(video.duration)}
                </span>
              </div>
            </div>
          )
        ) : (
          <CaptionsPreview video={video} captions={captions} personCutout={personCutout} />
        )
      }
    />
  );
}
