import { useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import DraggableResizableOverlay from "./editor/DraggableResizableOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, guessImageExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";
import { freeOverlayExprs } from "../../../lib/ffmpeg/overlay-position";

export default function AddImageTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageAspect, setImageAspect] = useState(1);
  const [x, setX] = useState(85);
  const [y, setY] = useState(15);
  const [sizePercent, setSizePercent] = useState(20);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const handleImageFiles = (files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    const url = URL.createObjectURL(picked);
    setImageFile(picked);
    setImageUrl(url);
    setX(85);
    setY(15);

    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        setImageAspect(probe.naturalWidth / probe.naturalHeight);
      }
    };
    probe.src = url;
  };

  const handleExport = async () => {
    if (!video.file || !imageFile || video.videoWidth === 0 || video.isMetadataLoading) return;
    const ext = guessVideoExtension(video.file);
    const imgExt = guessImageExtension(imageFile);
    const inputName = `input.${ext}`;
    const imageName = `overlay.${imgExt}`;
    const outputName = "output.mp4";

    const targetWidth = evenRound(video.videoWidth * (sizePercent / 100));
    const { x: xExpr, y: yExpr } = freeOverlayExprs(x, y);

    const filterComplex =
      `[1:v]scale=${targetWidth}:-2,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm];` +
      `[0:v][wm]overlay=x=${xExpr}:y=${yExpr}[v]`;

    await exportState.run(
      {
        inputs: [
          { name: inputName, data: video.file },
          { name: imageName, data: imageFile },
        ],
        args: [
          "-i",
          inputName,
          "-i",
          imageName,
          "-filter_complex",
          filterComplex,
          "-map",
          "[v]",
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
      `image-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setImageFile(null);
    setImageUrl(null);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Place a logo, watermark, or photo on top"
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
          <ToolPanelSection icon={ImagePlus} label="Overlay image">
            {!imageFile ? (
              <Dropzone
                accept="image/*"
                label="Drop a logo or image here"
                hint="PNG, JPG, or WebP"
                onFiles={handleImageFiles}
              />
            ) : (
              <div className="space-y-4">
                <p className="text-caption text-(--color-text-muted)">
                  Drag the image in the preview to place it anywhere, and drag its corner handle to resize.
                </p>

                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Size
                  <input
                    type="range"
                    min={4}
                    max={100}
                    value={sizePercent}
                    onChange={(e) => setSizePercent(Number(e.target.value))}
                    className="w-32 accent-(--color-primary-500)"
                  />
                  <span className="w-10 tabular-nums">{sizePercent}%</span>
                </label>
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Opacity
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                    className="w-32 accent-(--color-primary-500)"
                  />
                  <span className="w-10 tabular-nums">{Math.round(opacity * 100)}%</span>
                </label>
              </div>
            )}
          </ToolPanelSection>

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Adding image…"
          />

          <button
            type="button"
            disabled={
              exportState.isProcessing || !imageFile || video.isMetadataLoading || !!video.metadataError
            }
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImagePlus size={16} />
            {exportState.isProcessing
              ? "Adding image…"
              : video.isMetadataLoading
                ? "Reading video…"
                : "Add image"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <FramedVideoStage
            videoRef={video.videoRef}
            sourceUrl={video.sourceUrl}
            naturalWidth={video.videoWidth}
            naturalHeight={video.videoHeight}
            onLoadedMetadata={video.onLoadedMetadata}
            onError={video.onError}
          >
            {(box) =>
              imageUrl && (
                <DraggableResizableOverlay
                  x={x}
                  y={y}
                  sizePercent={sizePercent}
                  box={box}
                  aspectRatio={imageAspect}
                  draggable
                  onChange={(patch) => {
                    setX(patch.x);
                    setY(patch.y);
                    setSizePercent(patch.sizePercent);
                  }}
                >
                  <img
                    src={imageUrl}
                    alt=""
                    style={{ width: "100%", height: "100%", opacity }}
                    className="max-w-none"
                  />
                </DraggableResizableOverlay>
              )
            }
          </FramedVideoStage>
        )
      }
    />
  );
}
