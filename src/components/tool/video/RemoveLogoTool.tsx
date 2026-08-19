import { useRef, useState } from "react";
import {
  Brush,
  CircleCheck,
  CircleX,
  Eraser,
  Hand,
  Layers,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Plus,
  ScanSearch,
  Shield,
  Square,
  Subtitles,
  Trash2,
  X,
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
import BrushOverlay from "./BrushOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { runFfmpeg } from "../../../lib/ffmpeg/engine";
import { readVideoMetadata } from "../../../lib/video-metadata";
import {
  guessVideoExtension,
  stripExtension,
} from "../../../lib/ffmpeg/format";
import {
  buildLogoRemovalFilter,
  type LogoRegion,
  type LogoKeyframe,
  type FractionPoint,
} from "../../../lib/ffmpeg/logo-removal";
import { formatTime } from "../../../lib/time";
import { detectWatermarkRegions } from "../../../lib/ffmpeg/watermark-detect";

interface Region {
  id: string;
  shape: "rect" | "brush";
  /** Used when shape === "rect". */
  rect: FractionRect;
  /** Used when shape === "brush" — the path traced while painting, 0-1 fractions. */
  points: FractionPoint[];
  /** Used when shape === "brush". Fraction of min(videoWidth, videoHeight). */
  brushRadius: number;
  /** rect-only. 2+ entries make the box follow a moving watermark. */
  keyframes: LogoKeyframe[];
  /** 0-100 */
  strength: number;
  timeRangeEnabled: boolean;
  start: number;
  /** 0 until metadata (or a later addRegion call) fills in the real duration. */
  end: number;
}

interface ProtectZone {
  id: string;
  rect: FractionRect;
}

interface BatchFile {
  id: string;
  file: File;
  status: "pending" | "processing" | "done" | "error";
  error?: string;
}

const DEFAULT_RECT: FractionRect = { x: 0.72, y: 0.06, w: 0.22, h: 0.14 };
const SUBTITLE_RECT: FractionRect = { x: 0.1, y: 0.78, w: 0.8, h: 0.16 };
const DEFAULT_BRUSH_RADIUS = 0.05;
const REGION_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];
const TILE_LIMIT = 8;
const KEYFRAME_EPSILON = 0.05;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

let nextRegionId = 1;
function makeRegion(rect: FractionRect, duration: number): Region {
  return {
    id: `region-${nextRegionId++}`,
    shape: "rect",
    rect,
    points: [],
    brushRadius: DEFAULT_BRUSH_RADIUS,
    keyframes: [],
    strength: 60,
    timeRangeEnabled: false,
    start: 0,
    end: duration,
  };
}

function centroid(points: FractionPoint[]): FractionPoint {
  const n = points.length;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    y: points.reduce((s, p) => s + p.y, 0) / n,
  };
}

/** Clones a region's shape into a rows x cols grid across the whole frame — for a watermark repeated all over the screen. */
function tileRegion(
  base: Region,
  rows: number,
  cols: number,
  duration: number,
): Region[] {
  const originCentroid = base.shape === "brush" ? centroid(base.points) : null;
  const tiles: Region[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) / cols;
      const cy = (r + 0.5) / rows;
      const shared = {
        id: `region-${nextRegionId++}`,
        strength: base.strength,
        brushRadius: base.brushRadius,
        timeRangeEnabled: base.timeRangeEnabled,
        start: base.start,
        end: base.end || duration,
      };
      if (base.shape === "brush" && originCentroid) {
        const dx = cx - originCentroid.x;
        const dy = cy - originCentroid.y;
        tiles.push({
          ...shared,
          shape: "brush",
          rect: base.rect,
          points: base.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          keyframes: [],
        });
      } else {
        const rect: FractionRect = {
          x: Math.min(
            Math.max(0, cx - base.rect.w / 2),
            Math.max(0, 1 - base.rect.w),
          ),
          y: Math.min(
            Math.max(0, cy - base.rect.h / 2),
            Math.max(0, 1 - base.rect.h),
          ),
          w: base.rect.w,
          h: base.rect.h,
        };
        const dx = rect.x - base.rect.x;
        const dy = rect.y - base.rect.y;
        tiles.push({
          ...shared,
          shape: "rect",
          rect,
          points: [],
          keyframes: base.keyframes.map((k) => ({
            t: k.t,
            x: k.x + dx,
            y: k.y + dy,
          })),
        });
      }
    }
  }
  return tiles;
}

