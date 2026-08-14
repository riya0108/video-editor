import { useEffect, useRef, useState } from "react";
import {
  Type,
  Music,
  Download,
  Crop as CropIcon,
  Gauge,
  Palette,
  MicOff,
  Wind,
  Eraser,
  ImageIcon,
  Layers,
  Film,
  Captions as CaptionsIcon,
  Sparkles,
  Clapperboard,
  Upload,
  Wrench,
  Wand2,
  Volume2,
  GripHorizontal,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import CaptionsEditor from "./CaptionsEditor";
import EditorTimeline, { type TimelineLane } from "./editor/EditorTimeline";
import EditorRailButton from "./editor/EditorRailButton";
import PanelHeader from "./editor/PanelHeader";
import ChromaKeyPanel from "./editor/ChromaKeyPanel";
import OverlayLayersPanel from "./editor/OverlayLayersPanel";
import PickColorOverlay from "./editor/PickColorOverlay";
import FloatingTextToolbar, { MAX_TEXT_SIZE } from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { useCaptions } from "../../../lib/hooks/useCaptions";
import { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import { useChromaBgPreview } from "../../../lib/hooks/useChromaBgPreview";
import { useVoiceNoiseAudioGraph } from "../../../lib/hooks/useVoiceNoiseAudioGraph";
import { useMusicPreviewSync } from "../../../lib/hooks/useMusicPreviewSync";
import { useClipTimeline } from "../../../lib/hooks/useClipTimeline";
import ExtraClipLayer from "./editor/ExtraClipLayer";
import { stripExtension } from "../../../lib/ffmpeg/format";
import { formatTime, clamp } from "../../../lib/time";
import { sampleVideoColor } from "../../../lib/sample-video-color";
import { buildEditorCommand } from "../../../lib/ffmpeg/build-editor-command";
import { TEXT_FONTS } from "../../../lib/ffmpeg/fonts";
import { TEXT_COLORS } from "../../../lib/ffmpeg/text-colors";
import { anchorExpr } from "../../../lib/ffmpeg/overlay-position";
import { QUALITY_LABELS, resolveQualityTarget } from "../../../lib/ffmpeg/upscale-filter";
import { nearestCutoutFrame } from "../../../lib/captions/person-cutout";
import { POSITION_PRESETS, isAtPositionPreset, type TextPositionPreset } from "../../../lib/ffmpeg/text-position-presets";
import type { OverlayLayer } from "../../../lib/ffmpeg/overlay-layer";
import type {
  EditorChromaKeyState,
  EditorCropState,
  EditorLogoState,
  EditorBgBlurState,
  EditorMusicState,
  EditorExtraClipState,
  EditorTextState,
  EditorFadeState,
  EditorQualityState,
  BgAspect,
  TextAnimation,
  QualityTarget,
} from "../../../lib/ffmpeg/editor-state";

const DEFAULT_CROP_RECT: FractionRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
const DEFAULT_LOGO_RECT: FractionRect = { x: 0.72, y: 0.06, w: 0.22, h: 0.14 };

const DEFAULT_PREVIEW_HEIGHT = 384;
const MIN_PREVIEW_HEIGHT = 220;
const MAX_PREVIEW_HEIGHT = 720;

const BG_ASPECTS: { id: BgAspect; label: string }[] = [
  { id: "9:16", label: "9:16 Reels/Story" },
  { id: "1:1", label: "1:1 Square" },
  { id: "4:5", label: "4:5 Portrait" },
  { id: "16:9", label: "16:9 Landscape" },
];
const QUALITY_TARGETS: QualityTarget[] = ["original", "720p", "1080p", "4k"];

const PREVIEW_ASPECTS: { id: string; label: string; ratio: { w: number; h: number } | null }[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "9:16", label: "9:16", ratio: { w: 9, h: 16 } },
  { id: "16:9", label: "16:9", ratio: { w: 16, h: 9 } },
  { id: "1:1", label: "1:1", ratio: { w: 1, h: 1 } },
  { id: "4:5", label: "4:5", ratio: { w: 4, h: 5 } },
  { id: "3:4", label: "3:4", ratio: { w: 3, h: 4 } },
  { id: "4:3", label: "4:3", ratio: { w: 4, h: 3 } },
];

type RailId =
  | "media"
  | "crop"
  | "speed"
  | "color"
  | "logo"
  | "voice"
  | "noise"
  | "background"
  | "text"
  | "captions"
  | "overlays"
  | "music"
  | "clips"
  | "quality";

export default function VideoEditorTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const captions = useCaptions();
  const personCutout = usePersonCutout();

  // Which rail panel is open — null keeps the preview at full width.
  const [activePanel, setActivePanel] = useState<RailId | null>(null);

  // Remembers the last sub-panel visited within each rail group, so
  // reopening a group (e.g. "Tools") returns to where the user left off
  // instead of always resetting to its first item.
  const lastGroupItem = useRef<Partial<Record<string, RailId>>>({});

  // Trim + playback
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewAspectId, setPreviewAspectId] = useState("original");
  const previewAspect = PREVIEW_ASPECTS.find((a) => a.id === previewAspectId)?.ratio ?? null;

  // Feature panels
  const [crop, setCrop] = useState<EditorCropState>({ enabled: false, rect: DEFAULT_CROP_RECT });
  const [speedFadeOpen, setSpeedFadeOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fade, setFade] = useState<EditorFadeState>({ in: 0, out: 0 });
  const [chromaKey, setChromaKey] = useState<EditorChromaKeyState>({
    enabled: false,
    colorHex: "#00ff00",
    similarity: 0.2,
    blend: 0.1,
    replace: "color",
    replaceColorHex: "#000000",
    replaceImageFile: null,
    replaceVideoFile: null,
  });
  const [pickingColor, setPickingColor] = useState(false);
  const [voiceRemover, setVoiceRemover] = useState(false);
  const [noise, setNoise] = useState({ enabled: false, strength: 12 });
  const [logo, setLogo] = useState<EditorLogoState>({ enabled: false, rect: DEFAULT_LOGO_RECT });
  const [bgBlur, setBgBlur] = useState<EditorBgBlurState>({ enabled: false, aspect: "9:16" });
  const chromaBg = useChromaBgPreview({ chromaKey, bgBlur });
  const [music, setMusic] = useState<EditorMusicState>({ enabled: false, file: null, mode: "mix" });
  const voiceNoiseAudio = useVoiceNoiseAudioGraph({
    videoRef: video.videoRef,
    voiceRemover,
    noiseEnabled: noise.enabled,
    noiseStrength: noise.strength,
  });
  const musicPreview = useMusicPreviewSync({
    videoRef: video.videoRef,
    enabled: music.enabled,
    file: music.file,
    mode: music.mode,
    start,
  });
  const [extraClip, setExtraClip] = useState<EditorExtraClipState>({
    enabled: false,
    file: null,
    kind: "video",
    position: "after",
    imageDuration: 3,
  });
  const extraVideoRef = useRef<HTMLVideoElement>(null);
  const [extraClipUrl, setExtraClipUrl] = useState<string | null>(null);
  const [extraVideoDuration, setExtraVideoDuration] = useState(0);

  useEffect(() => {
    if (!extraClip.file) {
      setExtraClipUrl(null);
      return;
    }
    const url = URL.createObjectURL(extraClip.file);
    setExtraClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [extraClip.file]);

  const extraClipDuration =
    extraClip.kind === "image" ? Math.max(0.5, extraClip.imageDuration) : extraVideoDuration;

  const clipTimeline = useClipTimeline({
    mainVideoRef: video.videoRef,
    extraVideoRef,
    extraClip,
    extraDuration: extraClipDuration,
    start,
    end,
  });

  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const [overlays, setOverlays] = useState<OverlayLayer[]>([]);
  const [text, setText] = useState<EditorTextState>({
    enabled: false,
    content: "Your text here",
    color: "#ffffff",
    fontSize: 56,
    x: 50,
    y: 90,
    fontId: "geist",
    animation: "none",
  });
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [quality, setQuality] = useState<EditorQualityState>({ target: "original", sharpen: true });
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT);
  const previewResize = useRef<{ pointerY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!previewResize.current) return;
      const { pointerY, startHeight } = previewResize.current;
      setPreviewHeight(clamp(startHeight + (e.clientY - pointerY), MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT));
    };
    const handleUp = () => {
      previewResize.current = null;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  const handleLoadedMetadata = () => {
    video.onLoadedMetadata();
    const d = video.videoRef.current?.duration || 0;
    setStart(0);
    setEnd(d);
  };

  const clampToRange = (t: number) => Math.min(end, Math.max(start, t));

  const togglePlay = () => {
    const el = video.videoRef.current;
    if (!el) return;
    if (el.paused) {
      voiceNoiseAudio.resume();
      el.currentTime = clampToRange(el.currentTime);
      el.play();
    } else {
      el.pause();
    }
  };

  const seekTo = (t: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    el.currentTime = clampToRange(t);
    setCurrentTime(el.currentTime);
  };

  const handleTimeUpdate = () => {
    const el = video.videoRef.current;
    if (!el) return;
    setCurrentTime(el.currentTime);
    if (el.currentTime >= end) el.pause();
  };

  const trimmedDuration = Math.max(0, end - start);

  // Live preview: mirrors ffmpeg's setpts/atempo speed change directly via
  // the native playback rate (both are pitch-preserving by default).
  useEffect(() => {
    const el = video.videoRef.current;
    if (!el) return;
    const rate = speedFadeOpen ? speed : 1;
    el.playbackRate = rate;
    el.preservesPitch = true;
  }, [speed, speedFadeOpen, video.sourceUrl, video.videoRef]);

  // Live preview of the fade-in/out filter: ffmpeg applies `fade` *after*
  // `setpts`, i.e. in the sped-up output timeline, so the fade windows here
  // are scaled by `speed` to land at the same wall-clock moments as export.
  // Approximation vs. the real export: this dims the whole frame (including
  // text/captions/overlays), whereas ffmpeg's filter order only dims
  // logo/crop/chromaKey/bgBlur/captions, since text/overlays are drawn in
  // afterward.
  let fadeOverlayOpacity = 0;
  if (speedFadeOpen && (fade.in > 0 || fade.out > 0)) {
    const rel = currentTime - start;
    const inWin = fade.in * speed;
    const outWin = fade.out * speed;
    if (fade.in > 0 && rel < inWin) {
      fadeOverlayOpacity = 1 - rel / inWin;
    } else if (fade.out > 0 && rel > trimmedDuration - outWin) {
      fadeOverlayOpacity = (rel - (trimmedDuration - outWin)) / outWin;
    }
  }
  fadeOverlayOpacity = Math.min(1, Math.max(0, fadeOverlayOpacity));

  const handlePickColor = (fx: number, fy: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    setChromaKey((s) => ({ ...s, colorHex: sampleVideoColor(el, fx, fy) }));
    setPickingColor(false);
  };

  const handleExport = async () => {
    if (!video.file || trimmedDuration <= 0) return;

    const { inputs, args, outputName } = await buildEditorCommand({
      videoFile: video.file,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      trimStart: start,
      trimEnd: end,
      crop,
      logo,
      chromaKey,
      bgBlur,
      speed: speedFadeOpen ? speed : 1,
      fade: speedFadeOpen ? fade : { in: 0, out: 0 },
      voiceRemover,
      noise,
      music,
      overlays,
      extraClip,
      text,
      captions: { enabled: captionsEnabled, cues: captions.cues, style: captions.style },
      personCutoutFrames: personCutout.frames,
      quality,
    });

    await exportState.run(
      { inputs, args, outputName, outputMimeType: "video/mp4" },
      `edited-${stripExtension(video.file.name)}.mp4`,
    );
  };

  const reset = () => {
    exportState.reset();
    video.reset();
    setActivePanel(null);
    setPreviewAspectId("original");
    setCrop({ enabled: false, rect: DEFAULT_CROP_RECT });
    setSpeedFadeOpen(false);
    setSpeed(1);
    setFade({ in: 0, out: 0 });
    setChromaKey((s) => ({ ...s, enabled: false }));
    setVoiceRemover(false);
    setNoise({ enabled: false, strength: 12 });
    setLogo({ enabled: false, rect: DEFAULT_LOGO_RECT });
    setBgBlur({ enabled: false, aspect: "9:16" });
    setMusic({ enabled: false, file: null, mode: "mix" });
    setExtraClip({ enabled: false, file: null, kind: "video", position: "after", imageDuration: 3 });
    setOverlaysOpen(false);
    setOverlays([]);
    setText({
      enabled: false,
      content: "Your text here",
      color: "#ffffff",
      fontSize: 56,
      x: 50,
      y: 90,
      fontId: "geist",
      animation: "none",
    });
    captions.reset();
    personCutout.clear();
    setCaptionsEnabled(true);
    setQuality({ target: "original", sharpen: true });
    setPreviewHeight(DEFAULT_PREVIEW_HEIGHT);
  };

  if (!video.hasFile) {
    return (
      <Dropzone
        accept="video/*"
        label="Drop a video here, or click to browse"
        hint="Trim, crop, key out a color, add subtitles, layer in text and overlays — then export in one pass"
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

  const activeCaptionCue = captionsEnabled
    ? captions.cues.find((c) => currentTime >= c.start && currentTime < c.end)
    : undefined;
  const cutoutFrame =
    captionsEnabled && captions.style.occludeByPerson
      ? nearestCutoutFrame(personCutout.frames, currentTime)
      : null;

  // Feature lanes are authored in main-clip-relative time; when an intro/outro
  // clip extends the timeline, shift their displayed positions by the same
  // introOffset the ruler uses, and un-shift drag results back before
  // feeding them to state that's still main-relative.
  const laneOffset = clipTimeline.active ? clipTimeline.introOffset : 0;

  const lanes: TimelineLane[] = [];
  if (captionsEnabled && captions.cues.length > 0) {
    lanes.push({
      id: "captions",
      label: "Subtitles",
      colorClass: "bg-primary-500",
      segments: captions.cues.map((c) => ({
        id: c.id,
        start: c.start + laneOffset,
        end: c.end + laneOffset,
        label: c.text,
      })),
      minSegmentLength: 0.2,
      onSegmentChange: (id, patch) =>
        captions.updateCue(id, { start: patch.start - laneOffset, end: patch.end - laneOffset }, start, end),
      onSegmentDelete: (id) => captions.removeCue(id),
    });
  }
  if (text.enabled && text.content.trim()) {
    lanes.push({
      id: "text",
      label: "Text",
      colorClass: "bg-accent-500",
      segments: [{ id: "text", start: start + laneOffset, end: end + laneOffset, label: text.content }],
      onSegmentDelete: () => setText((s) => ({ ...s, enabled: false })),
    });
  }
  if (overlaysOpen && overlays.length > 0) {
    lanes.push({
      id: "overlays",
      label: "Overlays",
      colorClass: "bg-success-500",
      segments: overlays.map((o) => ({
        id: o.id,
        start: start + o.start + laneOffset,
        end: start + o.end + laneOffset,
        label: o.label,
      })),
      minSegmentLength: 0.2,
      onSegmentChange: (id, patch) =>
        setOverlays((os) =>
          os.map((o) =>
            o.id === id
              ? {
                  ...o,
                  start: clampToRange(patch.start - laneOffset) - start,
                  end: clampToRange(patch.end - laneOffset) - start,
                }
              : o,
          ),
        ),
      onSegmentDelete: (id) => setOverlays((os) => os.filter((o) => o.id !== id)),
    });
  }
  if (music.enabled && music.file) {
    lanes.push({
      id: "music",
      label: "Music",
      colorClass: "bg-warning-500",
      segments: [{ id: "music", start: start + laneOffset, end: end + laneOffset, label: music.file.name }],
      onSegmentDelete: () => setMusic((s) => ({ ...s, enabled: false })),
    });
  }

  type RailItem = { id: RailId; icon: typeof CropIcon; label: string; enabled: boolean };
  type RailGroup = { id: string; icon: typeof CropIcon; label: string; items: RailItem[] };

  // Related single-feature panels are grouped under one rail button so the
  // whole rail fits on screen without scrolling — opening a group shows a
  // sub-tab strip at the top of its flyout to switch between its items.
  const GROUPS: RailGroup[] = [
    { id: "media", icon: Clapperboard, label: "Media", items: [{ id: "media", icon: Clapperboard, label: "Media", enabled: false }] },
    {
      id: "tools",
      icon: Wrench,
      label: "Tools",
      items: [
        { id: "crop", icon: CropIcon, label: "Crop", enabled: crop.enabled },
        { id: "speed", icon: Gauge, label: "Speed", enabled: speedFadeOpen },
        { id: "logo", icon: Eraser, label: "Logo", enabled: logo.enabled },
        { id: "quality", icon: Sparkles, label: "Upscale", enabled: quality.target !== "original" },
      ],
    },
    {
      id: "effects",
      icon: Wand2,
      label: "Effects",
      items: [
        { id: "color", icon: Palette, label: "Color key", enabled: chromaKey.enabled },
        { id: "background", icon: ImageIcon, label: "Background", enabled: bgBlur.enabled },
      ],
    },
    {
      id: "audio",
      icon: Volume2,
      label: "Audio",
      items: [
        { id: "voice", icon: MicOff, label: "Voice", enabled: voiceRemover },
        { id: "noise", icon: Wind, label: "Noise", enabled: noise.enabled },
        { id: "music", icon: Music, label: "Music", enabled: music.enabled },
      ],
    },
    { id: "text", icon: Type, label: "Text", items: [{ id: "text", icon: Type, label: "Text", enabled: text.enabled }] },
    {
      id: "captions",
      icon: CaptionsIcon,
      label: "Subtitles",
      items: [
        {
          id: "captions",
          icon: CaptionsIcon,
          label: "Subtitles",
          enabled: captionsEnabled && captions.cues.length > 0,
        },
      ],
    },
    {
      id: "layers",
      icon: Layers,
      label: "Layers",
      items: [
        { id: "overlays", icon: Layers, label: "Overlays", enabled: overlaysOpen },
        { id: "clips", icon: Film, label: "Clips", enabled: extraClip.enabled },
      ],
    },
  ];

  const activeGroup = GROUPS.find((g) => g.items.some((i) => i.id === activePanel)) ?? null;

  const handleGroupClick = (group: RailGroup) => {
    const isOpen = group.items.some((i) => i.id === activePanel);
    if (isOpen) {
      setActivePanel(null);
      return;
    }
    const remembered = lastGroupItem.current[group.id];
    const target = group.items.find((i) => i.id === remembered) ?? group.items[0];
    lastGroupItem.current[group.id] = target.id;
    setActivePanel(target.id);
  };

  const selectGroupItem = (group: RailGroup, id: RailId) => {
    lastGroupItem.current[group.id] = id;
    setActivePanel(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:flex-row md:items-stretch">
      {/* ---- Icon rail ---- */}
      <nav
        aria-label="Editor tools"
        className="flex shrink-0 gap-1 overflow-x-auto rounded-xl border border-(--color-border) bg-(--color-surface) p-2 shadow-sm md:h-full md:w-20 md:flex-col md:overflow-y-auto"
      >
        {GROUPS.map((group) => (
          <EditorRailButton
            key={group.id}
            icon={group.icon}
            label={group.label}
            active={group.items.some((i) => i.id === activePanel)}
            enabled={group.items.some((i) => i.enabled)}
            onClick={() => handleGroupClick(group)}
          />
        ))}
      </nav>

      {/* ---- Flyout panel ---- */}
      {activePanel && (
        <div className="w-full shrink-0 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 shadow-sm md:h-full md:w-[360px] md:overflow-y-auto">
          {activeGroup && activeGroup.items.length > 1 && (
            <div className="mb-4 flex gap-1 rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-1">
              {activeGroup.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectGroupItem(activeGroup, item.id)}
                  aria-pressed={activePanel === item.id}
                  className={`relative flex flex-1 flex-col items-center gap-1 rounded-md px-1 py-2 text-center transition-colors ${
                    activePanel === item.id
                      ? "bg-primary-500 text-white shadow-sm"
                      : "text-(--color-text-muted) hover:bg-(--color-surface) hover:text-(--color-text)"
                  }`}
                >
                  <item.icon size={15} />
                  <span className="text-[10px] leading-tight font-medium">{item.label}</span>
                  {item.enabled && activePanel !== item.id && (
                    <span
                      className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary-500"
                      aria-hidden="true"
                    />
                  )}
                </button>
              ))}
            </div>
          )}

          {activePanel === "media" && (
            <>
              <PanelHeader label="Media" description="Your source file for this edit." />
              <div className="space-y-3 text-body-sm">
                <div className="rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-3">
                  <p className="truncate font-medium">{video.file?.name}</p>
                  <p className="mt-1 text-caption text-(--color-text-muted)">
                    {video.videoWidth}×{video.videoHeight} · {formatTime(video.duration)}
                  </p>
                </div>
                <label className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)">
                  <Upload size={15} />
                  Replace video
                  <input
                    type="file"
                    accept="video/*"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) video.handleFiles([file]);
                    }}
                  />
                </label>
              </div>
            </>
          )}

          {activePanel === "crop" && (
            <>
              <PanelHeader
                label="Crop"
                enabled={crop.enabled}
                onToggle={(enabled) => setCrop((s) => ({ ...s, enabled }))}
              />
              <p className="text-caption text-(--color-text-muted)">
                Drag the box over the preview to choose what stays in frame.
              </p>
            </>
          )}

          {activePanel === "speed" && (
            <>
              <PanelHeader
                label="Speed & fade"
                enabled={speedFadeOpen}
                onToggle={(enabled) => {
                  setSpeedFadeOpen(enabled);
                  if (!enabled) {
                    setSpeed(1);
                    setFade({ in: 0, out: 0 });
                  }
                }}
              />
              <div className={`space-y-3 ${speedFadeOpen ? "" : "pointer-events-none opacity-40"}`}>
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Speed
                  <input
                    type="range"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={speed}
                    disabled={!speedFadeOpen}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-12 text-right tabular-nums">{speed.toFixed(2)}x</span>
                </label>
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Fade in
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.1}
                    value={fade.in}
                    disabled={!speedFadeOpen}
                    onChange={(e) => setFade((s) => ({ ...s, in: Number(e.target.value) }))}
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-12 text-right tabular-nums">{fade.in.toFixed(1)}s</span>
                </label>
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Fade out
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.1}
                    value={fade.out}
                    disabled={!speedFadeOpen}
                    onChange={(e) => setFade((s) => ({ ...s, out: Number(e.target.value) }))}
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-12 text-right tabular-nums">{fade.out.toFixed(1)}s</span>
                </label>
              </div>
            </>
          )}

          {activePanel === "color" && (
            <>
              <PanelHeader
                label="Remove a color / green screen"
                enabled={chromaKey.enabled}
                onToggle={(enabled) => setChromaKey((s) => ({ ...s, enabled }))}
              />
              <ChromaKeyPanel
                state={chromaKey}
                onChange={(patch) => setChromaKey((s) => ({ ...s, ...patch }))}
                picking={pickingColor}
                onTogglePicking={() => setPickingColor((p) => !p)}
              />
            </>
          )}

          {activePanel === "logo" && (
            <>
              <PanelHeader
                label="Remove logo"
                enabled={logo.enabled}
                onToggle={(enabled) => setLogo((s) => ({ ...s, enabled }))}
              />
              <p className="text-caption text-(--color-text-muted)">
                Drag the red box over the logo or watermark in the preview.
              </p>
            </>
          )}

          {activePanel === "voice" && (
            <>
              <PanelHeader label="Remove voice" enabled={voiceRemover} onToggle={setVoiceRemover} />
              <p className="text-caption text-(--color-text-muted)">
                Best-effort: cancels audio that's identical in both stereo channels (usually lead vocals). Works
                better on some mixes than others, and has no effect on mono audio.
              </p>
            </>
          )}

          {activePanel === "noise" && (
            <>
              <PanelHeader
                label="Reduce background noise"
                enabled={noise.enabled}
                onToggle={(enabled) => setNoise((s) => ({ ...s, enabled }))}
              />
              <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                Strength
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={noise.strength}
                  onChange={(e) => setNoise((s) => ({ ...s, strength: Number(e.target.value) }))}
                  className="flex-1 accent-(--color-primary-500)"
                />
                <span className="w-10 text-right tabular-nums">{noise.strength}</span>
              </label>
            </>
          )}

          {activePanel === "background" && (
            <>
              <PanelHeader
                label="Blurred background padding"
                enabled={bgBlur.enabled}
                onToggle={(enabled) => setBgBlur((s) => ({ ...s, enabled }))}
              />
              <div className="flex flex-wrap gap-2">
                {BG_ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setBgBlur((s) => ({ ...s, aspect: a.id }))}
                    className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${bgBlur.aspect === a.id ? "border-primary-500 bg-primary-500 text-white" : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-caption text-(--color-text-muted)">
                Fits your video onto that canvas with a blurred, zoomed copy of itself filling the empty space — no
                black bars.
              </p>
            </>
          )}

          {activePanel === "text" && (
            <>
              <PanelHeader
                label="Add text"
                enabled={text.enabled}
                onToggle={(enabled) => setText((s) => ({ ...s, enabled }))}
              />
              <div className="space-y-3">
                <textarea
                  value={text.content}
                  onChange={(e) => setText((s) => ({ ...s, content: e.target.value }))}
                  rows={2}
                  placeholder="Type your text…"
                  className="w-full resize-none rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
                />
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    {TEXT_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Text color ${c}`}
                        onClick={() => setText((s) => ({ ...s, color: c }))}
                        className={`h-6 w-6 rounded-full border-2 ${text.color === c ? "border-primary-500" : "border-(--color-border)"}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                    {(["top", "center", "bottom"] as TextPositionPreset[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setText((s) => ({ ...s, ...POSITION_PRESETS[p] }))}
                        className={`rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${isAtPositionPreset(text.x, text.y, p) ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-caption text-(--color-text-muted)">
                    Size
                    <input
                      type="range"
                      min={16}
                      max={MAX_TEXT_SIZE}
                      value={text.fontSize}
                      onChange={(e) => setText((s) => ({ ...s, fontSize: Number(e.target.value) }))}
                      className="w-full min-w-0 flex-1 accent-(--color-primary-500)"
                    />
                    <span className="w-9 shrink-0 text-right tabular-nums">{text.fontSize}</span>
                  </label>
                </div>
                <p className="text-caption text-(--color-text-muted)">Drag the text in the preview to place it anywhere.</p>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                    Font
                    <select
                      value={text.fontId}
                      onChange={(e) => setText((s) => ({ ...s, fontId: e.target.value }))}
                      className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                    >
                      {TEXT_FONTS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                    {(
                      [
                        { id: "none", label: "None" },
                        { id: "fade", label: "Fade" },
                        { id: "slide-up", label: "Slide up" },
                        { id: "slide-down", label: "Slide down" },
                      ] as { id: TextAnimation; label: string }[]
                    ).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setText((s) => ({ ...s, animation: a.id }))}
                        className={`rounded px-3 py-1 text-caption font-medium transition-colors ${text.animation === a.id ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          {activePanel === "captions" && (
            <>
              <PanelHeader
                label="Subtitles"
                description="Auto-generate, type, or upload captions — with content-aware styling."
                enabled={captionsEnabled}
                onToggle={setCaptionsEnabled}
              />
              <div className="space-y-4">
                <CaptionsEditor
                  video={video}
                  captions={captions}
                  personCutout={personCutout}
                  rangeStart={start}
                  rangeEnd={end}
                />
              </div>
            </>
          )}

          {activePanel === "overlays" && (
            <>
              <PanelHeader
                label="Overlays: pictures, video, stickers"
                enabled={overlaysOpen}
                onToggle={(enabled) => {
                  setOverlaysOpen(enabled);
                  if (!enabled) setOverlays([]);
                }}
              />
              <OverlayLayersPanel
                layers={overlays}
                onAdd={(layer) => setOverlays((o) => [...o, layer])}
                onUpdate={(id, patch) => setOverlays((o) => o.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
                onRemove={(id) => setOverlays((o) => o.filter((l) => l.id !== id))}
                duration={trimmedDuration}
              />
            </>
          )}

          {activePanel === "music" && (
            <>
              <PanelHeader
                label="Add music"
                enabled={music.enabled}
                onToggle={(enabled) => setMusic((s) => ({ ...s, enabled }))}
              />
              {!music.file ? (
                <Dropzone
                  accept="audio/*"
                  label="Drop a music file here"
                  hint="MP3, WAV, M4A, and more"
                  onFiles={(files) => setMusic((s) => ({ ...s, file: files[0] ?? null }))}
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-body-sm text-(--color-text-muted)">{music.file.name}</p>
                  <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                    <button
                      type="button"
                      onClick={() => setMusic((s) => ({ ...s, mode: "mix" }))}
                      className={`rounded px-3 py-1 text-caption font-medium transition-colors ${music.mode === "mix" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                    >
                      Mix with original
                    </button>
                    <button
                      type="button"
                      onClick={() => setMusic((s) => ({ ...s, mode: "replace" }))}
                      className={`rounded px-3 py-1 text-caption font-medium transition-colors ${music.mode === "replace" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                    >
                      Replace original
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {activePanel === "clips" && (
            <>
              <PanelHeader
                label="Add intro/outro clip"
                enabled={extraClip.enabled}
                onToggle={(enabled) => setExtraClip((s) => ({ ...s, enabled }))}
              />
              {!extraClip.file ? (
                <Dropzone
                  accept="video/*,image/*"
                  label="Drop an image or video here"
                  hint="Extends the total length of your export"
                  onFiles={(files) => {
                    const file = files[0];
                    if (!file) return;
                    setExtraClip((s) => ({ ...s, file, kind: file.type.startsWith("image/") ? "image" : "video" }));
                  }}
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-body-sm text-(--color-text-muted)">{extraClip.file.name}</p>
                  <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                    <button
                      type="button"
                      onClick={() => setExtraClip((s) => ({ ...s, position: "before" }))}
                      className={`rounded px-3 py-1 text-caption font-medium transition-colors ${extraClip.position === "before" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                    >
                      Play before (intro)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtraClip((s) => ({ ...s, position: "after" }))}
                      className={`rounded px-3 py-1 text-caption font-medium transition-colors ${extraClip.position === "after" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                    >
                      Play after (outro)
                    </button>
                  </div>
                  {extraClip.kind === "image" && (
                    <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                      Show for
                      <input
                        type="range"
                        min={1}
                        max={10}
                        step={0.5}
                        value={extraClip.imageDuration}
                        onChange={(e) => setExtraClip((s) => ({ ...s, imageDuration: Number(e.target.value) }))}
                        className="flex-1 accent-(--color-primary-500)"
                      />
                      <span className="w-12 text-right tabular-nums">{extraClip.imageDuration}s</span>
                    </label>
                  )}
                </div>
              )}
            </>
          )}

          {activePanel === "quality" && (
            <>
              <PanelHeader
                label="Upscale & export quality"
                description="Fast, filter-based upscaling — sharpened lanczos scaling, not AI super-resolution."
              />
              <div className="space-y-2">
                {QUALITY_TARGETS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setQuality((s) => ({ ...s, target: t }))}
                    className={`block w-full rounded-lg border px-4 py-2.5 text-left text-body-sm font-medium transition-colors ${
                      quality.target === t
                        ? "border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-950/40 dark:text-primary-300"
                        : "border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    {QUALITY_LABELS[t]}
                  </button>
                ))}
              </div>
              <label className="mt-4 flex items-center gap-2 text-caption text-(--color-text-muted)">
                <input
                  type="checkbox"
                  checked={quality.sharpen}
                  onChange={(e) => setQuality((s) => ({ ...s, sharpen: e.target.checked }))}
                  className="accent-(--color-primary-500)"
                />
                Sharpen (recommended when upscaling)
              </label>
              <p className="mt-3 text-caption text-(--color-text-muted)">
                Applies at export only — on-screen playback here is already scaled to fit your browser window
                regardless of source resolution, so a live preview wouldn't show a meaningful difference.
              </p>
              {quality.target !== "original" &&
                !resolveQualityTarget(quality.target, video.videoWidth, video.videoHeight) && (
                  <p className="mt-3 text-caption text-(--color-text-muted)">
                    Your source is already at or above {QUALITY_LABELS[quality.target]} — export will keep the
                    original resolution.
                  </p>
                )}
            </>
          )}
        </div>
      )}

      {/* ---- Preview + timeline ---- */}
      <div className="min-w-0 flex-1 space-y-3 md:h-full md:overflow-y-auto md:overflow-x-hidden md:pr-1">
        <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium text-(--color-text-muted)">Preview shape</span>
            <div className={`flex flex-wrap gap-1 ${bgBlur.enabled ? "pointer-events-none opacity-40" : ""}`}>
              {PREVIEW_ASPECTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={bgBlur.enabled}
                  onClick={() => setPreviewAspectId(a.id)}
                  aria-pressed={previewAspectId === a.id}
                  className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                    previewAspectId === a.id
                      ? "border-primary-500 bg-primary-500 text-white"
                      : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            {bgBlur.enabled && (
              <span className="text-caption text-(--color-text-muted)">Set by Blurred background padding</span>
            )}
          </div>
          {video.sourceUrl && (
            <FramedVideoStage
              videoRef={video.videoRef}
              sourceUrl={video.sourceUrl}
              naturalWidth={video.videoWidth}
              naturalHeight={video.videoHeight}
              aspect={bgBlur.enabled ? chromaBg.effectiveAspect : previewAspect}
              maxHeight={previewHeight}
              canvasMode={chromaBg.canvasMode && (!clipTimeline.active || clipTimeline.activeSegmentKind === "main")}
              onDrawFrame={chromaBg.onDrawFrame}
              onLoadedMetadata={handleLoadedMetadata}
              onError={video.onError}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              stageOverlay={
                <ExtraClipLayer
                  extraClip={extraClip}
                  extraVideoRef={extraVideoRef}
                  sourceUrl={extraClipUrl}
                  visible={clipTimeline.active && clipTimeline.activeSegmentKind === "extra"}
                  onVideoLoadedMetadata={() => setExtraVideoDuration(extraVideoRef.current?.duration || 0)}
                />
              }
            >
              {(box) => {
                const scale = video.videoWidth > 0 ? box.width / video.videoWidth : 1;
                return (
                  <>
                    {pickingColor && <PickColorOverlay onPick={handlePickColor} />}

                    {!pickingColor && crop.enabled && (
                      <RectOverlay
                        boxWidth={box.width}
                        boxHeight={box.height}
                        rect={crop.rect}
                        onChange={(rect) => setCrop((s) => ({ ...s, rect }))}
                      />
                    )}
                    {!pickingColor && logo.enabled && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute rounded-sm"
                        style={{
                          left: logo.rect.x * box.width,
                          top: logo.rect.y * box.height,
                          width: logo.rect.w * box.width,
                          height: logo.rect.h * box.height,
                          backdropFilter: "blur(16px)",
                          WebkitBackdropFilter: "blur(16px)",
                        }}
                      />
                    )}
                    {!pickingColor && logo.enabled && (
                      <RectOverlay
                        boxWidth={box.width}
                        boxHeight={box.height}
                        rect={logo.rect}
                        onChange={(rect) => setLogo((s) => ({ ...s, rect }))}
                        color="danger"
                        minFraction={0.03}
                      />
                    )}

                    {!pickingColor &&
                      overlays.map((layer) => {
                        const { justify, align } = anchorExpr(layer.anchor);
                        return (
                          <div
                            key={layer.id}
                            className="pointer-events-none absolute inset-0 flex p-4"
                            style={{
                              justifyContent:
                                justify === "start" ? "flex-start" : justify === "end" ? "flex-end" : "center",
                              alignItems: align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center",
                            }}
                          >
                            {layer.kind === "image" ? (
                              <img
                                src={layer.previewUrl}
                                alt=""
                                style={{ width: box.width * (layer.sizePercent / 100), opacity: layer.opacity }}
                                className="max-w-none"
                              />
                            ) : (
                              <video
                                src={layer.previewUrl}
                                muted
                                style={{ width: box.width * (layer.sizePercent / 100), opacity: layer.opacity }}
                                className="max-w-none"
                              />
                            )}
                          </div>
                        );
                      })}

                    {!pickingColor && text.enabled && (
                      <PositionedTextBlock
                        x={text.x}
                        y={text.y}
                        box={box}
                        draggable={activePanel === "text"}
                        onChange={(patch) => setText((s) => ({ ...s, ...patch }))}
                      >
                        <span
                          className="inline-block max-w-full whitespace-pre-wrap break-words font-semibold"
                          style={{
                            fontSize: text.fontSize * scale,
                            color: text.color,
                            lineHeight: 1.1,
                            padding: `${8 * scale}px ${16 * scale}px`,
                            backgroundColor: "rgba(0,0,0,0.45)",
                            fontFamily: TEXT_FONTS.find((f) => f.id === text.fontId)?.cssFontFamily,
                          }}
                        >
                          {text.content || " "}
                        </span>
                      </PositionedTextBlock>
                    )}
                    {!pickingColor && activePanel === "text" && text.enabled && (
                      <FloatingTextToolbar
                        y={text.y}
                        fontId={text.fontId}
                        fontSize={text.fontSize}
                        color={text.color}
                        onChange={(patch) => setText((s) => ({ ...s, ...patch }))}
                      />
                    )}

                    {!pickingColor && activeCaptionCue && (
                      <PositionedTextBlock
                        x={captions.style.x}
                        y={captions.style.y}
                        box={box}
                        draggable={activePanel === "captions"}
                        onChange={captions.updateStyle}
                      >
                        <span
                          className="inline-block max-w-full whitespace-pre-wrap break-words font-semibold"
                          style={{
                            fontFamily: TEXT_FONTS.find((f) => f.id === captions.style.fontId)?.cssFontFamily,
                            fontSize: captions.style.fontSize * scale,
                            color: captions.style.color,
                            lineHeight: 1.15,
                            padding: captions.style.background ? `${8 * scale}px ${16 * scale}px` : 0,
                            backgroundColor: captions.style.background ? captions.style.backgroundColor : "transparent",
                            WebkitTextStroke: captions.style.outline
                              ? `${Math.max(1, 2 * scale)}px ${captions.style.outlineColor}`
                              : undefined,
                            paintOrder: captions.style.outline ? "stroke fill" : undefined,
                          }}
                        >
                          {captions.style.karaoke && activeCaptionCue.words
                            ? activeCaptionCue.words.map((word, i) => (
                                <span
                                  key={i}
                                  style={{
                                    color:
                                      currentTime >= word.start && currentTime < word.end
                                        ? captions.style.highlightColor
                                        : undefined,
                                  }}
                                >
                                  {word.text}
                                  {i < activeCaptionCue.words!.length - 1 ? " " : ""}
                                </span>
                              ))
                            : activeCaptionCue.text}
                        </span>
                      </PositionedTextBlock>
                    )}
                    {!pickingColor && activePanel === "captions" && activeCaptionCue && (
                      <FloatingTextToolbar
                        y={captions.style.y}
                        fontId={captions.style.fontId}
                        fontSize={captions.style.fontSize}
                        color={captions.style.color}
                        onChange={captions.updateStyle}
                      />
                    )}
                    {!pickingColor && cutoutFrame && (
                      <img
                        src={cutoutFrame.url}
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 h-full w-full"
                        style={{ width: box.width, height: box.height }}
                      />
                    )}
                    {fadeOverlayOpacity > 0 && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-black"
                        style={{ opacity: fadeOverlayOpacity }}
                      />
                    )}
                  </>
                );
              }}
            </FramedVideoStage>
          )}
          <audio ref={musicPreview.audioRef} src={musicPreview.sourceUrl ?? undefined} className="hidden" />
          {video.sourceUrl && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize preview height"
              onPointerDown={(e) => {
                e.preventDefault();
                previewResize.current = { pointerY: e.clientY, startHeight: previewHeight };
              }}
              className="mx-auto -mb-2 mt-1 flex h-3 w-16 cursor-row-resize items-center justify-center rounded-full text-(--color-text-faint) hover:text-(--color-text-muted)"
            >
              <GripHorizontal size={14} />
            </div>
          )}
        </div>

        <EditorTimeline
          duration={clipTimeline.active ? clipTimeline.totalDuration : video.duration}
          start={clipTimeline.active ? clipTimeline.introOffset + start : start}
          end={clipTimeline.active ? clipTimeline.introOffset + end : end}
          currentTime={clipTimeline.active ? clipTimeline.virtualTime : currentTime}
          onChangeStart={(t) => setStart(Math.max(0, t - (clipTimeline.active ? clipTimeline.introOffset : 0)))}
          onChangeEnd={(t) => setEnd(Math.max(0, t - (clipTimeline.active ? clipTimeline.introOffset : 0)))}
          onSeek={clipTimeline.active ? clipTimeline.seekTo : seekTo}
          isPlaying={clipTimeline.active ? clipTimeline.isPlaying : isPlaying}
          onTogglePlay={() => {
            voiceNoiseAudio.resume();
            if (clipTimeline.active) clipTimeline.togglePlay();
            else togglePlay();
          }}
          lanes={lanes}
        />

        <ExportStatus
          enginePhase={exportState.enginePhase}
          engineFraction={exportState.engineFraction}
          runFraction={exportState.runFraction}
          error={exportState.error ?? video.metadataError}
          runLabel="Exporting your edit…"
        />

        <div className="flex justify-end">
          <button
            type="button"
            disabled={
              exportState.isProcessing || trimmedDuration <= 0 || video.isMetadataLoading || !!video.metadataError
            }
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={16} />
            {exportState.isProcessing
              ? "Exporting…"
              : video.isMetadataLoading
                ? "Reading video…"
                : "Export video"}
          </button>
        </div>
      </div>
    </div>
  );
}
