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
  Maximize,
  Languages,
  Undo2,
  Redo2,
  History as HistoryIcon,
  Mic,
  Square,
} from "lucide-react";
import Dropzone from "../Dropzone";
import ToolUploadScreen from "../ToolUploadScreen";
import ExportStatus from "../ExportStatus";
import ResultPanel from "../ResultPanel";
import FramedVideoStage from "./FramedVideoStage";
import RectOverlay, { type FractionRect } from "./RectOverlay";
import CaptionsEditor from "./CaptionsEditor";
import CaptionStylesPanel from "./CaptionStylesPanel";
import EditorTimeline, { type TimelineLane } from "./editor/EditorTimeline";
import EditorRailButton from "./editor/EditorRailButton";
import PanelHeader from "./editor/PanelHeader";
import ChromaKeyPanel from "./editor/ChromaKeyPanel";
import OverlayLayersPanel from "./editor/OverlayLayersPanel";
import PickColorOverlay from "./editor/PickColorOverlay";
import FloatingTextToolbar, {
  MAX_TEXT_SIZE,
} from "./editor/FloatingTextToolbar";
import PositionedTextBlock from "./editor/PositionedTextBlock";
import CaptionOverlay from "./editor/CaptionOverlay";
import DraggableResizableOverlay from "./editor/DraggableResizableOverlay";
import { useVideoFile } from "../../../lib/hooks/useVideoFile";
import { useFfmpegExport } from "../../../lib/hooks/useFfmpegExport";
import { useCaptions } from "../../../lib/hooks/useCaptions";
import { usePersonCutout } from "../../../lib/hooks/usePersonCutout";
import { useChromaBgPreview } from "../../../lib/hooks/useChromaBgPreview";
import { useVoiceNoiseAudioGraph } from "../../../lib/hooks/useVoiceNoiseAudioGraph";
import { useMusicPreviewSync } from "../../../lib/hooks/useMusicPreviewSync";
import { useClipTimeline } from "../../../lib/hooks/useClipTimeline";
import { useHistoryState } from "../../../lib/hooks/useHistoryState";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { stopAllTracks } from "../../../lib/media/mix-audio";
import {
  AUDIO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";
import ExtraClipLayer from "./editor/ExtraClipLayer";
import { stripExtension } from "../../../lib/ffmpeg/format";
import { formatTime, clamp } from "../../../lib/time";
import { sampleVideoColor } from "../../../lib/sample-video-color";
import { buildEditorCommand } from "../../../lib/ffmpeg/build-editor-command";
import { TEXT_FONTS } from "../../../lib/ffmpeg/fonts";
import { TEXT_COLORS } from "../../../lib/ffmpeg/text-colors";
import {
  QUALITY_LABELS,
  resolveQualityTarget,
} from "../../../lib/ffmpeg/upscale-filter";
import { nearestCutoutFrame } from "../../../lib/captions/person-cutout";
import {
  POSITION_PRESETS,
  isAtPositionPreset,
  type TextPositionPreset,
} from "../../../lib/ffmpeg/text-position-presets";
import { resolveBackgroundSize } from "../../../lib/ffmpeg/editor-state";
import { SOCIAL_PRESET_GROUPS } from "../../../lib/social-presets";
import {
  IMAGE_ENTRANCE_ANIMATIONS,
  type ImageEntranceAnimation,
} from "../../../lib/ffmpeg/media-animation";
import type { OverlayLayer } from "../../../lib/ffmpeg/overlay-layer";
import type {
  EditorChromaKeyState,
  EditorCropState,
  EditorLogoState,
  EditorBackgroundState,
  EditorMusicState,
  EditorDubState,
  EditorExtraClipState,
  EditorTextState,
  EditorFadeState,
  EditorQualityState,
  BgFillMode,
  GradientDirection,
  DubMode,
  TextAnimation,
} from "../../../lib/ffmpeg/editor-state";

const DEFAULT_CROP_RECT: FractionRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
const DEFAULT_LOGO_RECT: FractionRect = { x: 0.72, y: 0.06, w: 0.22, h: 0.14 };

const DEFAULT_PREVIEW_HEIGHT = 384;
const MIN_PREVIEW_HEIGHT = 220;
const MAX_PREVIEW_HEIGHT = 720;

const QUALITY_TARGETS: EditorQualityState["target"][] = [
  "original",
  "720p",
  "1080p",
  "4k",
];

const PREVIEW_ASPECTS: {
  id: string;
  label: string;
  ratio: { w: number; h: number } | null;
}[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "9:16", label: "9:16", ratio: { w: 9, h: 16 } },
  { id: "16:9", label: "16:9", ratio: { w: 16, h: 9 } },
  { id: "1:1", label: "1:1", ratio: { w: 1, h: 1 } },
  { id: "4:5", label: "4:5", ratio: { w: 4, h: 5 } },
  { id: "3:4", label: "3:4", ratio: { w: 3, h: 4 } },
  { id: "4:3", label: "4:3", ratio: { w: 4, h: 3 } },
];

const TEXT_ANIMATIONS: { id: TextAnimation; label: string }[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade / Dissolve" },
  { id: "slide-up", label: "Slide up" },
  { id: "slide-down", label: "Slide down" },
  { id: "slide-left", label: "Shift left" },
  { id: "slide-right", label: "Shift right" },
  { id: "pop", label: "Pop" },
  { id: "bounce", label: "Bounce" },
];

const FILL_MODES: { id: BgFillMode; label: string }[] = [
  { id: "blur", label: "Blurred video" },
  { id: "solid", label: "Solid color" },
  { id: "gradient", label: "Gradient" },
];

type RailId =
  | "media"
  | "crop"
  | "speed"
  | "color"
  | "logo"
  | "voice"
  | "noise"
  | "resize"
  | "text"
  | "captions"
  | "overlays"
  | "music"
  | "dub"
  | "clips"
  | "quality";

/** Every setting that goes into the exported video — one undo/redo history
 * covers all of it. Trim range, caption cues/style, and person-cutout data
 * are deliberately kept outside this document (they have their own
 * async-generation state machines with a "reset" of their own); everything
 * else the rail panels expose lives here. */
interface EditorDocument {
  crop: EditorCropState;
  speedFadeOpen: boolean;
  speed: number;
  fade: EditorFadeState;
  chromaKey: EditorChromaKeyState;
  voiceRemover: boolean;
  noise: { enabled: boolean; strength: number };
  logo: EditorLogoState;
  background: EditorBackgroundState;
  music: EditorMusicState;
  dub: EditorDubState;
  extraClip: EditorExtraClipState;
  overlaysOpen: boolean;
  overlays: OverlayLayer[];
  text: EditorTextState;
  captionsEnabled: boolean;
  quality: EditorQualityState;
}

