import { useRef, useState } from "react";
import {
  Hand,
  Maximize2,
  Plus,
  ScanFace,
  Trash2,
  UserRoundX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import TrimSlider from "../TrimSlider";
import ToolSplitLayout from "../ToolSplitLayout";
import ToolPanelSection from "../ToolPanelSection";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import {
  guessVideoExtension,
  stripExtension,
} from "../../../lib/ffmpeg/format";
import {
  buildLogoRemovalFilter,
  type LogoRegion,
  type LogoKeyframe,
} from "../../../lib/ffmpeg/logo-removal";
import { detectPersonTrack } from "../../../lib/ffmpeg/passerby-track";
import { formatTime } from "../../../lib/time";

interface Region {
  id: string;
  rect: FractionRect;
  /** 2+ entries make the box follow the person as they move. */
  keyframes: LogoKeyframe[];
  /** 0-100 */
  strength: number;
  timeRangeEnabled: boolean;
  start: number;
  /** 0 until metadata (or a later addRegion call) fills in the real duration. */
  end: number;
}

const DEFAULT_RECT: FractionRect = { x: 0.35, y: 0.25, w: 0.3, h: 0.6 };
const REGION_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];
const KEYFRAME_EPSILON = 0.05;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

let nextRegionId = 1;
function makeRegion(rect: FractionRect, duration: number): Region {
  return {
    id: `region-${nextRegionId++}`,
    rect,
    keyframes: [],
    strength: 60,
    timeRangeEnabled: false,
    start: 0,
    end: duration,
  };
}

