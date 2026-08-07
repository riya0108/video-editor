import { useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import FramedVideoStage from "./FramedVideoStage";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, guessImageExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { evenRound } from "../../../lib/geometry";
import { ANCHORS, anchorExpr, type Anchor } from "../../../lib/ffmpeg/overlay-position";

export default function AddImageTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor>("top-right");
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
    setImageFile(picked);
    setImageUrl(URL.createObjectURL(picked));
  };

  const handleExport = async () => {
    if (!video.file || !imageFile || video.videoWidth === 0) return;
    const ext = guessVideoExtension(video.file);
    const imgExt = guessImageExtension(imageFile);
    const inputName = `input.${ext}`;
    const imageName = `overlay.${imgExt}`;
    const outputName = "output.mp4";

    const targetWidth = evenRound(video.videoWidth * (sizePercent / 100));
    const { x, y } = anchorExpr(anchor);

    const filterComplex =
      `[1:v]scale=${targetWidth}:-2,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm];` +
      `[0:v][wm]overlay=x=${x}:y=${y}[v]`;

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

  const { justify, align } = anchorExpr(anchor);

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      {video.sourceUrl && (
        <FramedVideoStage
          videoRef={video.videoRef}
          sourceUrl={video.sourceUrl}
          naturalWidth={video.videoWidth}
          naturalHeight={video.videoHeight}
          onLoadedMetadata={video.onLoadedMetadata}
        >
          {(box) =>
            imageUrl && (
              <div
                className="flex h-full w-full p-6"
                style={{
                  justifyContent: justify === "start" ? "flex-start" : justify === "end" ? "flex-end" : "center",
                  alignItems: align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center",
                }}
              >
                <img
                  src={imageUrl}
                  alt=""
                  style={{ width: box.width * (sizePercent / 100), opacity }}
                  className="max-w-none"
                />
              </div>
            )
          }
        </FramedVideoStage>
      )}

      {!imageFile ? (
        <div className="mt-4">
          <Dropzone
            accept="image/*"
            label="Drop a logo or image here"
            hint="PNG, JPG, or WebP"
            onFiles={handleImageFiles}
          />
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-center gap-6">
            <div className="grid grid-cols-3 gap-1.5">
              {ANCHORS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-label={a.id}
                  onClick={() => setAnchor(a.id)}
                  className={`grid h-9 w-9 place-items-center rounded-md border text-body-sm transition-colors ${
                    anchor === a.id
                      ? "border-primary-500 bg-primary-500 text-white"
                      : "border-(--color-border) hover:border-(--color-border-strong)"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                Size
                <input
                  type="range"
                  min={5}
                  max={60}
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
          </div>
        </div>
      )}

      <ExportStatus
        enginePhase={exportState.enginePhase}
        engineFraction={exportState.engineFraction}
        runFraction={exportState.runFraction}
        error={exportState.error}
        runLabel="Adding image…"
      />

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={exportState.isProcessing || !imageFile}
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImagePlus size={16} />
          {exportState.isProcessing ? "Adding image…" : "Add image"}
        </button>
      </div>
    </div>
  );
}