function makeInitialDocument(): EditorDocument {
  return {
    crop: { enabled: false, rect: DEFAULT_CROP_RECT },
    speedFadeOpen: false,
    speed: 1,
    fade: { in: 0, out: 0 },
    chromaKey: {
      enabled: false,
      colorHex: "#00ff00",
      similarity: 0.2,
      blend: 0.1,
      replace: "color",
      replaceColorHex: "#000000",
      replaceImageFile: null,
      replaceVideoFile: null,
    },
    voiceRemover: false,
    noise: { enabled: false, strength: 12 },
    logo: { enabled: false, rect: DEFAULT_LOGO_RECT },
    background: {
      enabled: false,
      presetId: "instagram-reel",
      customWidth: 1080,
      customHeight: 1920,
      fillMode: "blur",
      solidColor: "#0f172a",
      gradientFrom: "#6366f1",
      gradientTo: "#ec4899",
      gradientDirection: "vertical",
    },
    music: { enabled: false, file: null, mode: "mix" },
    dub: { enabled: false, file: null, mode: "replace", duckLevel: 0.15 },
    extraClip: {
      enabled: false,
      file: null,
      kind: "video",
      position: "after",
      imageDuration: 3,
      animation: "none",
    },
    overlaysOpen: false,
    overlays: [],
    text: {
      enabled: false,
      content: "Your text here",
      color: "#ffffff",
      fontSize: 56,
      x: 50,
      y: 90,
      fontId: "geist",
      animation: "none",
      uppercase: false,
      background: true,
      backgroundColor: "#000000",
      backgroundOpacity: 0.45,
      outline: false,
      outlineColor: "#000000",
      shadow: false,
      shadowColor: "#000000",
    },
    captionsEnabled: true,
    quality: { target: "original", sharpen: true },
  };
}