export default function RemovePasserbyTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [regions, setRegions] = useState<Region[]>(() => [
    makeRegion(DEFAULT_RECT, 0),
  ]);
  const [selectedId, setSelectedId] = useState(() => regions[0].id);
  const [previewTime, setPreviewTime] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const panDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
  } | null>(null);
  const [tracking, setTracking] = useState<{
    regionId: string;
    progress: number;
  } | null>(null);
  const [trackMessage, setTrackMessage] = useState<string | null>(null);

  const selectedIndex = regions.findIndex((r) => r.id === selectedId);
  const selected = selectedIndex >= 0 ? regions[selectedIndex] : undefined;

  const updateRegion = (id: string, patch: Partial<Region>) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addKeyframe = (id: string) => {
    const t = video.videoRef.current?.currentTime ?? 0;
    setRegions((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const existingIdx = r.keyframes.findIndex(
          (k) => Math.abs(k.t - t) < KEYFRAME_EPSILON,
        );
        const kf: LogoKeyframe = { t, x: r.rect.x, y: r.rect.y };
        const next =
          existingIdx >= 0
            ? r.keyframes.map((k, i) => (i === existingIdx ? kf : k))
            : [...r.keyframes, kf];
        return { ...r, keyframes: next };
      }),
    );
  };

  const removeKeyframe = (id: string, t: number) => {
    setRegions((rs) =>
      rs.map((r) =>
        r.id === id
          ? { ...r, keyframes: r.keyframes.filter((k) => k.t !== t) }
          : r,
      ),
    );
  };

  const jumpToKeyframe = (id: string, kf: LogoKeyframe) => {
    const el = video.videoRef.current;
    if (el) el.currentTime = kf.t;
    setPreviewTime(kf.t);
    setRegions((rs) =>
      rs.map((r) =>
        r.id === id ? { ...r, rect: { ...r.rect, x: kf.x, y: kf.y } } : r,
      ),
    );
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

  const runAutoTrack = async (id: string) => {
    const el = video.videoRef.current;
    const region = regions.find((r) => r.id === id);
    if (!el || !region || video.videoWidth === 0 || tracking) return;
    const start = region.timeRangeEnabled ? region.start : 0;
    const end = region.timeRangeEnabled ? region.end : video.duration || 0;
    if (end - start <= 0) return;
    setTrackMessage(null);
    setTracking({ regionId: id, progress: 0 });
    try {
      const result = await detectPersonTrack(el, {
        start,
        end,
        onProgress: (p) => setTracking({ regionId: id, progress: p.fraction }),
      });
      if (!result) {
        setTrackMessage(
          "Couldn't detect a person in that time range — try a different range, or draw the box manually.",
        );
        return;
      }
      updateRegion(id, {
        rect: result.rect,
        keyframes: result.keyframes,
        timeRangeEnabled: true,
        start,
        end,
      });
    } finally {
      setTracking(null);
    }
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

  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP));
  const zoomOut = () =>
    setZoom((z) => {
      const next = Math.max(MIN_ZOOM, z / ZOOM_STEP);
      if (next === MIN_ZOOM) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  const resetZoom = () => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setPanMode(false);
  };

  const handlePanPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    panDrag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: panOffset,
    };
  };
  const handlePanPointerMove = (e: React.PointerEvent) => {
    const drag = panDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPanOffset({
      x: drag.origin.x + (e.clientX - drag.startX),
      y: drag.origin.y + (e.clientY - drag.startY),
    });
  };
  const handlePanPointerUp = () => {
    panDrag.current = null;
  };

  const handleExport = async () => {
    if (
      !video.file ||
      video.videoWidth === 0 ||
      video.isMetadataLoading ||
      regions.length === 0
    )
      return;
    const ext = guessVideoExtension(video.file);
    const inputName = `input.${ext}`;
    const outputName = "output.mp4";

    const logoRegions: LogoRegion[] = regions.map((r) => ({
      id: r.id,
      shape: "rect",
      rect: r.rect,
      points: [],
      brushRadius: 0,
      keyframes: r.keyframes,
      strength: r.strength,
      timeRange: r.timeRangeEnabled ? { start: r.start, end: r.end } : null,
    }));
    const { filterComplex, outputLabel } = buildLogoRemovalFilter(
      logoRegions,
      [],
      video.videoWidth,
      video.videoHeight,
    );

    const videoMapArgs = filterComplex
      ? ["-filter_complex", filterComplex, "-map", `[${outputLabel}]`]
      : ["-map", outputLabel];

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: [
          "-i",
          inputName,
          ...videoMapArgs,
          "-map",
          "0:a?",
          // Same per-pixel-filter contention bug as Remove Logo — pin to
          // single-threaded execution or delogo never completes in this build.
          "-filter_threads",
          "1",
          "-filter_complex_threads",
          "1",
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
      `passerby-removed-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    const region = makeRegion(DEFAULT_RECT, 0);
    setRegions([region]);
    setSelectedId(region.id);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setPanMode(false);
    setTracking(null);
    setTrackMessage(null);
  };

  if (!video.hasFile) {
    return (
      <ToolUploadScreen
        icon={UserRoundX}
        title="Remove a Person from Video"
        description="Erase someone walking through your shot, with an AI-assisted region tracker."
      >
        <Dropzone
          accept="video/*"
          label="Drop a video here, or click to browse"
          hint="Mark the person's path with a box (or let it auto-track them), and export"
          onFiles={video.handleFiles}
        />
      </ToolUploadScreen>
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
          <ToolPanelSection icon={UserRoundX} label="Regions">
            <p className="text-body-sm text-(--color-text-muted)">
              {video.isMetadataLoading
                ? "Reading your video…"
                : "Draw a box around the person, then use Auto-track (or add keyframes by hand) to follow them as they move."}
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
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor:
                          REGION_COLORS[i % REGION_COLORS.length],
                      }}
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
            <ToolPanelSection
              icon={UserRoundX}
              label={`Region ${selectedIndex + 1} settings`}
            >
              <button
                type="button"
                disabled={
                  !!tracking ||
                  video.isMetadataLoading ||
                  video.videoWidth === 0
                }
                onClick={() => runAutoTrack(selected.id)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-3 py-2 text-body-sm font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ScanFace size={14} />
                {tracking && tracking.regionId === selected.id
                  ? `Tracking… ${Math.round(tracking.progress * 100)}%`
                  : "Auto-track person"}
              </button>
              <p className="mt-1 text-caption text-(--color-text-muted)">
                Runs a small on-device model over the time range below (or the
                whole video, if no range is set) to follow the person and place
                keyframes automatically.
              </p>
              {trackMessage && (
                <p className="mt-1 text-caption text-danger-600">
                  {trackMessage}
                </p>
              )}

              <label className="mt-4 flex items-center gap-3 text-caption text-(--color-text-muted)">
                Removal strength
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={selected.strength}
                  onChange={(e) =>
                    updateRegion(selected.id, {
                      strength: Number(e.target.value),
                    })
                  }
                  className="w-40 accent-(--color-primary-500)"
                />
                <span className="w-10 tabular-nums">{selected.strength}%</span>
              </label>
              <p className="mt-1 text-caption text-(--color-text-muted)">
                Higher grows the erased area outward, giving the reconstruction
                more surrounding pixels to blend from — better on busy
                backgrounds, at the cost of erasing a larger area.
              </p>

              <div className="mt-4">
                <span className="text-caption text-(--color-text-muted)">
                  Track across time — position the box at a few different times
                  (or use Auto-track above) and it'll follow smoothly in
                  between.
                </span>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {[...selected.keyframes]
                    .sort((a, b) => a.t - b.t)
                    .map((kf) => (
                      <div
                        key={kf.t}
                        className="inline-flex items-center gap-1.5 rounded-full border border-(--color-border) px-2.5 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong)"
                      >
                        <button
                          type="button"
                          onClick={() => jumpToKeyframe(selected.id, kf)}
                        >
                          {formatTime(kf.t, true)}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove keyframe at ${formatTime(kf.t, true)}`}
                          onClick={() => removeKeyframe(selected.id, kf.t)}
                          className="hover:text-danger-600"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                  <button
                    type="button"
                    onClick={() => addKeyframe(selected.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--color-border) px-2.5 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
                  >
                    <Plus size={12} />
                    Add keyframe at {formatTime(previewTime, true)}
                  </button>
                </div>
                {selected.keyframes.length === 1 && (
                  <p className="mt-1 text-caption text-(--color-text-muted)">
                    Add one more at a different time to start tracking.
                  </p>
                )}
              </div>

              <label className="mt-4 flex items-center gap-2 text-caption text-(--color-text-muted)">
                <input
                  type="checkbox"
                  checked={selected.timeRangeEnabled}
                  onChange={(e) =>
                    updateRegion(selected.id, {
                      timeRangeEnabled: e.target.checked,
                    })
                  }
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
                    onChangeStart={(t) =>
                      updateRegion(selected.id, { start: t })
                    }
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
            runLabel="Removing…"
          />

          <button
            type="button"
            disabled={
              exportState.isProcessing ||
              video.isMetadataLoading ||
              !!video.metadataError ||
              regions.length === 0
            }
            onClick={handleExport}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <UserRoundX size={16} />
            {exportState.isProcessing
              ? "Removing…"
              : video.isMetadataLoading
                ? "Reading video…"
                : regions.length > 1
                  ? `Remove ${regions.length} people`
                  : "Remove person"}
          </button>
        </>
      }
      preview={
        video.sourceUrl && (
          <div>
            <div className="mb-2 flex items-center justify-end gap-1">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={zoomOut}
                className="grid h-7 w-7 place-items-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ZoomOut size={14} />
              </button>
              <span className="w-10 text-center text-caption tabular-nums text-(--color-text-muted)">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={zoomIn}
                className="grid h-7 w-7 place-items-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ZoomIn size={14} />
              </button>
              <button
                type="button"
                aria-label="Pan"
                aria-pressed={panMode}
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setPanMode((p) => !p)}
                className={`grid h-7 w-7 place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  panMode
                    ? "bg-primary-500/10 text-primary-600"
                    : "text-(--color-text-muted) hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
                }`}
              >
                <Hand size={14} />
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                onClick={resetZoom}
                className="grid h-7 w-7 place-items-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) hover:text-(--color-text)"
              >
                <Maximize2 size={14} />
              </button>
            </div>
            <FramedVideoStage
              videoRef={video.videoRef}
              sourceUrl={video.sourceUrl}
              naturalWidth={video.videoWidth}
              naturalHeight={video.videoHeight}
              onLoadedMetadata={handleLoadedMetadata}
              onError={video.onError}
              onTimeUpdate={() =>
                setPreviewTime(video.videoRef.current?.currentTime ?? 0)
              }
              zoom={zoom}
              panOffset={panOffset}
              overlayInteractive={!panMode}
              stageOverlay={
                panMode ? (
                  <div
                    className="pointer-events-auto absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
                    onPointerDown={handlePanPointerDown}
                    onPointerMove={handlePanPointerMove}
                    onPointerUp={handlePanPointerUp}
                    onPointerCancel={handlePanPointerUp}
                  />
                ) : undefined
              }
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
          </div>
        )
      }
    />
  );
}