export default function RemoveLogoTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const [regions, setRegions] = useState<Region[]>(() => [
    makeRegion(DEFAULT_RECT, 0),
  ]);
  const [protectZones, setProtectZones] = useState<ProtectZone[]>([]);
  const [selectedId, setSelectedId] = useState(() => regions[0].id);
  const [tileRows, setTileRows] = useState(3);
  const [tileCols, setTileCols] = useState(3);
  const [previewTime, setPreviewTime] = useState(0);
  const [brushMode, setBrushMode] = useState<"paint" | "erase">("paint");
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const panDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
  } | null>(null);
  const [detecting, setDetecting] = useState<{
    thorough: boolean;
    progress: number;
  } | null>(null);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

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

  const addProtectZone = () => {
    const zone: ProtectZone = {
      id: `protect-${nextRegionId++}`,
      rect: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 },
    };
    setProtectZones((zs) => [...zs, zone]);
    setSelectedId(zone.id);
  };

  const updateProtectZone = (id: string, rect: FractionRect) => {
    setProtectZones((zs) => zs.map((z) => (z.id === id ? { ...z, rect } : z)));
  };

  const removeProtectZone = (id: string) => {
    setProtectZones((zs) => {
      const next = zs.filter((z) => z.id !== id);
      if (id === selectedId) setSelectedId(regions[0]?.id ?? next[0]?.id ?? "");
      return next;
    });
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

  const runAutoDetect = async (thorough: boolean) => {
    const el = video.videoRef.current;
    if (!el || video.videoWidth === 0 || detecting) return;
    setDetectMessage(null);
    setDetecting({ thorough, progress: 0 });
    try {
      const result = await detectWatermarkRegions(el, {
        thorough,
        onProgress: (progress) => setDetecting({ thorough, progress }),
      });
      if (result.regions.length === 0) {
        setDetectMessage(
          "Couldn't find a logo-shaped static area — try drawing a region manually.",
        );
        return;
      }
      const duration = video.duration || 0;
      const newRegions = result.regions.map((rect) =>
        makeRegion(rect, duration),
      );
      if (result.tileHint) {
        const tiles = tileRegion(
          newRegions[0],
          result.tileHint.rows,
          result.tileHint.cols,
          duration,
        );
        setRegions((rs) => [...rs, ...tiles]);
        setSelectedId(tiles[0].id);
        setTileRows(result.tileHint.rows);
        setTileCols(result.tileHint.cols);
      } else {
        setRegions((rs) => [...rs, ...newRegions]);
        setSelectedId(newRegions[0].id);
      }
    } finally {
      setDetecting(null);
    }
  };

  const addSubtitleBoxRegion = () => {
    const region = makeRegion(SUBTITLE_RECT, video.duration || 0);
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

  const applyTilePattern = () => {
    if (!selected) return;
    if (selected.shape === "brush" && selected.points.length === 0) return;
    const rows = Math.max(1, Math.min(TILE_LIMIT, tileRows));
    const cols = Math.max(1, Math.min(TILE_LIMIT, tileCols));
    const tiles = tileRegion(selected, rows, cols, video.duration || 0);
    if (tiles.length === 0) return;
    setRegions((rs) => {
      const idx = rs.findIndex((r) => r.id === selected.id);
      if (idx === -1) return rs;
      const next = [...rs];
      next.splice(idx, 1, ...tiles);
      return next;
    });
    setSelectedId(tiles[0].id);
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

  // Shared by the primary export and each batch file: the region/protect-zone
  // config lives in fraction space, so the same filter-building logic just
  // needs that file's own pixel dimensions to build a correct delogo graph.
  const buildRemovalArgs = (
    inputName: string,
    outputName: string,
    width: number,
    height: number,
  ) => {
    const logoRegions: LogoRegion[] = regions.map((r) => ({
      id: r.id,
      shape: r.shape,
      rect: r.rect,
      points: r.points,
      brushRadius: r.brushRadius,
      keyframes: r.keyframes,
      strength: r.strength,
      timeRange: r.timeRangeEnabled ? { start: r.start, end: r.end } : null,
    }));
    const { filterComplex, outputLabel } = buildLogoRemovalFilter(
      logoRegions,
      protectZones.map((z) => z.rect),
      width,
      height,
    );

    // A brush region with no painted points (or all regions like it) yields
    // no delogo patches at all — filterComplex is then empty and outputLabel
    // is the raw "0:v" stream, which needs an unbracketed -map (bracket
    // syntax is only valid for a filtergraph pad, not a demuxer stream ref).
    const videoMapArgs = filterComplex
      ? ["-filter_complex", filterComplex, "-map", `[${outputLabel}]`]
      : ["-map", outputLabel];

    return [
      "-i",
      inputName,
      ...videoMapArgs,
      "-map",
      "0:a?",
      // This build's multithreaded filter execution has a severe
      // contention bug with certain per-pixel filters (confirmed on
      // colorkey/chromakey — under the default thread pool they never
      // complete in any reasonable time, but run fine single-threaded).
      // delogo hits the same class of filter, so pin it too.
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
    ];
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

    await exportState.run(
      {
        inputs: [{ name: inputName, data: video.file }],
        args: buildRemovalArgs(
          inputName,
          outputName,
          video.videoWidth,
          video.videoHeight,
        ),
        outputName,
        outputMimeType: "video/mp4",
      },
      `logo-removed-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const addBatchFiles = (files: File[]) => {
    const entries: BatchFile[] = files.map((file) => ({
      id: `batch-${nextRegionId++}`,
      file,
      status: "pending",
    }));
    setBatchFiles((bs) => [...bs, ...entries]);
  };

  const removeBatchFile = (id: string) => {
    setBatchFiles((bs) => bs.filter((b) => b.id !== id));
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const runBatch = async () => {
    if (batchFiles.length === 0 || batchRunning || regions.length === 0) return;
    setBatchRunning(true);
    for (const bf of batchFiles) {
      if (bf.status === "done") continue;
      setBatchFiles((bs) =>
        bs.map((b) =>
          b.id === bf.id ? { ...b, status: "processing", error: undefined } : b,
        ),
      );
      try {
        const { width, height } = await readVideoMetadata(bf.file);
        if (width === 0 || height === 0)
          throw new Error("Couldn't read this video's dimensions.");
        const ext = guessVideoExtension(bf.file);
        const inputName = `batch-input.${ext}`;
        const outputName = "batch-output.mp4";
        const { blob } = await runFfmpeg({
          inputs: [{ name: inputName, data: bf.file }],
          args: buildRemovalArgs(inputName, outputName, width, height),
          outputName,
          outputMimeType: "video/mp4",
        });
        downloadBlob(blob, `logo-removed-${stripExtension(bf.file.name)}.mp4`);
        setBatchFiles((bs) =>
          bs.map((b) => (b.id === bf.id ? { ...b, status: "done" } : b)),
        );
      } catch {
        setBatchFiles((bs) =>
          bs.map((b) =>
            b.id === bf.id
              ? { ...b, status: "error", error: "Couldn't process this file." }
              : b,
          ),
        );
      }
    }
    setBatchRunning(false);
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    const region = makeRegion(DEFAULT_RECT, 0);
    setRegions([region]);
    setProtectZones([]);
    setSelectedId(region.id);
    setBrushMode("paint");
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setPanMode(false);
    setDetecting(null);
    setDetectMessage(null);
    setBatchFiles([]);
    setBatchRunning(false);
  };

  if (!video.hasFile) {
    return (
      <ToolUploadScreen
        icon={Eraser}
        title="Remove Logo from Video"
        description="Blur out a watermark or logo in a region you choose."
      >
        <Dropzone
          accept="video/*"
          label="Drop a video here, or click to browse"
          hint="Draw a box, paint over a watermark with a brush, or tile a repeating pattern to erase it"
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
          <ToolPanelSection icon={Eraser} label="Regions">
            <p className="text-body-sm text-(--color-text-muted)">
              {video.isMetadataLoading
                ? "Reading your video…"
                : "Drag a box over each logo or watermark, or switch a region to brush and paint over it. Use tile pattern for a watermark repeated across the frame."}
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
              <button
                type="button"
                onClick={addSubtitleBoxRegion}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--color-border) px-3 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
              >
                <Subtitles size={12} />
                Subtitle box
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--color-border) pt-3">
              <button
                type="button"
                disabled={
                  !!detecting ||
                  video.isMetadataLoading ||
                  video.videoWidth === 0
                }
                onClick={() => runAutoDetect(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ScanSearch size={12} />
                Auto-detect
              </button>
              <button
                type="button"
                disabled={
                  !!detecting ||
                  video.isMetadataLoading ||
                  video.videoWidth === 0
                }
                onClick={() => runAutoDetect(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 text-caption font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ScanSearch size={12} />
                Auto-detect (thorough)
              </button>
              {detecting && (
                <span className="text-caption text-(--color-text-muted)">
                  Scanning frames… {Math.round(detecting.progress * 100)}%
                </span>
              )}
            </div>
            {detectMessage && (
              <p className="mt-1 text-caption text-(--color-text-muted)">
                {detectMessage}
              </p>
            )}
            <p className="mt-1 text-caption text-(--color-text-muted)">
              Scans your video for a logo-shaped area that doesn't move — not an
              AI model, just a quick scan for static, detailed regions. Adds
              region(s) on top of what you already have.
            </p>
          </ToolPanelSection>

          {selected && (
            <ToolPanelSection
              icon={Eraser}
              label={`Region ${selectedIndex + 1} settings`}
            >
              <div className="flex items-center gap-2">
                <span className="text-caption text-(--color-text-muted)">
                  Shape
                </span>
                <div className="inline-flex overflow-hidden rounded-md border border-(--color-border)">
                  <button
                    type="button"
                    onClick={() => {
                      updateRegion(selected.id, { shape: "rect" });
                      setBrushMode("paint");
                    }}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-caption font-medium transition-colors ${
                      selected.shape === "rect"
                        ? "bg-danger-500/10 text-danger-600"
                        : "text-(--color-text-muted) hover:text-(--color-text)"
                    }`}
                  >
                    <Square size={12} />
                    Rectangle
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      updateRegion(selected.id, { shape: "brush" });
                      setBrushMode("paint");
                    }}
                    className={`inline-flex items-center gap-1.5 border-l border-(--color-border) px-2.5 py-1 text-caption font-medium transition-colors ${
                      selected.shape === "brush" && brushMode === "paint"
                        ? "bg-danger-500/10 text-danger-600"
                        : "text-(--color-text-muted) hover:text-(--color-text)"
                    }`}
                  >
                    <Brush size={12} />
                    Brush
                  </button>
                  {selected.shape === "brush" && (
                    <button
                      type="button"
                      onClick={() => setBrushMode("erase")}
                      className={`inline-flex items-center gap-1.5 border-l border-(--color-border) px-2.5 py-1 text-caption font-medium transition-colors ${
                        brushMode === "erase"
                          ? "bg-danger-500/10 text-danger-600"
                          : "text-(--color-text-muted) hover:text-(--color-text)"
                      }`}
                    >
                      <Eraser size={12} />
                      Eraser
                    </button>
                  )}
                </div>
                {selected.shape === "brush" && selected.points.length > 0 && (
                  <button
                    type="button"
                    onClick={() => updateRegion(selected.id, { points: [] })}
                    className="text-caption font-medium text-(--color-text-muted) hover:text-danger-600"
                  >
                    Clear
                  </button>
                )}
              </div>
              {selected.shape === "brush" && (
                <>
                  <p className="mt-1 text-caption text-(--color-text-muted)">
                    {brushMode === "erase"
                      ? "Drag on the preview to remove part of the painted stroke."
                      : "Drag on the preview to paint over the watermark. Keep strokes short for the cleanest result."}
                  </p>
                  <label className="mt-3 flex items-center gap-3 text-caption text-(--color-text-muted)">
                    Brush size
                    <input
                      type="range"
                      min={2}
                      max={15}
                      value={Math.round(selected.brushRadius * 100)}
                      onChange={(e) =>
                        updateRegion(selected.id, {
                          brushRadius: Number(e.target.value) / 100,
                        })
                      }
                      className="w-40 accent-(--color-primary-500)"
                    />
                    <span className="w-10 tabular-nums">
                      {Math.round(selected.brushRadius * 100)}%
                    </span>
                  </label>
                </>
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

              {selected.shape === "rect" && (
                <div className="mt-4">
                  <span className="text-caption text-(--color-text-muted)">
                    Track across time — for a watermark that moves, position the
                    box at a few different times and it'll follow smoothly in
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
              )}

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

          {selected && (
            <ToolPanelSection icon={LayoutGrid} label="Tile pattern">
              <p className="text-body-sm text-(--color-text-muted)">
                For a watermark repeated all over the frame (common in stock
                footage), tile this region's shape into a grid. It replaces
                region {selectedIndex + 1} with one copy per grid cell. Each
                copy is still a fast, small patch, but a big grid means more of
                them chained together, so keep rows × columns modest.
              </p>
              <div className="mt-3 flex items-center gap-3 text-caption text-(--color-text-muted)">
                <label className="flex items-center gap-1.5">
                  Rows
                  <input
                    type="number"
                    min={1}
                    max={TILE_LIMIT}
                    value={tileRows}
                    onChange={(e) => setTileRows(Number(e.target.value))}
                    className="w-14 rounded-md border border-(--color-border) bg-transparent px-2 py-1 text-body-sm text-(--color-text)"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  Columns
                  <input
                    type="number"
                    min={1}
                    max={TILE_LIMIT}
                    value={tileCols}
                    onChange={(e) => setTileCols(Number(e.target.value))}
                    className="w-14 rounded-md border border-(--color-border) bg-transparent px-2 py-1 text-body-sm text-(--color-text)"
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    selected.shape === "brush" && selected.points.length === 0
                  }
                  onClick={applyTilePattern}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-(--color-border) px-3 py-1.5 font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LayoutGrid size={12} />
                  Apply to grid
                </button>
              </div>
              {selected.shape === "brush" && selected.points.length === 0 && (
                <p className="mt-1 text-caption text-(--color-text-muted)">
                  Paint a shape first.
                </p>
              )}
            </ToolPanelSection>
          )}

          <ToolPanelSection icon={Shield} label="Protect zones">
            <p className="text-body-sm text-(--color-text-muted)">
              Mark an area the brush should never touch — even if a stroke
              crosses over it — to keep a face or on-screen text sharp while you
              paint out a watermark nearby.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {protectZones.map((z, i) => (
                <div
                  key={z.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                    z.id === selectedId
                      ? "border-primary-500 bg-primary-500/10 text-primary-600"
                      : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                  }`}
                >
                  <button type="button" onClick={() => setSelectedId(z.id)}>
                    Zone {i + 1}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove protect zone ${i + 1}`}
                    onClick={() => removeProtectZone(z.id)}
                    className="text-(--color-text-muted) hover:text-danger-600"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addProtectZone}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--color-border) px-3 py-1 text-caption font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text)"
              >
                <Plus size={12} />
                Add protect zone
              </button>
            </div>
          </ToolPanelSection>

          <ToolPanelSection icon={Layers} label="Batch">
            <p className="text-body-sm text-(--color-text-muted)">
              Add more videos to apply this exact setup — regions, keyframes,
              strength — to each of them. Each one downloads as soon as it's
              done. Best when the logo sits in the same place across all your
              videos; regions are positioned proportionally, so very different
              aspect ratios may need a re-check.
            </p>
            {batchFiles.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {batchFiles.map((bf) => (
                  <div
                    key={bf.id}
                    className="flex items-center gap-2 rounded-md border border-(--color-border) px-2.5 py-1.5 text-caption"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {bf.file.name}
                    </span>
                    {bf.status === "pending" && (
                      <span className="text-(--color-text-muted)">Queued</span>
                    )}
                    {bf.status === "processing" && (
                      <LoaderCircle
                        size={14}
                        className="shrink-0 animate-spin text-primary-600"
                      />
                    )}
                    {bf.status === "done" && (
                      <CircleCheck
                        size={14}
                        className="shrink-0 text-success-600"
                      />
                    )}
                    {bf.status === "error" && (
                      <span
                        className="shrink-0 text-danger-600"
                        title={bf.error}
                      >
                        <CircleX size={14} />
                      </span>
                    )}
                    {bf.status !== "processing" && (
                      <button
                        type="button"
                        aria-label={`Remove ${bf.file.name} from batch`}
                        onClick={() => removeBatchFile(bf.id)}
                        className="shrink-0 text-(--color-text-muted) hover:text-danger-600"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3">
              <Dropzone
                accept="video/*"
                multiple
                label="Add videos to batch"
                hint="Drop more files, or click to browse"
                onFiles={addBatchFiles}
              />
            </div>
            {batchFiles.length > 0 && (
              <button
                type="button"
                disabled={batchRunning || regions.length === 0}
                onClick={runBatch}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-3 py-2 text-body-sm font-medium text-(--color-text) transition-colors hover:border-(--color-border-strong) disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Layers size={14} />
                {batchRunning
                  ? "Processing batch…"
                  : `Process ${batchFiles.length} batch video${batchFiles.length > 1 ? "s" : ""}`}
              </button>
            )}
          </ToolPanelSection>

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
              exportState.isProcessing ||
              video.isMetadataLoading ||
              !!video.metadataError ||
              regions.length === 0
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
                  {regions.map((r, i) => {
                    if (r.id === selectedId) {
                      return r.shape === "rect" ? (
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
                        <BrushOverlay
                          key={r.id}
                          boxWidth={box.width}
                          boxHeight={box.height}
                          points={r.points}
                          brushRadius={r.brushRadius}
                          onChange={(points) => updateRegion(r.id, { points })}
                          color="danger"
                          mode={brushMode}
                        />
                      );
                    }
                    if (r.shape === "rect") {
                      return (
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
                            borderColor:
                              REGION_COLORS[i % REGION_COLORS.length],
                          }}
                        />
                      );
                    }
                    return (
                      <svg
                        key={r.id}
                        width={box.width}
                        height={box.height}
                        className="pointer-events-none absolute inset-0"
                      >
                        {r.points.length > 1 && (
                          <path
                            d={`M ${r.points.map((p) => `${p.x * box.width},${p.y * box.height}`).join(" L ")}`}
                            fill="none"
                            stroke={REGION_COLORS[i % REGION_COLORS.length]}
                            strokeWidth={
                              r.brushRadius *
                              2 *
                              Math.min(box.width, box.height)
                            }
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={0.35}
                            className="pointer-events-auto cursor-pointer hover:opacity-60"
                            onClick={() => setSelectedId(r.id)}
                          />
                        )}
                      </svg>
                    );
                  })}
                  {protectZones.map((z, i) =>
                    z.id === selectedId ? (
                      <RectOverlay
                        key={z.id}
                        boxWidth={box.width}
                        boxHeight={box.height}
                        rect={z.rect}
                        onChange={(rect) => updateProtectZone(z.id, rect)}
                        color="primary"
                        minFraction={0.03}
                      />
                    ) : (
                      <button
                        key={z.id}
                        type="button"
                        aria-label={`Select protect zone ${i + 1}`}
                        onClick={() => setSelectedId(z.id)}
                        className="absolute border-2 border-dashed border-primary-500 opacity-70 hover:opacity-100"
                        style={{
                          left: z.rect.x * box.width,
                          top: z.rect.y * box.height,
                          width: z.rect.w * box.width,
                          height: z.rect.h * box.height,
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