export default function VideoEditorTool() {
  const video = useVideoFile();
  const exportState = useFfmpegExport();
  const captions = useCaptions();
  const personCutout = usePersonCutout();

  const history = useHistoryState<EditorDocument>(makeInitialDocument());
  const doc = history.state;
  function patch<K extends keyof EditorDocument>(
    key: K,
    updater:
      EditorDocument[K] | ((prev: EditorDocument[K]) => EditorDocument[K]),
    label?: string,
  ) {
    history.set(
      (prev) => ({
        ...prev,
        [key]:
          typeof updater === "function"
            ? (updater as (p: EditorDocument[K]) => EditorDocument[K])(
                prev[key],
              )
            : updater,
      }),
      label ?? String(key),
    );
  }
  const [historyOpen, setHistoryOpen] = useState(false);

  // Which rail panel is open — null keeps the preview at full width.
  const [activePanel, setActivePanel] = useState<RailId | null>(null);

  // Natural width/height of each overlay layer's media, measured once it
  // loads — used so its drag handle scales the box at the right aspect ratio.
  const [overlayAspects, setOverlayAspects] = useState<Record<string, number>>(
    {},
  );

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
  const previewAspect =
    PREVIEW_ASPECTS.find((a) => a.id === previewAspectId)?.ratio ?? null;

  const [pickingColor, setPickingColor] = useState(false);
  const chromaBg = useChromaBgPreview({
    chromaKey: doc.chromaKey,
    background: doc.background,
  });
  const voiceNoiseAudio = useVoiceNoiseAudioGraph({
    videoRef: video.videoRef,
    voiceRemover: doc.voiceRemover,
    noiseEnabled: doc.noise.enabled,
    noiseStrength: doc.noise.strength,
  });
  const musicPreview = useMusicPreviewSync({
    videoRef: video.videoRef,
    enabled: doc.music.enabled,
    file: doc.music.file,
    mode: doc.music.mode,
    start,
  });
  const extraVideoRef = useRef<HTMLVideoElement>(null);
  const [extraClipUrl, setExtraClipUrl] = useState<string | null>(null);
  const [extraVideoDuration, setExtraVideoDuration] = useState(0);

  useEffect(() => {
    if (!doc.extraClip.file) {
      setExtraClipUrl(null);
      return;
    }
    const url = URL.createObjectURL(doc.extraClip.file);
    setExtraClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [doc.extraClip.file]);

  const extraClipDuration =
    doc.extraClip.kind === "image"
      ? Math.max(0.5, doc.extraClip.imageDuration)
      : extraVideoDuration;

  const clipTimeline = useClipTimeline({
    mainVideoRef: video.videoRef,
    extraVideoRef,
    extraClip: doc.extraClip,
    extraDuration: extraClipDuration,
    start,
    end,
  });

  // ---- Dub: recorded or uploaded replacement voice track ----
  const dubRecorder = useMediaRecorder();
  const dubStreamRef = useRef<MediaStream | null>(null);
  const [dubUrl, setDubUrl] = useState<string | null>(null);
  const [dubRecordError, setDubRecordError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc.dub.file) {
      setDubUrl(null);
      return;
    }
    const url = URL.createObjectURL(doc.dub.file);
    setDubUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [doc.dub.file]);

  useEffect(() => {
    if (!dubRecorder.result) return;
    const ext = extensionForMimeType(dubRecorder.result.blob.type);
    const file = new File([dubRecorder.result.blob], `dub-recording.${ext}`, {
      type: dubRecorder.result.blob.type,
    });
    patch("dub", (s) => ({ ...s, file, enabled: true }), "Dub");
    dubRecorder.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dubRecorder.result]);

  const startDubRecording = async () => {
    setDubRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      dubStreamRef.current = stream;
      const mimeType = pickSupportedMimeType(AUDIO_RECORDER_MIME_CANDIDATES);
      dubRecorder.start(stream, mimeType);
    } catch {
      setDubRecordError("Microphone access needs your permission.");
    }
  };
  const stopDubRecording = () => {
    dubRecorder.stop();
    stopAllTracks(dubStreamRef.current);
    dubStreamRef.current = null;
  };
  useEffect(() => () => stopAllTracks(dubStreamRef.current), []);

  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT);
  const previewResize = useRef<{
    pointerY: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!previewResize.current) return;
      const { pointerY, startHeight } = previewResize.current;
      setPreviewHeight(
        clamp(
          startHeight + (e.clientY - pointerY),
          MIN_PREVIEW_HEIGHT,
          MAX_PREVIEW_HEIGHT,
        ),
      );
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
    const rate = doc.speedFadeOpen ? doc.speed : 1;
    el.playbackRate = rate;
    el.preservesPitch = true;
  }, [doc.speed, doc.speedFadeOpen, video.sourceUrl, video.videoRef]);

  // Live preview of the fade-in/out filter: ffmpeg applies `fade` *after*
  // `setpts`, i.e. in the sped-up output timeline, so the fade windows here
  // are scaled by `speed` to land at the same wall-clock moments as export.
  // Approximation vs. the real export: this dims the whole frame (including
  // text/captions/overlays), whereas ffmpeg's filter order only dims
  // logo/crop/chromaKey/background/captions, since text/overlays are drawn
  // in afterward.
  let fadeOverlayOpacity = 0;
  if (doc.speedFadeOpen && (doc.fade.in > 0 || doc.fade.out > 0)) {
    const rel = currentTime - start;
    const inWin = doc.fade.in * doc.speed;
    const outWin = doc.fade.out * doc.speed;
    if (doc.fade.in > 0 && rel < inWin) {
      fadeOverlayOpacity = 1 - rel / inWin;
    } else if (doc.fade.out > 0 && rel > trimmedDuration - outWin) {
      fadeOverlayOpacity = (rel - (trimmedDuration - outWin)) / outWin;
    }
  }
  fadeOverlayOpacity = Math.min(1, Math.max(0, fadeOverlayOpacity));

  const handlePickColor = (fx: number, fy: number) => {
    const el = video.videoRef.current;
    if (!el) return;
    patch(
      "chromaKey",
      (s) => ({ ...s, colorHex: sampleVideoColor(el, fx, fy) }),
      "Color key",
    );
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
      crop: doc.crop,
      logo: doc.logo,
      chromaKey: doc.chromaKey,
      background: doc.background,
      speed: doc.speedFadeOpen ? doc.speed : 1,
      fade: doc.speedFadeOpen ? doc.fade : { in: 0, out: 0 },
      voiceRemover: doc.voiceRemover,
      noise: doc.noise,
      music: doc.music,
      dub: doc.dub,
      overlays: doc.overlays,
      extraClip: doc.extraClip,
      text: doc.text,
      captions: {
        enabled: doc.captionsEnabled,
        cues: captions.cues,
        style: captions.style,
      },
      personCutoutFrames: personCutout.frames,
      quality: doc.quality,
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
    history.replaceInitial(makeInitialDocument());
    captions.reset();
    personCutout.clear();
    dubRecorder.reset();
    setPreviewHeight(DEFAULT_PREVIEW_HEIGHT);
  };

  if (!video.hasFile) {
    return (
      <ToolUploadScreen
        icon={Clapperboard}
        title="Video Editor"
        description="Trim, resize for any platform, dub audio, animate text — with full undo/redo history."
      >
        <Dropzone
          accept="video/*"
          label="Drop a video here, or click to browse"
          hint="MP4, WebM, MOV, and more — processed entirely on your device"
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

  const activeCaptionCue = doc.captionsEnabled
    ? captions.cues.find((c) => currentTime >= c.start && currentTime < c.end)
    : undefined;
  const cutoutFrame =
    doc.captionsEnabled && captions.style.occludeByPerson
      ? nearestCutoutFrame(personCutout.frames, currentTime)
      : null;

  // Feature lanes are authored in main-clip-relative time; when an intro/outro
  // clip extends the timeline, shift their displayed positions by the same
  // introOffset the ruler uses, and un-shift drag results back before
  // feeding them to state that's still main-relative.
  const laneOffset = clipTimeline.active ? clipTimeline.introOffset : 0;

  const lanes: TimelineLane[] = [];
  if (doc.captionsEnabled && captions.cues.length > 0) {
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
      onSegmentChange: (id, patchSeg) =>
        captions.updateCue(
          id,
          {
            start: patchSeg.start - laneOffset,
            end: patchSeg.end - laneOffset,
          },
          start,
          end,
        ),
      onSegmentDelete: (id) => captions.removeCue(id),
    });
  }
  if (doc.text.enabled && doc.text.content.trim()) {
    lanes.push({
      id: "text",
      label: "Text",
      colorClass: "bg-accent-500",
      segments: [
        {
          id: "text",
          start: start + laneOffset,
          end: end + laneOffset,
          label: doc.text.content,
        },
      ],
      onSegmentDelete: () =>
        patch("text", (s) => ({ ...s, enabled: false }), "Text"),
    });
  }
  if (doc.overlaysOpen && doc.overlays.length > 0) {
    lanes.push({
      id: "overlays",
      label: "Overlays",
      colorClass: "bg-success-500",
      segments: doc.overlays.map((o) => ({
        id: o.id,
        start: start + o.start + laneOffset,
        end: start + o.end + laneOffset,
        label: o.label,
      })),
      minSegmentLength: 0.2,
      onSegmentChange: (id, patchSeg) =>
        patch(
          "overlays",
          (os) =>
            os.map((o) =>
              o.id === id
                ? {
                    ...o,
                    start: clampToRange(patchSeg.start - laneOffset) - start,
                    end: clampToRange(patchSeg.end - laneOffset) - start,
                  }
                : o,
            ),
          "Overlays",
        ),
      onSegmentDelete: (id) =>
        patch("overlays", (os) => os.filter((o) => o.id !== id), "Overlays"),
    });
  }
  if (doc.music.enabled && doc.music.file) {
    lanes.push({
      id: "music",
      label: "Music",
      colorClass: "bg-warning-500",
      segments: [
        {
          id: "music",
          start: start + laneOffset,
          end: end + laneOffset,
          label: doc.music.file.name,
        },
      ],
      onSegmentDelete: () =>
        patch("music", (s) => ({ ...s, enabled: false }), "Music"),
    });
  }
  if (doc.dub.enabled && doc.dub.file) {
    lanes.push({
      id: "dub",
      label: "Dub",
      colorClass: "bg-danger-500",
      segments: [
        {
          id: "dub",
          start: start + laneOffset,
          end: end + laneOffset,
          label: doc.dub.file.name,
        },
      ],
      onSegmentDelete: () =>
        patch("dub", (s) => ({ ...s, enabled: false }), "Dub"),
    });
  }

  type RailItem = {
    id: RailId;
    icon: typeof CropIcon;
    label: string;
    enabled: boolean;
  };
  type RailGroup = {
    id: string;
    icon: typeof CropIcon;
    label: string;
    items: RailItem[];
  };

  // Related single-feature panels are grouped under one rail button so the
  // whole rail fits on screen without scrolling — opening a group shows a
  // sub-tab strip at the top of its flyout to switch between its items.
  const GROUPS: RailGroup[] = [
    {
      id: "media",
      icon: Clapperboard,
      label: "Media",
      items: [
        { id: "media", icon: Clapperboard, label: "Media", enabled: false },
      ],
    },
    {
      id: "tools",
      icon: Wrench,
      label: "Tools",
      items: [
        {
          id: "crop",
          icon: CropIcon,
          label: "Crop",
          enabled: doc.crop.enabled,
        },
        {
          id: "speed",
          icon: Gauge,
          label: "Speed",
          enabled: doc.speedFadeOpen,
        },
        { id: "logo", icon: Eraser, label: "Logo", enabled: doc.logo.enabled },
        {
          id: "quality",
          icon: Sparkles,
          label: "Upscale",
          enabled: doc.quality.target !== "original",
        },
      ],
    },
    {
      id: "effects",
      icon: Wand2,
      label: "Effects",
      items: [
        {
          id: "color",
          icon: Palette,
          label: "Color key",
          enabled: doc.chromaKey.enabled,
        },
        {
          id: "resize",
          icon: Maximize,
          label: "Resize",
          enabled: doc.background.enabled,
        },
      ],
    },
    {
      id: "audio",
      icon: Volume2,
      label: "Audio",
      items: [
        {
          id: "voice",
          icon: MicOff,
          label: "Voice",
          enabled: doc.voiceRemover,
        },
        { id: "noise", icon: Wind, label: "Noise", enabled: doc.noise.enabled },
        {
          id: "music",
          icon: Music,
          label: "Music",
          enabled: doc.music.enabled,
        },
        { id: "dub", icon: Languages, label: "Dub", enabled: doc.dub.enabled },
      ],
    },
    {
      id: "text",
      icon: Type,
      label: "Text",
      items: [
        { id: "text", icon: Type, label: "Text", enabled: doc.text.enabled },
      ],
    },
    {
      id: "captions",
      icon: CaptionsIcon,
      label: "Subtitles",
      items: [
        {
          id: "captions",
          icon: CaptionsIcon,
          label: "Subtitles",
          enabled: doc.captionsEnabled && captions.cues.length > 0,
        },
      ],
    },
    {
      id: "layers",
      icon: Layers,
      label: "Layers",
      items: [
        {
          id: "overlays",
          icon: Layers,
          label: "Overlays",
          enabled: doc.overlaysOpen,
        },
        {
          id: "clips",
          icon: Film,
          label: "Clips",
          enabled: doc.extraClip.enabled,
        },
      ],
    },
  ];

  const activeGroup =
    GROUPS.find((g) => g.items.some((i) => i.id === activePanel)) ?? null;

  const handleGroupClick = (group: RailGroup) => {
    const isOpen = group.items.some((i) => i.id === activePanel);
    if (isOpen) {
      setActivePanel(null);
      return;
    }
    const remembered = lastGroupItem.current[group.id];
    const target =
      group.items.find((i) => i.id === remembered) ?? group.items[0];
    lastGroupItem.current[group.id] = target.id;
    setActivePanel(target.id);
  };

  const selectGroupItem = (group: RailGroup, id: RailId) => {
    lastGroupItem.current[group.id] = id;
    setActivePanel(id);
  };

  const resolvedBgSize = resolveBackgroundSize(doc.background);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {/* ---- Undo/redo + version history toolbar ---- */}
      <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 shadow-sm">
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!history.canUndo}
            onClick={history.undo}
            title="Undo"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            disabled={!history.canRedo}
            onClick={history.redo}
            title="Redo"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Redo2 size={16} />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              title="Version history"
              aria-expanded={historyOpen}
              className={`grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-(--color-bg-subtle) ${historyOpen ? "bg-(--color-bg-subtle) text-(--color-text)" : "text-(--color-text-muted)"}`}
            >
              <HistoryIcon size={16} />
            </button>
            {historyOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-surface) p-1 shadow-lg">
                <p className="px-2 py-1.5 text-caption font-semibold text-(--color-text-muted)">
                  Version history — click to restore
                </p>
                {history.timeline.map((entry, i) => (
                  <button
                    key={`${entry.at}-${i}`}
                    type="button"
                    onClick={() => {
                      history.restoreTo(i);
                      setHistoryOpen(false);
                    }}
                    className={`block w-full rounded-md px-2 py-1.5 text-left text-caption transition-colors ${
                      i === history.cursor
                        ? "bg-primary-500 text-white"
                        : "text-(--color-text) hover:bg-(--color-bg-subtle)"
                    }`}
                  >
                    {entry.label}
                    <span
                      className={`ml-2 tabular-nums ${i === history.cursor ? "text-white/80" : "text-(--color-text-faint)"}`}
                    >
                      {new Date(entry.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="min-w-0 truncate text-caption text-(--color-text-muted)">
          {video.file?.name}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:items-stretch">
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
                    <span className="text-[10px] leading-tight font-medium">
                      {item.label}
                    </span>
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
                <PanelHeader
                  label="Media"
                  description="Your source file for this edit."
                />
                <div className="space-y-3 text-body-sm">
                  <div className="rounded-lg border border-(--color-border) bg-(--color-bg-subtle) p-3">
                    <p className="truncate font-medium">{video.file?.name}</p>
                    <p className="mt-1 text-caption text-(--color-text-muted)">
                      {video.videoWidth}×{video.videoHeight} ·{" "}
                      {formatTime(video.duration)}
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
                  enabled={doc.crop.enabled}
                  onToggle={(enabled) =>
                    patch("crop", (s) => ({ ...s, enabled }), "Crop")
                  }
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
                  enabled={doc.speedFadeOpen}
                  onToggle={(enabled) => {
                    history.set(
                      (prev) => ({
                        ...prev,
                        speedFadeOpen: enabled,
                        speed: enabled ? prev.speed : 1,
                        fade: enabled ? prev.fade : { in: 0, out: 0 },
                      }),
                      "Speed & fade",
                    );
                  }}
                />
                <div
                  className={`space-y-3 ${doc.speedFadeOpen ? "" : "pointer-events-none opacity-40"}`}
                >
                  <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                    Speed
                    <input
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.05}
                      value={doc.speed}
                      disabled={!doc.speedFadeOpen}
                      onChange={(e) =>
                        patch("speed", Number(e.target.value), "Speed")
                      }
                      className="flex-1 accent-(--color-primary-500)"
                    />
                    <span className="w-12 text-right tabular-nums">
                      {doc.speed.toFixed(2)}x
                    </span>
                  </label>
                  <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                    Fade in
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={0.1}
                      value={doc.fade.in}
                      disabled={!doc.speedFadeOpen}
                      onChange={(e) =>
                        patch(
                          "fade",
                          (s) => ({ ...s, in: Number(e.target.value) }),
                          "Fade",
                        )
                      }
                      className="flex-1 accent-(--color-primary-500)"
                    />
                    <span className="w-12 text-right tabular-nums">
                      {doc.fade.in.toFixed(1)}s
                    </span>
                  </label>
                  <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                    Fade out
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={0.1}
                      value={doc.fade.out}
                      disabled={!doc.speedFadeOpen}
                      onChange={(e) =>
                        patch(
                          "fade",
                          (s) => ({ ...s, out: Number(e.target.value) }),
                          "Fade",
                        )
                      }
                      className="flex-1 accent-(--color-primary-500)"
                    />
                    <span className="w-12 text-right tabular-nums">
                      {doc.fade.out.toFixed(1)}s
                    </span>
                  </label>
                </div>
              </>
            )}

            {activePanel === "color" && (
              <>
                <PanelHeader
                  label="Remove a color / green screen"
                  enabled={doc.chromaKey.enabled}
                  onToggle={(enabled) =>
                    patch("chromaKey", (s) => ({ ...s, enabled }), "Color key")
                  }
                />
                <ChromaKeyPanel
                  state={doc.chromaKey}
                  onChange={(p) =>
                    patch("chromaKey", (s) => ({ ...s, ...p }), "Color key")
                  }
                  picking={pickingColor}
                  onTogglePicking={() => setPickingColor((p) => !p)}
                />
              </>
            )}

            {activePanel === "logo" && (
              <>
                <PanelHeader
                  label="Remove logo"
                  enabled={doc.logo.enabled}
                  onToggle={(enabled) =>
                    patch("logo", (s) => ({ ...s, enabled }), "Logo")
                  }
                />
                <p className="text-caption text-(--color-text-muted)">
                  Drag the red box over the logo or watermark in the preview.
                </p>
              </>
            )}

            {activePanel === "voice" && (
              <>
                <PanelHeader
                  label="Remove voice"
                  enabled={doc.voiceRemover}
                  onToggle={(v) => patch("voiceRemover", v, "Voice remover")}
                />
                <p className="text-caption text-(--color-text-muted)">
                  Best-effort: cancels audio that's identical in both stereo
                  channels (usually lead vocals). Works better on some mixes
                  than others, and has no effect on mono audio.
                </p>
              </>
            )}

            {activePanel === "noise" && (
              <>
                <PanelHeader
                  label="Reduce background noise"
                  enabled={doc.noise.enabled}
                  onToggle={(enabled) =>
                    patch("noise", (s) => ({ ...s, enabled }), "Noise")
                  }
                />
                <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                  Strength
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={1}
                    value={doc.noise.strength}
                    onChange={(e) =>
                      patch(
                        "noise",
                        (s) => ({ ...s, strength: Number(e.target.value) }),
                        "Noise",
                      )
                    }
                    className="flex-1 accent-(--color-primary-500)"
                  />
                  <span className="w-10 text-right tabular-nums">
                    {doc.noise.strength}
                  </span>
                </label>
              </>
            )}

            {activePanel === "resize" && (
              <>
                <PanelHeader
                  label="Resize for a platform"
                  description="Fits your video onto a preset (or custom) canvas and fills the empty space."
                  enabled={doc.background.enabled}
                  onToggle={(enabled) =>
                    patch("background", (s) => ({ ...s, enabled }), "Resize")
                  }
                />
                <div className="space-y-4">
                  {SOCIAL_PRESET_GROUPS.map((group) => (
                    <div key={group.platform}>
                      <p className="mb-1.5 text-caption font-semibold text-(--color-text-muted)">
                        {group.platform}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {group.presets.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() =>
                              patch(
                                "background",
                                (s) => ({ ...s, presetId: p.id }),
                                "Resize",
                              )
                            }
                            className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                              doc.background.presetId === p.id
                                ? "border-primary-500 bg-primary-500 text-white"
                                : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        patch(
                          "background",
                          (s) => ({ ...s, presetId: "custom" }),
                          "Resize",
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                        doc.background.presetId === "custom"
                          ? "border-primary-500 bg-primary-500 text-white"
                          : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong)"
                      }`}
                    >
                      Custom size
                    </button>
                    {doc.background.presetId === "custom" && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="number"
                          min={2}
                          value={doc.background.customWidth}
                          onChange={(e) =>
                            patch(
                              "background",
                              (s) => ({
                                ...s,
                                customWidth:
                                  Number(e.target.value) || s.customWidth,
                              }),
                              "Resize",
                            )
                          }
                          className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                        />
                        <span className="text-(--color-text-faint)">
                          &times;
                        </span>
                        <input
                          type="number"
                          min={2}
                          value={doc.background.customHeight}
                          onChange={(e) =>
                            patch(
                              "background",
                              (s) => ({
                                ...s,
                                customHeight:
                                  Number(e.target.value) || s.customHeight,
                              }),
                              "Resize",
                            )
                          }
                          className="w-20 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm tabular-nums outline-none focus:border-primary-400"
                        />
                      </div>
                    )}
                    <p className="mt-1.5 text-caption text-(--color-text-faint)">
                      Output: {resolvedBgSize.w}×{resolvedBgSize.h}
                    </p>
                  </div>

                  <div>
                    <p className="mb-1.5 text-caption font-semibold text-(--color-text-muted)">
                      Fill style
                    </p>
                    <div className="flex gap-1 rounded-md border border-(--color-border) p-1">
                      {FILL_MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() =>
                            patch(
                              "background",
                              (s) => ({ ...s, fillMode: m.id }),
                              "Resize",
                            )
                          }
                          className={`flex-1 rounded px-2 py-1.5 text-caption font-medium transition-colors ${
                            doc.background.fillMode === m.id
                              ? "bg-primary-500 text-white"
                              : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {doc.background.fillMode === "solid" && (
                    <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                      Color
                      <input
                        type="color"
                        value={doc.background.solidColor}
                        onChange={(e) =>
                          patch(
                            "background",
                            (s) => ({ ...s, solidColor: e.target.value }),
                            "Resize",
                          )
                        }
                        className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
                      />
                    </label>
                  )}

                  {doc.background.fillMode === "gradient" && (
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                        From
                        <input
                          type="color"
                          value={doc.background.gradientFrom}
                          onChange={(e) =>
                            patch(
                              "background",
                              (s) => ({ ...s, gradientFrom: e.target.value }),
                              "Resize",
                            )
                          }
                          className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
                        To
                        <input
                          type="color"
                          value={doc.background.gradientTo}
                          onChange={(e) =>
                            patch(
                              "background",
                              (s) => ({ ...s, gradientTo: e.target.value }),
                              "Resize",
                            )
                          }
                          className="h-7 w-10 cursor-pointer rounded border border-(--color-border) bg-transparent"
                        />
                      </label>
                      <select
                        value={doc.background.gradientDirection}
                        onChange={(e) =>
                          patch(
                            "background",
                            (s) => ({
                              ...s,
                              gradientDirection: e.target
                                .value as GradientDirection,
                            }),
                            "Resize",
                          )
                        }
                        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                      >
                        <option value="vertical">Vertical</option>
                        <option value="horizontal">Horizontal</option>
                        <option value="diagonal">Diagonal</option>
                      </select>
                    </div>
                  )}
                </div>
              </>
            )}

            {activePanel === "text" && (
              <>
                <PanelHeader
                  label="Add text"
                  enabled={doc.text.enabled}
                  onToggle={(enabled) =>
                    patch("text", (s) => ({ ...s, enabled }), "Text")
                  }
                />
                <div className="space-y-3">
                  <textarea
                    value={doc.text.content}
                    onChange={(e) =>
                      patch(
                        "text",
                        (s) => ({ ...s, content: e.target.value }),
                        "Text",
                      )
                    }
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
                          onClick={() =>
                            patch("text", (s) => ({ ...s, color: c }), "Text")
                          }
                          className={`h-6 w-6 rounded-full border-2 ${doc.text.color === c ? "border-primary-500" : "border-(--color-border)"}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                      {(
                        ["top", "center", "bottom"] as TextPositionPreset[]
                      ).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() =>
                            patch(
                              "text",
                              (s) => ({ ...s, ...POSITION_PRESETS[p] }),
                              "Text",
                            )
                          }
                          className={`rounded px-3 py-1 text-caption font-medium capitalize transition-colors ${isAtPositionPreset(doc.text.x, doc.text.y, p) ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
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
                        value={doc.text.fontSize}
                        onChange={(e) =>
                          patch(
                            "text",
                            (s) => ({ ...s, fontSize: Number(e.target.value) }),
                            "Text",
                          )
                        }
                        className="w-full min-w-0 flex-1 accent-(--color-primary-500)"
                      />
                      <span className="w-9 shrink-0 text-right tabular-nums">
                        {doc.text.fontSize}
                      </span>
                    </label>
                  </div>
                  <p className="text-caption text-(--color-text-muted)">
                    Drag the text in the preview to place it anywhere.
                  </p>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                      Font
                      <select
                        value={doc.text.fontId}
                        onChange={(e) =>
                          patch(
                            "text",
                            (s) => ({ ...s, fontId: e.target.value }),
                            "Text",
                          )
                        }
                        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                      >
                        {TEXT_FONTS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                      Animation
                      <select
                        value={doc.text.animation}
                        onChange={(e) =>
                          patch(
                            "text",
                            (s) => ({
                              ...s,
                              animation: e.target.value as TextAnimation,
                            }),
                            "Text",
                          )
                        }
                        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                      >
                        {TEXT_ANIMATIONS.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="border-t border-(--color-border) pt-3">
                    <p className="mb-2 text-caption font-semibold text-(--color-text-muted)">
                      Effects
                    </p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label className="flex items-center gap-1.5 text-caption text-(--color-text-muted)">
                        <input
                          type="checkbox"
                          checked={doc.text.background}
                          onChange={(e) =>
                            patch(
                              "text",
                              (s) => ({ ...s, background: e.target.checked }),
                              "Text",
                            )
                          }
                          className="accent-(--color-primary-500)"
                        />
                        Background
                        {doc.text.background && (
                          <input
                            type="color"
                            value={doc.text.backgroundColor}
                            onChange={(e) =>
                              patch(
                                "text",
                                (s) => ({
                                  ...s,
                                  backgroundColor: e.target.value,
                                }),
                                "Text",
                              )
                            }
                            className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-1.5 text-caption text-(--color-text-muted)">
                        <input
                          type="checkbox"
                          checked={doc.text.outline}
                          onChange={(e) =>
                            patch(
                              "text",
                              (s) => ({ ...s, outline: e.target.checked }),
                              "Text",
                            )
                          }
                          className="accent-(--color-primary-500)"
                        />
                        Outline
                        {doc.text.outline && (
                          <input
                            type="color"
                            value={doc.text.outlineColor}
                            onChange={(e) =>
                              patch(
                                "text",
                                (s) => ({ ...s, outlineColor: e.target.value }),
                                "Text",
                              )
                            }
                            className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-1.5 text-caption text-(--color-text-muted)">
                        <input
                          type="checkbox"
                          checked={doc.text.shadow}
                          onChange={(e) =>
                            patch(
                              "text",
                              (s) => ({ ...s, shadow: e.target.checked }),
                              "Text",
                            )
                          }
                          className="accent-(--color-primary-500)"
                        />
                        Shadow
                        {doc.text.shadow && (
                          <input
                            type="color"
                            value={doc.text.shadowColor}
                            onChange={(e) =>
                              patch(
                                "text",
                                (s) => ({ ...s, shadowColor: e.target.value }),
                                "Text",
                              )
                            }
                            className="h-5 w-5 cursor-pointer rounded border border-(--color-border) bg-transparent"
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-1.5 text-caption text-(--color-text-muted)">
                        <input
                          type="checkbox"
                          checked={doc.text.uppercase}
                          onChange={(e) =>
                            patch(
                              "text",
                              (s) => ({ ...s, uppercase: e.target.checked }),
                              "Text",
                            )
                          }
                          className="accent-(--color-primary-500)"
                        />
                        UPPERCASE
                      </label>
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
                  enabled={doc.captionsEnabled}
                  onToggle={(v) => patch("captionsEnabled", v, "Subtitles")}
                />
                <div className="space-y-4">
                  <CaptionsEditor
                    video={video}
                    captions={captions}
                    personCutout={personCutout}
                    rangeStart={start}
                    rangeEnd={end}
                    showStylesTab={false}
                  />
                </div>
              </>
            )}

            {activePanel === "overlays" && (
              <>
                <PanelHeader
                  label="Overlays: pictures, video, stickers"
                  enabled={doc.overlaysOpen}
                  onToggle={(enabled) => {
                    history.set(
                      (prev) => ({
                        ...prev,
                        overlaysOpen: enabled,
                        overlays: enabled ? prev.overlays : [],
                      }),
                      "Overlays",
                    );
                  }}
                />
                <OverlayLayersPanel
                  layers={doc.overlays}
                  onAdd={(layer) =>
                    patch("overlays", (o) => [...o, layer], "Overlays")
                  }
                  onUpdate={(id, p) =>
                    patch(
                      "overlays",
                      (o) => o.map((l) => (l.id === id ? { ...l, ...p } : l)),
                      "Overlays",
                    )
                  }
                  onRemove={(id) =>
                    patch(
                      "overlays",
                      (o) => o.filter((l) => l.id !== id),
                      "Overlays",
                    )
                  }
                  duration={trimmedDuration}
                />
              </>
            )}

            {activePanel === "music" && (
              <>
                <PanelHeader
                  label="Add music"
                  enabled={doc.music.enabled}
                  onToggle={(enabled) =>
                    patch("music", (s) => ({ ...s, enabled }), "Music")
                  }
                />
                {!doc.music.file ? (
                  <Dropzone
                    accept="audio/*"
                    label="Drop a music file here"
                    hint="MP3, WAV, M4A, and more"
                    onFiles={(files) =>
                      patch(
                        "music",
                        (s) => ({ ...s, file: files[0] ?? null }),
                        "Music",
                      )
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    <p className="text-body-sm text-(--color-text-muted)">
                      {doc.music.file.name}
                    </p>
                    <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                      <button
                        type="button"
                        onClick={() =>
                          patch(
                            "music",
                            (s) => ({ ...s, mode: "mix" }),
                            "Music",
                          )
                        }
                        className={`rounded px-3 py-1 text-caption font-medium transition-colors ${doc.music.mode === "mix" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        Mix with original
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          patch(
                            "music",
                            (s) => ({ ...s, mode: "replace" }),
                            "Music",
                          )
                        }
                        className={`rounded px-3 py-1 text-caption font-medium transition-colors ${doc.music.mode === "replace" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        Replace original
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {activePanel === "dub" && (
              <>
                <PanelHeader
                  label="Dub / replace voice"
                  description="Record or upload a replacement voice track, in any language."
                  enabled={doc.dub.enabled}
                  onToggle={(enabled) =>
                    patch("dub", (s) => ({ ...s, enabled }), "Dub")
                  }
                />
                {!doc.dub.file ? (
                  <div className="space-y-3">
                    <Dropzone
                      accept="audio/*"
                      label="Drop a dub audio file here"
                      hint="MP3, WAV, M4A, and more"
                      onFiles={(files) => {
                        const f = files[0];
                        if (f)
                          patch(
                            "dub",
                            (s) => ({ ...s, file: f, enabled: true }),
                            "Dub",
                          );
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <div className="h-px flex-1 bg-(--color-border)" />
                      <span className="text-caption text-(--color-text-muted)">
                        or
                      </span>
                      <div className="h-px flex-1 bg-(--color-border)" />
                    </div>
                    {dubRecorder.state !== "recording" ? (
                      <button
                        type="button"
                        onClick={startDubRecording}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-(--color-border) px-4 py-2 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
                      >
                        <Mic size={15} />
                        Record a dub with your mic
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={stopDubRecording}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-danger-500 px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-danger-600"
                      >
                        <Square size={13} />
                        Stop recording ·{" "}
                        {formatTime(dubRecorder.elapsedMs / 1000)}
                      </button>
                    )}
                    {(dubRecordError || dubRecorder.error) && (
                      <p className="text-caption text-danger-600">
                        {dubRecordError ?? dubRecorder.error}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {dubUrl && (
                      <audio src={dubUrl} controls className="w-full" />
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        patch("dub", (s) => ({ ...s, file: null }), "Dub")
                      }
                      className="text-caption font-medium text-danger-600 hover:underline"
                    >
                      Remove and choose another
                    </button>
                    <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                      {(
                        [
                          { id: "replace", label: "Replace" },
                          { id: "mix", label: "Mix" },
                          { id: "duck", label: "Duck original" },
                        ] as { id: DubMode; label: string }[]
                      ).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() =>
                            patch("dub", (s) => ({ ...s, mode: m.id }), "Dub")
                          }
                          className={`flex-1 rounded px-2 py-1.5 text-caption font-medium transition-colors ${doc.dub.mode === m.id ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    {doc.dub.mode === "duck" && (
                      <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                        Original volume under dub
                        <input
                          type="range"
                          min={0}
                          max={0.6}
                          step={0.05}
                          value={doc.dub.duckLevel}
                          onChange={(e) =>
                            patch(
                              "dub",
                              (s) => ({
                                ...s,
                                duckLevel: Number(e.target.value),
                              }),
                              "Dub",
                            )
                          }
                          className="flex-1 accent-(--color-primary-500)"
                        />
                        <span className="w-10 text-right tabular-nums">
                          {Math.round(doc.dub.duckLevel * 100)}%
                        </span>
                      </label>
                    )}
                  </div>
                )}
              </>
            )}

            {activePanel === "clips" && (
              <>
                <PanelHeader
                  label="Add intro/outro clip"
                  enabled={doc.extraClip.enabled}
                  onToggle={(enabled) =>
                    patch("extraClip", (s) => ({ ...s, enabled }), "Clips")
                  }
                />
                {!doc.extraClip.file ? (
                  <Dropzone
                    accept="video/*,image/*"
                    label="Drop an image or video here"
                    hint="Extends the total length of your export"
                    onFiles={(files) => {
                      const file = files[0];
                      if (!file) return;
                      patch(
                        "extraClip",
                        (s) => ({
                          ...s,
                          file,
                          kind: file.type.startsWith("image/")
                            ? "image"
                            : "video",
                        }),
                        "Clips",
                      );
                    }}
                  />
                ) : (
                  <div className="space-y-3">
                    <p className="text-body-sm text-(--color-text-muted)">
                      {doc.extraClip.file.name}
                    </p>
                    <div className="flex items-center gap-1 rounded-md border border-(--color-border) p-1">
                      <button
                        type="button"
                        onClick={() =>
                          patch(
                            "extraClip",
                            (s) => ({ ...s, position: "before" }),
                            "Clips",
                          )
                        }
                        className={`rounded px-3 py-1 text-caption font-medium transition-colors ${doc.extraClip.position === "before" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        Play before (intro)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          patch(
                            "extraClip",
                            (s) => ({ ...s, position: "after" }),
                            "Clips",
                          )
                        }
                        className={`rounded px-3 py-1 text-caption font-medium transition-colors ${doc.extraClip.position === "after" ? "bg-primary-500 text-white" : "text-(--color-text-muted) hover:bg-(--color-bg-subtle)"}`}
                      >
                        Play after (outro)
                      </button>
                    </div>
                    {doc.extraClip.kind === "image" && (
                      <>
                        <label className="flex items-center gap-3 text-caption text-(--color-text-muted)">
                          Show for
                          <input
                            type="range"
                            min={1}
                            max={10}
                            step={0.5}
                            value={doc.extraClip.imageDuration}
                            onChange={(e) =>
                              patch(
                                "extraClip",
                                (s) => ({
                                  ...s,
                                  imageDuration: Number(e.target.value),
                                }),
                                "Clips",
                              )
                            }
                            className="flex-1 accent-(--color-primary-500)"
                          />
                          <span className="w-12 text-right tabular-nums">
                            {doc.extraClip.imageDuration}s
                          </span>
                        </label>
                        <label className="flex flex-col gap-1 text-caption text-(--color-text-muted)">
                          Animation
                          <select
                            value={doc.extraClip.animation}
                            onChange={(e) =>
                              patch(
                                "extraClip",
                                (s) => ({
                                  ...s,
                                  animation: e.target
                                    .value as ImageEntranceAnimation,
                                }),
                                "Clips",
                              )
                            }
                            className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-body-sm"
                          >
                            {IMAGE_ENTRANCE_ANIMATIONS.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
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
                      onClick={() =>
                        patch(
                          "quality",
                          (s) => ({ ...s, target: t }),
                          "Quality",
                        )
                      }
                      className={`block w-full rounded-lg border px-4 py-2.5 text-left text-body-sm font-medium transition-colors ${
                        doc.quality.target === t
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
                    checked={doc.quality.sharpen}
                    onChange={(e) =>
                      patch(
                        "quality",
                        (s) => ({ ...s, sharpen: e.target.checked }),
                        "Quality",
                      )
                    }
                    className="accent-(--color-primary-500)"
                  />
                  Sharpen (recommended when upscaling)
                </label>
                <p className="mt-3 text-caption text-(--color-text-muted)">
                  Applies at export only — on-screen playback here is already
                  scaled to fit your browser window regardless of source
                  resolution, so a live preview wouldn't show a meaningful
                  difference.
                </p>
                {doc.quality.target !== "original" &&
                  !resolveQualityTarget(
                    doc.quality.target,
                    video.videoWidth,
                    video.videoHeight,
                  ) && (
                    <p className="mt-3 text-caption text-(--color-text-muted)">
                      Your source is already at or above{" "}
                      {QUALITY_LABELS[doc.quality.target]} — export will keep
                      the original resolution.
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
              <span className="text-caption font-medium text-(--color-text-muted)">
                Preview shape
              </span>
              <div
                className={`flex flex-wrap gap-1 ${doc.background.enabled ? "pointer-events-none opacity-40" : ""}`}
              >
                {PREVIEW_ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={doc.background.enabled}
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
              {doc.background.enabled && (
                <span className="text-caption text-(--color-text-muted)">
                  Set by Resize
                </span>
              )}
            </div>
            {video.sourceUrl && (
              <FramedVideoStage
                videoRef={video.videoRef}
                sourceUrl={video.sourceUrl}
                naturalWidth={video.videoWidth}
                naturalHeight={video.videoHeight}
                aspect={
                  doc.background.enabled
                    ? chromaBg.effectiveAspect
                    : previewAspect
                }
                maxHeight={previewHeight}
                canvasMode={
                  chromaBg.canvasMode &&
                  (!clipTimeline.active ||
                    clipTimeline.activeSegmentKind === "main")
                }
                onDrawFrame={chromaBg.onDrawFrame}
                onLoadedMetadata={handleLoadedMetadata}
                onError={video.onError}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                stageOverlay={
                  <ExtraClipLayer
                    extraClip={doc.extraClip}
                    extraVideoRef={extraVideoRef}
                    sourceUrl={extraClipUrl}
                    visible={
                      clipTimeline.active &&
                      clipTimeline.activeSegmentKind === "extra"
                    }
                    onVideoLoadedMetadata={() =>
                      setExtraVideoDuration(
                        extraVideoRef.current?.duration || 0,
                      )
                    }
                  />
                }
                floatingOverlay={() =>
                  !pickingColor && (
                    <>
                      {activePanel === "text" && doc.text.enabled && (
                        <FloatingTextToolbar
                          y={doc.text.y}
                          fontId={doc.text.fontId}
                          fontSize={doc.text.fontSize}
                          color={doc.text.color}
                          onChange={(p) =>
                            patch("text", (s) => ({ ...s, ...p }), "Text")
                          }
                        />
                      )}
                      {activePanel === "captions" && activeCaptionCue && (
                        <FloatingTextToolbar
                          y={captions.style.y}
                          fontId={captions.style.fontId}
                          fontSize={captions.style.fontSize}
                          color={captions.style.color}
                          onChange={captions.updateStyle}
                        />
                      )}
                    </>
                  )
                }
              >
                {(box) => {
                  const scale =
                    video.videoWidth > 0 ? box.width / video.videoWidth : 1;
                  return (
                    <>
                      {pickingColor && (
                        <PickColorOverlay onPick={handlePickColor} />
                      )}

                      {!pickingColor && doc.crop.enabled && (
                        <RectOverlay
                          boxWidth={box.width}
                          boxHeight={box.height}
                          rect={doc.crop.rect}
                          onChange={(rect) =>
                            patch("crop", (s) => ({ ...s, rect }), "Crop")
                          }
                        />
                      )}
                      {!pickingColor && doc.logo.enabled && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute rounded-sm"
                          style={{
                            left: doc.logo.rect.x * box.width,
                            top: doc.logo.rect.y * box.height,
                            width: doc.logo.rect.w * box.width,
                            height: doc.logo.rect.h * box.height,
                            backdropFilter: "blur(16px)",
                            WebkitBackdropFilter: "blur(16px)",
                          }}
                        />
                      )}
                      {!pickingColor && doc.logo.enabled && (
                        <RectOverlay
                          boxWidth={box.width}
                          boxHeight={box.height}
                          rect={doc.logo.rect}
                          onChange={(rect) =>
                            patch("logo", (s) => ({ ...s, rect }), "Logo")
                          }
                          color="danger"
                          minFraction={0.03}
                        />
                      )}

                      {!pickingColor &&
                        doc.overlays.map((layer) => (
                          <DraggableResizableOverlay
                            key={layer.id}
                            x={layer.x}
                            y={layer.y}
                            sizePercent={layer.sizePercent}
                            box={box}
                            aspectRatio={overlayAspects[layer.id] ?? 1}
                            draggable={activePanel === "overlays"}
                            onChange={(p) =>
                              patch(
                                "overlays",
                                (o) =>
                                  o.map((l) =>
                                    l.id === layer.id ? { ...l, ...p } : l,
                                  ),
                                "Overlays",
                              )
                            }
                          >
                            {layer.kind === "image" ? (
                              <img
                                src={layer.previewUrl}
                                alt=""
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  opacity: layer.opacity,
                                }}
                                className="max-w-none"
                                onLoad={(e) => {
                                  const el = e.currentTarget;
                                  if (
                                    el.naturalWidth > 0 &&
                                    el.naturalHeight > 0
                                  ) {
                                    setOverlayAspects((prev) => ({
                                      ...prev,
                                      [layer.id]:
                                        el.naturalWidth / el.naturalHeight,
                                    }));
                                  }
                                }}
                              />
                            ) : (
                              <video
                                src={layer.previewUrl}
                                muted
                                style={{
                                  width: "100%",
                                  height: "100%",
                                  opacity: layer.opacity,
                                }}
                                className="max-w-none"
                                onLoadedMetadata={(e) => {
                                  const el = e.currentTarget;
                                  if (el.videoWidth > 0 && el.videoHeight > 0) {
                                    setOverlayAspects((prev) => ({
                                      ...prev,
                                      [layer.id]:
                                        el.videoWidth / el.videoHeight,
                                    }));
                                  }
                                }}
                              />
                            )}
                          </DraggableResizableOverlay>
                        ))}

                      {!pickingColor && doc.text.enabled && (
                        <PositionedTextBlock
                          x={doc.text.x}
                          y={doc.text.y}
                          box={box}
                          draggable={activePanel === "text"}
                          onChange={(p) =>
                            patch("text", (s) => ({ ...s, ...p }), "Text")
                          }
                        >
                          <span
                            className="inline-block max-w-full whitespace-pre-wrap break-words font-semibold"
                            style={{
                              fontSize: doc.text.fontSize * scale,
                              color: doc.text.color,
                              lineHeight: 1.1,
                              padding: doc.text.background
                                ? `${8 * scale}px ${16 * scale}px`
                                : 0,
                              backgroundColor: doc.text.background
                                ? `${doc.text.backgroundColor}${Math.round(
                                    doc.text.backgroundOpacity * 255,
                                  )
                                    .toString(16)
                                    .padStart(2, "0")}`
                                : "transparent",
                              WebkitTextStroke: doc.text.outline
                                ? `${Math.max(1, 2 * scale)}px ${doc.text.outlineColor}`
                                : undefined,
                              paintOrder: doc.text.outline
                                ? "stroke fill"
                                : undefined,
                              textShadow: doc.text.shadow
                                ? `${3 * scale}px ${3 * scale}px 2px ${doc.text.shadowColor}`
                                : undefined,
                              textTransform: doc.text.uppercase
                                ? "uppercase"
                                : undefined,
                              fontFamily: TEXT_FONTS.find(
                                (f) => f.id === doc.text.fontId,
                              )?.cssFontFamily,
                            }}
                          >
                            {doc.text.content || " "}
                          </span>
                        </PositionedTextBlock>
                      )}
                      {!pickingColor && activeCaptionCue && (
                        <PositionedTextBlock
                          x={captions.style.x}
                          y={captions.style.y}
                          box={box}
                          draggable={activePanel === "captions"}
                          onChange={captions.updateStyle}
                        >
                          <CaptionOverlay
                            style={captions.style}
                            cue={activeCaptionCue}
                            currentTime={currentTime}
                            scale={scale}
                          />
                        </PositionedTextBlock>
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
            <audio
              ref={musicPreview.audioRef}
              src={musicPreview.sourceUrl ?? undefined}
              className="hidden"
            />
            {video.sourceUrl && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize preview height"
                onPointerDown={(e) => {
                  e.preventDefault();
                  previewResize.current = {
                    pointerY: e.clientY,
                    startHeight: previewHeight,
                  };
                }}
                className="mx-auto -mb-2 mt-1 flex h-3 w-16 cursor-row-resize items-center justify-center rounded-full text-(--color-text-faint) hover:text-(--color-text-muted)"
              >
                <GripHorizontal size={14} />
              </div>
            )}
          </div>

          <EditorTimeline
            duration={
              clipTimeline.active ? clipTimeline.totalDuration : video.duration
            }
            start={
              clipTimeline.active ? clipTimeline.introOffset + start : start
            }
            end={clipTimeline.active ? clipTimeline.introOffset + end : end}
            currentTime={
              clipTimeline.active ? clipTimeline.virtualTime : currentTime
            }
            onChangeStart={(t) =>
              setStart(
                Math.max(
                  0,
                  t - (clipTimeline.active ? clipTimeline.introOffset : 0),
                ),
              )
            }
            onChangeEnd={(t) =>
              setEnd(
                Math.max(
                  0,
                  t - (clipTimeline.active ? clipTimeline.introOffset : 0),
                ),
              )
            }
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
                exportState.isProcessing ||
                trimmedDuration <= 0 ||
                video.isMetadataLoading ||
                !!video.metadataError
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

        {/* ---- Caption templates: dedicated right-hand column, shown only while the Subtitles panel is active ---- */}
        {activePanel === "captions" && (
          <div className="w-full shrink-0 rounded-xl border border-(--color-border) bg-(--color-surface) p-4 shadow-sm md:h-full md:w-[420px] md:overflow-y-auto">
            <CaptionStylesPanel
              video={video}
              captions={captions}
              personCutout={personCutout}
              rangeStart={start}
              rangeEnd={end}
            />
          </div>
        )}
      </div>
    </div>
  );
}
