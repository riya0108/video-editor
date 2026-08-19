import { useState } from "react";
import { Eraser, Plus, Trash2 } from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { guessVideoExtension, stripExtension } from "../../../lib/ffmpeg/format";
import { buildLogoRemovalFilter, type LogoRegion } from "../../../lib/ffmpeg/logo-removal";
import { formatTime } from "../../../lib/time";

interface Region {
  id: string;
  rect: FractionRect;
  /** 0-100 */
  strength: number;
  timeRangeEnabled: boolean;
  start: number;
  /** 0 until metadata (or a later addRegion call) fills in the real duration. */
  end: number;
}

const DEFAULT_RECT: FractionRect = { x: 0.72, y: 0.06, w: 0.22, h: 0.14 };
const REGION_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

let nextRegionId = 1;
function makeRegion(rect: FractionRect, duration: number): Region {
  return { id: `region-${nextRegionId++}`, rect, strength: 60, timeRangeEnabled: false, start: 0, end: duration };
}

export default function RemoveLogoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [regions, setRegions] = useState<Region[]>(() => [makeRegion(DEFAULT_RECT, 0)]);
  const [selectedId, setSelectedId] = useState(() => regions[0].id);

  const selectedIndex = regions.findIndex((r) => r.id === selectedId);
  const selected = regions[selectedIndex] ?? regions[0];

  const updateRegion = (id: string, patch: Partial<Region>) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRegion = () => {
    const n = regions.length;
    const offset = (n % 5) * 0.04;
    const rect: FractionRect = {
      x: Math.max(0, Math.min(0.98 - DEFAULT_RECT.w, DEFAULT_RECT.x - offset)),
      y: Math.max(0, Math.min(0.98 - DEFAULT_RECT.h, DEFAULT_RECT.y + offset)),
      w: DEFAULT_RECT.w,
      h: DEFAULT_RECT.h,
    };
    const region = makeRegion(rect, video.duration || 0);
    setRegions((rs) => [...rs, region]);
    setSelectedId(region.id);
  };

  const removeRegion = (id: string) => {
    setRegions((rs) => {
      const next = rs.filter((r) => r.id !== id);
      if (id === selectedId && next.length > 0) setSelectedId(next[0].id);
      return next;
    });
  };

  const handleLoadedMetadata = () => {
    video.onLoadedMetadata();
    const d = video.videoRef.current?.duration || 0;
    setRegions((rs) => rs.map((r) => (r.end === 0 ? { ...r, end: d } : r)));
  };

  const seekPreview = (t: number) => {
    const el = video.videoRef.current;
    if (el) el.currentTime = t;
  };

  const handleExport = async () => {
    if (!video.file || video.videoWidth === 0 || video.isMetadataLoading || regions.length === 0) return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    const logoRegions: LogoRegion[] = regions.map((r) => ({
      id: r.id,
      rect: r.rect,
      strength: r.strength,
      timeRange: r.timeRangeEnabled ? { start: r.start, end: r.end } : null,
    }));
    const { filterComplex, outputLabel } = buildLogoRemovalFilter(
      logoRegions,
      video.videoWidth,
      video.videoHeight,
    );

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          "-filter_complex",
          filterComplex,
          "-map",
          `[${outputLabel}]`,
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
      `logo-removed-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    const region = makeRegion(DEFAULT_RECT, 0);
    setRegions([region]);
    setSelectedId(region.id);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Draw a box over the logo or watermark to blur it out"
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
          <ToolPanelSection icon={Eraser} label="Regions">
            <p className="text-body-sm text-(--color-text-muted)">
              {video.isMetadataLoading
                ? "Reading your video…"
                : "Drag a box on the preview over each logo or watermark. Smaller, tighter boxes blend in better."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {regions.map((r, i) => (
                <div
                  key={r.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                    r.id === selectedId
                      ? "border-danger-500 bg-danger-500/10 text-danger-600"
                      : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                  }`}
                >
                  <button type="button" onClick={() => setSelectedId(r.id)} className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: REGION_COLORS[i % REGION_COLORS.length] }}
                    />
                    Region {i + 1}
                  </button>
                  {regions.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove region ${i + 1}`}
                      onClick={() => removeRegion(r.id)}
                      className="text-(--color-text-muted) hover:text-danger-600"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addRegion}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--color-border) px-3 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
              >
                <Plus size={12} />
                Add region
              </button>
            </div>
          </ToolPanelSection>

          {selected && (
            <ToolPanelSection icon={Eraser} label={`Region ${selectedIndex + 1} settings`}>
              <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                Blur strength
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={selected.strength}
                  onChange={(e) => updateRegion(selected.id, { strength: Number(e.target.value) })}
                  className="w-40 accent-(--color-primary-500)"
                />
                <span className="w-10 tabular-nums">{selected.strength}%</span>
              </label>
              <p className="mt-1 text-caption text-(--color-text-muted)">
                Higher blends the logo in more but softens that part of the frame further. Edges are
                feathered automatically.
              </p>

              <label className="mt-4 flex items-center gap-2 text-caption text-(--color-text-muted)">
                <input
                  type="checkbox"
                  checked={selected.timeRangeEnabled}
                  onChange={(e) => updateRegion(selected.id, { timeRangeEnabled: e.target.checked })}
                  className="accent-(--color-primary-500)"
                />
                Only during part of the video
              </label>

              {selected.timeRangeEnabled && video.duration > 0 && (
                <div className="mt-1">
                  <TrimSlider
                    duration={video.duration}
                    start={selected.start}
                    end={selected.end}
                    currentTime={0}
                    onChangeStart={(t) => updateRegion(selected.id, { start: t })}
                    onChangeEnd={(t) => updateRegion(selected.id, { end: t })}
                    onSeek={seekPreview}
                  />
                  <div className="flex justify-between text-caption tabular-nums text-(--color-text-muted)">
                    <span>{formatTime(selected.start, true)}</span>
                    <span>{formatTime(selected.end, true)}</span>
                  </div>
                </div>
              )}
            </ToolPanelSection>
          )}

          <ExportStatus
            enginePhase={exportState.enginePhase}
            engineFraction={exportState.engineFraction}
            runFraction={exportState.runFraction}
            error={exportState.error ?? video.metadataError}
            runLabel="Removing logo…"
          />

          <button
            type="button"
            disabled={
              exportState.isProcessing || video.isMetadataLoading || !!video.metadataError || regions.length === 0
            }
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Eraser size={16} />
            {exportState.isProcessing
              ? "Removing…"
              : video.isMetadataLoading
                ? "Reading video…"
                : regions.length > 1
                  ? `Remove ${regions.length} logos`
                  : "Remove logo"}
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
            onLoadedMetadata={handleLoadedMetadata}
            onError={video.onError}
          >
            {(box) => (
              <>
                {regions.map((r, i) =>
                  r.id === selectedId ? (
                    <RectOverlay
                      key={r.id}
                      boxWidth={box.width}
                      boxHeight={box.height}
                      rect={r.rect}
                      onChange={(rect) => updateRegion(r.id, { rect })}
                      color="danger"
                      minFraction={0.03}
                    />
                  ) : (
                    <button
                      key={r.id}
                      type="button"
                      aria-label={`Select region ${i + 1}`}
                      onClick={() => setSelectedId(r.id)}
                      className="absolute border-2 border-dashed opacity-70 hover:opacity-100"
                      style={{
                        left: r.rect.x * box.width,
                        top: r.rect.y * box.height,
                        width: r.rect.w * box.width,
                        height: r.rect.h * box.height,
                        borderColor: REGION_COLORS[i % REGION_COLORS.length],
                      }}
                    />
                  ),
                )}
              </>
            )}
          </FramedVideoStage>
        )
      }
    />
  );
}
