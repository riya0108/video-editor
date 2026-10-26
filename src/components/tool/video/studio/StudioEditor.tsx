import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Captions,
  Download,
  HelpCircle,
  ImagePlus,
  Layers,
  Library,
  Loader2,
  Monitor,
  Moon,
  Music,
  Palette,
  Pause,
  Play,
  Redo2,
  Shapes,
  SkipBack,
  SkipForward,
  Sparkles,
  Sun,
  Type,
  Undo2,
} from "lucide-react";
import CompositionPreview from "../composition/CompositionPreview";
import { TimelineEngine, type EditResult } from "../../../../lib/timeline/engine";
import { formatTimecode, secondsToFrames } from "../../../../lib/timeline/time-model";
import { timelineDurationFrames, type CompositionSettings } from "../../../../lib/timeline/model";
import { clipTimelineEnd, isTrimmableContent, type Clip } from "../../../../lib/timeline/clip";
import type { ClipVisual, ClipVisualPatch } from "../../../../lib/timeline/visual";
import { normalizeTextStyle, type TextStyle } from "../../../../lib/timeline/text-style";
import { normalizeShapeSpec, shapePreset, type ShapePreset } from "../../../../lib/timeline/shape-style";
import { GRAPHICS_LIBRARY } from "../../../../lib/graphics/library";
import { svgSpecFromMarkup } from "../../../../lib/graphics/svg";
import { addTextLayer as addTextLayerOp, type AuthoredContentPatch } from "../../../../lib/timeline/operations";
import { activeMotionSlots, applyMotionPreset, type MotionSlot } from "../../../../lib/animation/motion-presets";
import { STICKERS } from "../../../../lib/graphics/stickers";
import { DEFAULT_BRAND_KIT, loadBrandKit, logoPosition, saveBrandKit, type BrandKit } from "../../../../lib/brand/brand-kit";
import type { StockItem } from "../../../../lib/stock/providers";
import TimelinePanel from "../composition/TimelinePanel";
import { classifyImport, describeDecodeFailure, dragHasFiles, filesFromDataTransfer, refineImportKind } from "../../../../lib/composition/media-import";
import { createCanvasTextMeasurer, FinalRenderer, MediaFrameProvider, resolveClipLayer, safeZones, type ResolvedLayer, type SafeZonePreset } from "../../../../lib/composition";
import KeyframesPanel from "../composition/KeyframesPanel";
import EffectsPanel from "../composition/EffectsPanel";
import TransitionsPanel from "../composition/TransitionsPanel";
import { transitionWindow } from "../../../../lib/transitions/model";
import { updateEffectParams, updateMask } from "../../../../lib/timeline/operations";
import MasksPanel, { type BackgroundRemovalState } from "../composition/MasksPanel";
import { canRemoveBackground, generateClipMatte, matteSourceIdFor } from "../../../../lib/composition/matte-generation";
import type { MaskPatch } from "../../../../lib/masks/model";
import AIPanel from "../composition/AIPanel";
import VideoExportPanel from "../composition/VideoExportPanel";
import type { RenderDeps } from "../../../../lib/render/job";
import { AIEditingSession } from "../../../../lib/ai/session";
import { createDefaultRegistry } from "../../../../lib/ai/registry";
import { createBrowserServices, createClipMediaSource } from "../../../../lib/ai/media-browser";
import { FACE_MODEL, OBJECT_MODEL, loadFaceDetector, loadObjectDetector, mediapipeAvailable } from "../../../../lib/ai/detectors-mediapipe";
import { applyToPoint } from "../../../../lib/composition/matrix";
import MultiSelectionPanel from "../composition/MultiSelectionPanel";
import AudioPanel from "../composition/AudioPanel";
import CaptionsPanel, { type GenerateOptions } from "../composition/CaptionsPanel";
import { parseSubtitles, toSrt, toVtt } from "../../../../lib/captions/subtitle-io";
import { segmentWords, SEGMENT_PROFILES, toMono16k } from "../../../../lib/captions/segmenter";
import { captionCuesOf } from "../../../../lib/timeline/operations";
import type { CaptionProgress } from "../../../../lib/captions/auto-caption";
import { AudioSourceStore } from "../../../../lib/audio/source-store";
import { AudioPlaybackEngine } from "../../../../lib/audio/playback";
import { clipPeakDb, mixTimeline } from "../../../../lib/audio/engine-core";
import { AUDIO_ROLES, guessAudioRole, isAudibleKind } from "../../../../lib/audio/model";
import { valueAt } from "../../../../lib/animation/properties";
import { AssetRegistry } from "../../../../lib/project/asset-registry";
import { encodePng } from "../../../../lib/project/media-host";
import { fsAccessAvailable, pickMediaWithHandles } from "../../../../lib/project/file-target";
import type { ExportSettingsState, ProjectDocument } from "../../../../lib/project/document";
import type { ProjectMeta } from "../../../../lib/project/storage";
import { ProjectFileBar, useProjectPersistence, type PersistenceEditor, type ProjectFileActions } from "../composition/ProjectFileBar";
import { AudioExportBox, FinalRenderBox, LayersPanel, PropertiesPanel } from "./StudioPanels";
import { Drawer, FLAT_PANELS, Kbd, Modal, RailButton, SHORTCUTS, Tabs, ToastStack, type InspectorTab, type Toast } from "./StudioChrome";
import { ASPECTS, AspectGlyph, CanvasSettings, ElementsDrawer, MediaDrawer, TextDrawer, type TextPreset } from "./LibraryDrawers";
import StartScreen from "./StartScreen";
import { BrandDrawer, StockDrawer } from "./AssetDrawers";
import { CaptionTemplates, MotionPresetPicker } from "./TemplateGalleries";

/**
 * CLIPBENCH STUDIO — the full-screen editor. The composition engine (src/lib/composition), timeline engine,
 * audio, captions, masks, AI and export engines are driven from one app shell:
 *
 *   top bar      project name / save state / File menu · canvas size · undo/redo · Export
 *   left rail    Media, Text, Elements, Captions, Audio, Transitions, AI, Layers — each opens a library drawer
 *   center       the canvas (CompositionPreview) with its transport
 *   right        the inspector for the selection (or the canvas settings when nothing is selected)
 *   bottom       the timeline, resizable
 *
 * A fresh page opens the start screen over an empty editor (so storage and crash recovery are live at once);
 * `demo` boots straight into the sample project instead (the internal composition-preview page).
 */

const FPS = 30;
const DEMO_VIDEO_URL = "/videos/hero-phone-demo.mp4";

type RailId = "media" | "stock" | "text" | "elements" | "captions" | "audio" | "transitions" | "ai" | "brand" | "layers";
const RAIL: { id: RailId; label: string; icon: typeof ImagePlus; title: string; subtitle: string }[] = [
  { id: "media", label: "Media", icon: ImagePlus, title: "Media", subtitle: "Upload video, images and audio" },
  { id: "stock", label: "Stock", icon: Library, title: "Stock library", subtitle: "Free videos, photos and music" },
  { id: "text", label: "Text", icon: Type, title: "Text", subtitle: "Click a style to add it at the playhead" },
  { id: "elements", label: "Elements", icon: Shapes, title: "Elements", subtitle: "Stickers, emoji, shapes and graphics" },
  { id: "captions", label: "Captions", icon: Captions, title: "Captions", subtitle: "Pick a template, then generate or import" },
  { id: "audio", label: "Audio", icon: Music, title: "Audio", subtitle: "Music, voiceover and the final mix" },
  { id: "transitions", label: "Transitions", icon: ArrowLeftRight, title: "Transitions", subtitle: "Between clips, or in and out of one" },
  { id: "ai", label: "AI tools", icon: Sparkles, title: "AI tools", subtitle: "Detect, cut and reframe automatically" },
  { id: "brand", label: "Brand", icon: Palette, title: "Brand kit", subtitle: "Your logo, colors and fonts — on every project" },
  { id: "layers", label: "Layers", icon: Layers, title: "Layers", subtitle: "Top of the list is in front" },
];

const TIMELINE_H_KEY = "clipbench.studio.timelineHeight";
const readTimelineH = () => {
  try {
    const v = Number(localStorage.getItem(TIMELINE_H_KEY));
    return v >= 140 && v <= 900 ? v : 250;
  } catch {
    return 250;
  }
};

/** Even dimensions (encoders need them), longest side capped. */
function canvasFor(width: number, height: number, maxSide: number): { width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(2, Math.round((width * k) / 2) * 2), height: Math.max(2, Math.round((height * k) / 2) * 2) };
}

/** A transparent-background PNG-like asset (soft glow + star) — exercises real per-pixel alpha from an image source. */
function makeLogoAsset(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  const glow = g.createRadialGradient(256, 256, 40, 256, 256, 250);
  glow.addColorStop(0, "rgba(255,200,60,0.9)");
  glow.addColorStop(1, "rgba(255,120,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 512, 512);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 200 : 85;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    g.lineTo(256 + Math.cos(a) * r, 256 + Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = "#fff7d6";
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = "#f59e0b";
  g.stroke();
  return c;
}

/** Soft-edged ellipse alpha matte — stands in for a background-removal result; any matte with an alpha channel goes through the exact same path. */
function makeMatteAsset(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.filter = "blur(10px)";
  g.fillStyle = "#fff";
  g.beginPath();
  g.ellipse(128, 128, 100, 115, 0, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** The sample project: video, transparent PNG, matted picture-in-picture, shapes and a title. */
async function buildDemoEngine(provider: MediaFrameProvider, audioStore: AudioSourceStore | null, registry: AssetRegistry): Promise<TimelineEngine> {
  const { info: demoInfo, durationSec } = await provider.addVideo("demo-video", DEMO_VIDEO_URL, FPS);
  // The video's own soundtrack (decoded in the background; a video without one is simply silent).
  void audioStore?.add("demo-video", DEMO_VIDEO_URL, "Demo video", { video: true });
  const logoAsset = makeLogoAsset();
  const matteAsset = makeMatteAsset();
  provider.addStill("logo", logoAsset);
  provider.addStill("matte", matteAsset);
  registry.setUrl("demo-video", "video", "Demo video", DEMO_VIDEO_URL, { width: demoInfo.width, height: demoInfo.height, durationSec, fps: FPS });
  await registry.setGenerated("logo", "still", "Logo (generated)", "demo:logo", [{ frame: 0, bytes: await encodePng(logoAsset), width: logoAsset.width, height: logoAsset.height }]);
  await registry.setGenerated("matte", "still", "Matte (generated)", "demo:matte", [{ frame: 0, bytes: await encodePng(matteAsset), width: matteAsset.width, height: matteAsset.height }]);
  const durationFrames = Math.max(1, secondsToFrames(durationSec, FPS, "floor"));
  const engine = new TimelineEngine(FPS, { width: 1920, height: 1080, background: "#000000" });
  const must = <T extends object>(r: EditResult<T>) => {
    if (!r.ok) throw r.error;
    return r;
  };
  // Front-most first (trackIds[0] is on top).
  const title = must(engine.addTrack("text", "Title")).track;
  const badge = must(engine.addTrack("graphic", "Badge")).track;
  const logo = must(engine.addTrack("image", "Logo (transparent PNG)")).track;
  const pip = must(engine.addTrack("overlay", "PiP (alpha matte)")).track;
  const main = must(engine.addTrack("video", "Main video")).track;
  const backdrop = must(engine.addTrack("graphic", "Backdrop")).track;

  must(engine.insertClip(backdrop.id, { kind: "graphic", shape: normalizeShapeSpec({ type: "rect", width: 1920, height: 1080, fill: "#312e81", strokeWidth: 0, cornerRadius: 0 }), durationFrames }, 0));
  const mainClip = must(engine.insertClip(main.id, { kind: "video", source: { sourceId: "demo-video", sourceDurationFrames: durationFrames }, sourceInFrame: 0, sourceOutFrame: durationFrames }, 0)).clip;
  must(engine.setClipAudio(mainClip.id, { role: "original" }));
  must(
    engine.insertClip(pip.id, { kind: "overlay", source: { sourceId: "demo-video", sourceDurationFrames: durationFrames }, sourceInFrame: 0, sourceOutFrame: durationFrames }, 0, {
      transform: { x: 1560, y: 700, scaleX: 0.42, scaleY: 0.42, rotation: -6 },
      crop: { top: 0.05, bottom: 0.05 },
      matte: { sourceId: "matte", invert: false },
    }),
  );
  must(engine.insertClip(logo.id, { kind: "image", source: { sourceId: "logo" }, durationFrames }, 0, { fit: "none", transform: { x: 200, y: 200, scaleX: 0.5, scaleY: 0.5 }, opacity: 0.9 }));
  must(
    engine.insertClip(badge.id, { kind: "graphic", shape: normalizeShapeSpec({ type: "rect", width: 260, height: 84, fill: "#dc2626", stroke: "#ffffff", strokeWidth: 6, cornerRadius: 42 }), durationFrames }, 0, {
      transform: { x: 1700, y: 120, rotation: 4 },
    }),
  );
  must(
    engine.insertClip(title.id, { kind: "text", text: "Composition & preview engine", textStyle: normalizeTextStyle({ fontSize: 84, stroke: true, strokeColor: "#000000", strokeWidth: 6, maxWidth: 1400 }), durationFrames }, 0, {
      transform: { x: 960, y: 940 },
    }),
  );
  // The PiP shows the same video as the main layer — its copy of the soundtrack is muted so the voice isn't doubled.
  const pipClip = engine.timeline.tracks[pip.id].clipIds[0];
  must(engine.setClipAudio(pipClip, { muted: true }));
  engine.resetHistory();
  return engine;
}

export default function StudioEditor({ demo = false }: { demo?: boolean }) {
  const provider = useMemo(() => (typeof window === "undefined" ? null : new MediaFrameProvider()), []);
  const measurer = useMemo(() => (typeof window === "undefined" ? null : createCanvasTextMeasurer()), []);
  const finalRenderer = useMemo(() => (provider && measurer ? new FinalRenderer(provider, measurer) : null), [provider, measurer]);
  // AUDIO (Phase 11): decoded sources + waveform peaks, and the Web Audio player whose clock drives playback.
  const audioStore = useMemo(() => (typeof window === "undefined" ? null : new AudioSourceStore()), []);
  const player = useMemo(() => (audioStore ? new AudioPlaybackEngine((id) => audioStore.buffer(id)) : null), [audioStore]);
  const engineRef = useRef<TimelineEngine | null>(null);
  /** PERSISTENCE (Phase 17): where every source's media came from, so a project can be saved and reopened. */
  const registry = useMemo(() => new AssetRegistry(), []);
  const exportSettingsRef = useRef<ExportSettingsState | null>(null);
  const [exportPanelKey, setExportPanelKey] = useState(0);
  const frameRef = useRef(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [booting, setBooting] = useState<string | null>(demo ? "Loading the sample project…" : null);
  const [dragDepth, setDragDepth] = useState(0);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sliderDraft, setSliderDraft] = useState<{ clipId: string; visual: ClipVisual } | null>(null);
  const [safeZonePreset, setSafeZonePreset] = useState<SafeZonePreset>("off");
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /** Uncommitted inspector edit (text style / shape / SVG) — rendered live, committed as one undo step. */
  /** Effect param mid-scrub: rendered through a draft timeline made by the same pure op that will commit. */
  const [effectDraft, setEffectDraft] = useState<{ clipId: string; effectId: string; params: Record<string, number> } | null>(null);
  const [contentDraft, setContentDraft] = useState<{ clipId: string; patch: AuthoredContentPatch } | null>(null);
  const [styleClipboard, setStyleClipboard] = useState<TextStyle | null>(null);
  /** Selected transition (UI state, like clip selection — never in undo history). */
  const [selectedTransitionId, setSelectedTransitionId] = useState<string | null>(null);
  /** Transition preview: playback runs over this range once, then stops. */
  const [playRange, setPlayRange] = useState<{ start: number; end: number } | null>(null);
  /** Captions (Phase 12): which caption track the panel edits, and speech-to-text progress. */
  const [captionTrackId, setCaptionTrackId] = useState<string | null>(null);
  const [captionProgress, setCaptionProgress] = useState<CaptionProgress | null>(null);
  /** Masks (Phase 13): the mask being edited on the canvas, draw mode, and a mask param/handle mid-gesture (rendered through a draft timeline). */
  const [activeMask, setActiveMask] = useState<{ clipId: string; maskId: string } | null>(null);
  const [maskDrawing, setMaskDrawing] = useState<{ clipId: string; type: "polygon" | "freeform" } | null>(null);
  const [maskDraft, setMaskDraft] = useState<{ clipId: string; maskId: string; patch: MaskPatch } | null>(null);
  /** Background removal (existing matting engine -> matte input), per clip. */
  const [bgRemoval, setBgRemoval] = useState<BackgroundRemovalState & { clipId: string | null }>({ clipId: null, busy: null, error: null, report: null });
  const bgAbortRef = useRef<AbortController | null>(null);

  // --- shell state (never in the project) ---
  const [showStart, setShowStart] = useState(!demo);
  const [panel, setPanel] = useState<RailId | null>(demo ? "layers" : "media");
  const [inspectorTab, setInspectorTab] = useState("edit");
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(false);
  const [timelineH, setTimelineH] = useState(250);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recent, setRecent] = useState<ProjectMeta[]>([]);
  const [smallScreenOk, setSmallScreenOk] = useState(false);
  const [dark, setDark] = useState(true);
  const fileActionsRef = useRef<ProjectFileActions | null>(null);
  const [brand, setBrand] = useState<BrandKit>(DEFAULT_BRAND_KIT);
  /** The motion preset last picked per clip and slot (keyframes don't record a preset name) — chip highlighting only. */
  const [motionPicks, setMotionPicks] = useState<Record<string, Partial<Record<MotionSlot, string>>>>({});
  /** A caption template picked before any captions exist: applied to the first caption track created. */
  const pendingCaptionPresetRef = useRef<string | null>(null);
  const [pendingCaptionPreset, setPendingCaptionPreset] = useState<string | null>(null);
  /** Set when the user starts from footage: the canvas then takes the first video's (or image's) size. */
  const matchCanvasRef = useRef(false);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: Toast["text"], ttlMs = kind === "info" ? 5000 : 0) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-3), { id, kind, text }]);
    if (ttlMs) setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), ttlMs);
  }, []);
  const setNotice = useCallback((text: string | null) => text && toast("info", text), [toast]);

  useEffect(() => {
    setTimelineH(readTimelineH());
    setDark(document.documentElement.classList.contains("dark"));
    void loadBrandKit().then(setBrand);
  }, []);
  const updateBrand = useCallback(
    (patch: Partial<BrandKit>) =>
      setBrand((b) => {
        const next = { ...b, ...patch };
        void saveBrandKit(next).then((ok) => !ok && toast("warning", "Couldn't save the brand kit in this browser (storage is blocked) — it works until you close the tab.", 8000));
        return next;
      }),
    [toast],
  );

  /** Final rendering engine (Phase 15): the sources it reads — exact-frame decoders, decoded PCM and its status. */
  const renderDeps = useMemo<RenderDeps | null>(
    () =>
      provider && measurer && audioStore
        ? {
            provider,
            measurer,
            pcm: (id) => audioStore.pcm(id),
            audioState: (id) => {
              const st = audioStore.status(id).state;
              return st === "ready" || st === "loading" || st === "no-audio" || st === "error" ? st : "missing";
            },
          }
        : null,
    [provider, measurer, audioStore],
  );
  /** AI editing engine (Phase 14): one session per editor — analysis never edits; apply actions go through engine.transact. */
  const aiSession = useMemo(() => {
    if (!provider) return null;
    const aiRegistry = createDefaultRegistry({ loadFace: loadFaceDetector, loadObject: loadObjectDetector, available: mediapipeAvailable, faceModel: FACE_MODEL, objectModel: OBJECT_MODEL });
    const services = createBrowserServices({
      registerCanvas: (id, canvas) => {
        provider.addStill(id, canvas);
        // AI-made images exist nowhere else: kept (as PNG) in the project.
        void encodePng(canvas).then((png) => registry.setGenerated(id, "still", "AI image", "ai", [{ frame: 0, bytes: png, width: canvas.width, height: canvas.height }]));
      },
    });
    return new AIEditingSession(aiRegistry, services, (clip) => createClipMediaSource(clip, FPS, provider, (id) => audioStore?.pcm(id)));
  }, [provider, audioStore, registry]);

  /** Puts a new engine in the editor and resets every per-project UI state. */
  const adoptEngine = useCallback(
    (engine: TimelineEngine) => {
      engineRef.current = engine;
      setPlaying(false);
      setFrame(0);
      setSelectedTransitionId(null);
      setCaptionTrackId(null);
      setActiveMask(null);
      setMaskDrawing(null);
      player?.update(engine.timeline);
      bump();
    },
    [player],
  );

  // --- boot: an empty editor (start screen on top), or the sample project ---
  useEffect(() => {
    if (!provider) return;
    if (!demo) {
      const engine = new TimelineEngine(FPS, { width: 1920, height: 1080, background: "#000000" });
      engine.resetHistory();
      adoptEngine(engine);
      return;
    }
    let cancelled = false;
    buildDemoEngine(provider, audioStore, registry)
      .then((engine) => !cancelled && adoptEngine(engine))
      .catch((e) => !cancelled && setLoadError((e as Error).message))
      .finally(() => !cancelled && setBooting(null));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const loadDemo = async () => {
    if (!provider) return;
    setShowStart(false);
    setBooting("Loading the sample project…");
    try {
      adoptEngine(await buildDemoEngine(provider, audioStore, registry));
      setPanel("layers");
    } catch (e) {
      toast("error", `Could not load the sample project: ${(e as Error).message}`);
    } finally {
      setBooting(null);
    }
  };

  useEffect(() => () => provider?.dispose(), [provider]);
  useEffect(() => () => player?.dispose(), [player]);
  // Waveforms / decode status arriving re-render the timeline and inspector.
  useEffect(() => audioStore?.onChange(() => bump()), [audioStore]);
  // The media list in the Media drawer follows the registry.
  useEffect(() => registry.onChange(() => bump()), [registry]);

  const engine = engineRef.current;
  const timeline = engine?.timeline ?? null;
  const duration = timeline ? Math.max(1, timelineDurationFrames(timeline)) : 1;
  frameRef.current = frame;

  const persistenceEditor = useMemo<PersistenceEditor | null>(
    () =>
      engine && provider && audioStore
        ? {
            engine,
            provider,
            audio: audioStore,
            aiStore: aiSession?.store ?? null,
            registry,
            fps: FPS,
            getFrame: () => frameRef.current,
            exportSettings: exportSettingsRef,
            onLoaded: (doc: ProjectDocument) => {
              setPlaying(false);
              setSelectedTransitionId(null);
              setShowStart(false);
              setFrame(Math.min(doc.ui.frame, Math.max(0, timelineDurationFrames(doc.timeline) - 1)));
              setExportPanelKey((k) => k + 1);
              player?.update(engine.timeline);
              bump();
            },
          }
        : null,
    [engine, provider, audioStore, aiSession, registry, player],
  );
  const persistence = useProjectPersistence(persistenceEditor);
  // Recent projects for the start screen: every project this browser has autosaved or saved.
  useEffect(() => {
    if (!persistence || !showStart) return;
    void persistence.store
      .listMeta()
      .then((m) => setRecent([...m].sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setRecent([]));
  }, [persistence?.store, showStart]);
  const onFileActions = useCallback((a: ProjectFileActions) => {
    fileActionsRef.current = a;
  }, []);

  // --- playback clock: wall-clock based, so dropped render frames don't slow playback down ---
  // SYNC (AUDIO_ENGINE_ARCHITECTURE.md §4): while playing, the AudioContext clock is the master — the frame shown is
  // whatever the listener is hearing, so picture follows sound and dropped render frames never cause drift.
  useEffect(() => {
    provider?.setPlaying(playing);
    if (!playing) {
      player?.stop();
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const f0 = frame;
    const tl0 = engineRef.current?.timeline;
    if (player && tl0) player.play(tl0, f0);
    const tick = () => {
      // Audio clock when it's running; wall clock otherwise (no audio device / autoplay-blocked context) so the picture never freezes.
      const f = player?.clockRunning ? Math.floor(player.currentFrameExact()) : f0 + Math.floor(((performance.now() - t0) / 1000) * FPS);
      if (playRange && f >= playRange.end) {
        setFrame(Math.min(playRange.end, duration - 1));
        setPlaying(false);
        setPlayRange(null);
        return;
      }
      if (f >= duration) {
        // Loop: restart sound from the top in step with the picture.
        const tl = engineRef.current?.timeline;
        if (player && tl) player.play(tl, 0);
      }
      setFrame(f % duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, provider, playRange]);

  const apply = useCallback(
    (r: EditResult) => {
      if (!r.ok) toast("warning", `Edit rejected: ${r.error.message}`, 6000);
      // Edits while playing (volume, mute, trim, move...) are heard immediately: re-schedule from the current position.
      if (r.ok) player?.update(r.timeline);
      bump();
    },
    [player, toast],
  );

  // Every visual edit commits AT THE PLAYHEAD: animated properties get a keyframe there (auto-key), static ones change as before.
  const commitVisuals = useCallback((patches: Record<string, ClipVisualPatch>) => engine && apply(engine.setClipVisualsAtFrame(patches, frame)), [engine, apply, frame]);
  /** Selection lives in TimelineEngine (outside undo history, pruned on delete/undo) — the UI only mirrors it. */
  const setSelection = useCallback(
    (ids: string[]) => {
      engine?.selectMany(ids);
      setSelectedTransitionId(null);
      bump();
    },
    [engine],
  );
  /** Selecting a transition parks the playhead on its cut, so the preview shows it mid-way. */
  const selectTransition = useCallback(
    (id: string | null) => {
      setSelectedTransitionId(id);
      if (!engine || !id) return;
      engine.clearSelection();
      const t = engine.timeline.transitions?.[id];
      const w = t && transitionWindow(engine.timeline, t);
      if (w) {
        setPlaying(false);
        setFrame(Math.min(Math.max(w.start, w.cut), w.end - 1));
      }
      bump();
    },
    [engine],
  );
  const seek = useCallback((f: number) => {
    setPlaying(false);
    setFrame(f);
  }, []);

  // Debug handle for in-browser verification (dev only).
  useEffect(() => {
    if (import.meta.env.DEV && engine) (window as unknown as Record<string, unknown>).__composition = { engine, provider, finalRenderer, measurer, audioStore, player, aiSession, renderDeps };
  }, [engine, provider, finalRenderer, measurer, audioStore, player, aiSession, renderDeps]);

  // --- keyboard: undo/redo, play, frame stepping, export, shortcut sheet ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!engine || (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
        player?.update(engine.timeline);
        bump();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportOpen(true);
      } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if (!mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target as HTMLElement)?.closest("[role=application]")) {
        e.preventDefault();
        const step = (e.shiftKey ? FPS : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        const d = Math.max(1, timelineDurationFrames(engine.timeline));
        setPlaying(false);
        setFrame((f) => Math.min(d - 1, Math.max(0, f + step)));
      } else if (e.key === "k" || (e.key === " " && !(e.target as HTMLElement)?.closest("[role=application]"))) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, player]);

  /**
   * Adds picked/dropped files to the project:
   *  - video goes on the MAIN video track (created at the back when missing), appended after what's there — the way
   *    every editor builds a sequence; its soundtrack plays as the clip's original audio;
   *  - images go on their own new track at the FRONT, starting at the PLAYHEAD (full-frame on an empty canvas,
   *    half-size over existing footage); SVGs become graphics; audio gets its own track;
   *  - when the user started from footage, the canvas takes the first video's (or image's) size.
   * Every rejection or decode failure is reported by file name with a concrete fix; one bad file doesn't stop the rest.
   */
  const addMediaFiles = async (files: File[], handles: (FileSystemFileHandle | undefined)[] = []) => {
    if (!engine || !provider) return;
    const errors: string[] = [];
    const added: string[] = [];
    const relinked: string[] = [];
    const at = frame;
    const hasVisual = () => Object.values(engine.timeline.clips).some((cl) => cl.content.kind !== "audio" && cl.content.kind !== "caption");
    const matchCanvas = (w: number, h: number, maxSide: number) => {
      if (!matchCanvasRef.current || hasVisual()) return;
      matchCanvasRef.current = false;
      const r = engine.setCompositionSettings(canvasFor(w, h, maxSide));
      if (r.ok) engine.resetHistory(); // the starting canvas isn't an edit to undo
    };
    for (const [fi, file] of files.entries()) {
      const handle = handles[fi];
      const c = await refineImportKind(file, classifyImport(file));
      if (!c.ok) {
        errors.push(c.message);
        continue;
      }
      const id = `upload-${Date.now()}-${added.length}-${Math.random().toString(36).slice(2, 7)}`;
      const url = URL.createObjectURL(file);
      try {
        let r: EditResult<{ clip: Clip }>;
        if (c.kind === "audio") {
          URL.revokeObjectURL(url);
          if (!audioStore) throw new Error("audio unavailable");
          // RELINK: a project loaded without its audio references sources by id; re-adding a file with the same name
          // restores that source in place (every clip using it plays again) instead of adding a duplicate clip.
          const missingIds = new Set<string>();
          for (const clip of Object.values(engine.timeline.clips)) {
            const cc = clip.content;
            if (cc.kind === "audio" && cc.source.label === file.name && audioStore.status(cc.source.sourceId).state !== "ready") missingIds.add(cc.source.sourceId);
          }
          if (missingIds.size > 0) {
            for (const sid of missingIds) {
              const st = await audioStore.add(sid, file, file.name);
              if (st.state !== "ready") errors.push(st.state === "error" ? st.message : `${file.name}: no audio could be decoded.`);
              else {
                if (st.warning) errors.push(st.warning);
                await registry.setFile(sid, "audio", file, { durationSec: st.durationSec }, handle);
              }
            }
            relinked.push(file.name);
            continue;
          }
          const st = await audioStore.add(id, file, file.name);
          if (st.state !== "ready") {
            audioStore.remove(id);
            errors.push(st.state === "error" ? st.message : `${file.name}: no audio could be decoded.`);
            continue;
          }
          if (st.warning) errors.push(st.warning);
          const n = Math.max(1, Math.floor(st.durationSec * FPS));
          const role = guessAudioRole(file.name);
          const roleLabel = AUDIO_ROLES.find((x) => x.role === role)?.label ?? "Audio";
          const t = engine.addTrack("audio", `${roleLabel}: ${file.name}`);
          if (!t.ok) throw t.error;
          await registry.setFile(id, "audio", file, { durationSec: st.durationSec }, handle);
          r = engine.insertClip(t.track.id, { kind: "audio", source: { sourceId: id, label: file.name, sourceDurationFrames: n }, sourceInFrame: 0, sourceOutFrame: n }, at);
          if (r.ok) engine.setClipAudio(r.clip.id, { role });
        } else if (c.kind === "svg") {
          URL.revokeObjectURL(url);
          const { width, height } = engine.timeline.composition;
          const svg = svgSpecFromMarkup(await file.text(), Math.min(width, height) * 0.5);
          r = engine.addGraphicLayer({ graphic: { svg }, atFrame: at, durationFrames: 5 * FPS, name: file.name });
        } else if (c.kind === "video") {
          const { info, durationSec } = await provider.addVideo(id, url, FPS, file);
          void audioStore?.add(id, url, file.name, { video: true });
          await registry.setFile(id, "video", file, { width: info.width, height: info.height, durationSec, fps: FPS }, handle);
          const n = Math.max(1, secondsToFrames(durationSec, FPS, "floor"));
          matchCanvas(info.width, info.height, 3840);
          const tl = engine.timeline;
          let mainId = [...tl.trackIds].reverse().find((tid) => tl.tracks[tid].kind === "video");
          if (!mainId) {
            const t = engine.addTrack("video", "Main video");
            if (!t.ok) throw t.error;
            mainId = t.track.id;
          }
          const end = engine.timeline.tracks[mainId].clipIds.reduce((m, cid) => Math.max(m, clipTimelineEnd(engine.timeline.clips[cid])), 0);
          r = engine.insertClip(mainId, { kind: "video", source: { sourceId: id, label: file.name, sourceDurationFrames: n }, sourceInFrame: 0, sourceOutFrame: n }, end);
          if (r.ok) engine.setClipAudio(r.clip.id, { role: "original" });
        } else {
          const info = await provider.addImage(id, file);
          URL.revokeObjectURL(url); // images are decoded to a bitmap; the URL isn't needed
          await registry.setFile(id, "image", file, { width: info.width, height: info.height }, handle);
          matchCanvas(info.width, info.height, 1920);
          const full = !hasVisual();
          const t = engine.addTrack("image", file.name);
          if (!t.ok) throw t.error;
          engine.reorderTrack(t.track.id, 0);
          r = engine.insertClip(t.track.id, { kind: "image", source: { sourceId: id, label: file.name }, durationFrames: 5 * FPS }, at, full ? undefined : { transform: { scaleX: 0.5, scaleY: 0.5 } });
        }
        if (!r.ok) throw r.error;
        engine.select(r.clip.id);
        added.push(file.name);
      } catch (e) {
        URL.revokeObjectURL(url);
        provider.remove(id);
        audioStore?.remove(id);
        registry.remove(id);
        errors.push(describeDecodeFailure(file, c.kind, e));
      }
    }
    matchCanvasRef.current = false;
    if (errors.length) {
      toast(
        "error",
        <ul className="list-disc space-y-0.5 pl-4" data-testid="import-errors">
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>,
      );
    }
    if (added.length > 0 || relinked.length > 0) {
      setNotice([added.length ? `Added ${added.join(", ")}.` : "", relinked.length ? `Relinked missing audio: ${relinked.join(", ")}.` : ""].filter(Boolean).join(" "));
    }
    player?.update(engine.timeline);
    bump();
  };
  const pickMedia = fsAccessAvailable()
    ? async () => {
        // With the File System Access picker the browser hands out READ handles, so a reopened project finds its media again.
        const picked = await pickMediaWithHandles({ "video/*": [".mp4", ".mov", ".webm", ".m4v"], "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"], "audio/*": [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"] }).catch(() => []);
        if (picked.length) await addMediaFiles(picked.map((x) => x.file), picked.map((x) => x.handle));
      }
    : undefined;

  const resizeTimeline = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = timelineH;
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(window.innerHeight * 0.65, Math.max(140, h0 + (y0 - ev.clientY))));
      setTimelineH(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(TIMELINE_H_KEY, String(h));
      } catch {
        /* a remembered height is a convenience */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* theme choice is a convenience */
    }
    setDark(next);
  };

  if (loadError) return <p className="m-6 rounded-lg border border-danger-500/40 bg-danger-500/10 p-4 text-body-sm">Could not load the sample project: {loadError}</p>;
  if (!engine || !timeline || !provider || !measurer || !finalRenderer) {
    return (
      <div className="flex h-dvh items-center justify-center gap-2 bg-(--color-bg) text-body-sm text-(--color-text-muted)">
        <Loader2 className="h-4 w-4 animate-spin" /> {booting ?? "Starting the editor…"}
      </div>
    );
  }

  const selectedIds = [...engine.selection.selectedClipIds];
  // A transition dropped by an edit (clips moved apart / deleted) or undone simply stops being selected.
  const selectedTransition = selectedTransitionId ? (timeline.transitions?.[selectedTransitionId] ?? null) : null;
  // CAPTIONS PIPELINE (CAPTIONS_ARCHITECTURE.md §3): timeline audio mix (Phase 11 mixer, honoring mute/solo) -> 16 kHz
  // mono -> speech-to-text (in-browser Whisper) -> word timestamps -> segments -> caption clips. Word times come out in
  // TIMELINE seconds, so captions land where the speech is no matter how the clips are arranged.
  const generateCaptions = async (opts: GenerateOptions) => {
    if (!audioStore) return;
    // Read the engine's CURRENT state (not this render's snapshot): generation is async and must caption what's there now.
    const tl = engine.timeline;
    const selIds = [...engine.selection.selectedClipIds];
    const selNow = selIds.length === 1 ? tl.clips[selIds[0]] : undefined;
    const sel = selNow && isAudibleKind(selNow.content.kind) ? selNow : null;
    const startSec = opts.scope === "selection" && sel ? sel.timelineStart / FPS : 0;
    const endSec = opts.scope === "selection" && sel ? clipTimelineEnd(sel) / FPS : Math.max(1, timelineDurationFrames(tl)) / FPS;
    // "Selected clip only" hears ONLY that clip: its track soloed (solo is derived, so this view never touches the project).
    const source = opts.scope === "selection" && sel ? { ...tl, tracks: Object.fromEntries(Object.entries(tl.tracks).map(([id, t]) => [id, { ...t, solo: id === sel.trackId, muted: false }])) } : tl;
    const mix = mixTimeline(source, (id) => audioStore.pcm(id), { sampleRate: 16000, startSec, endSec });
    if (mix.peak === 0) {
      setNotice("There's no audible audio to caption (check mute/solo, or that the audio has finished loading).");
      return;
    }
    setCaptionProgress({ phase: "downloading", fraction: 0 });
    try {
      const { transcribeAudio16k } = await import("../../../../lib/captions/auto-caption");
      const { words } = await transcribeAudio16k(toMono16k(mix.channels, 16000), { modelTier: opts.tier, language: opts.language || undefined, onProgress: setCaptionProgress });
      const cues = segmentWords(words.map((w) => ({ text: w.text, start: w.start + startSec, end: w.end + startSec })), SEGMENT_PROFILES[opts.profile]);
      if (cues.length === 0) {
        setNotice("No speech was recognized in that audio.");
        return;
      }
      const target = opts.replace && captionTrackId && engine.timeline.tracks[captionTrackId]?.kind === "caption" ? captionTrackId : undefined;
      const r = engine.importCaptionCues(cues, { target, name: "Captions" });
      apply(r);
      if (r.ok) {
        setCaptionTrackId(r.trackId);
        applyPendingCaptionPreset(r.trackId);
        setNotice(`Generated ${r.clips.length} captions (${words.length} words) from ${(endSec - startSec).toFixed(1)} s of audio.`);
      }
    } catch (e) {
      toast("error", `Captioning failed: ${(e as Error).message}`);
    } finally {
      setCaptionProgress(null);
    }
  };
  const importSubtitleFile = async (file: File) => {
    if (!/\.(srt|vtt)$/i.test(file.name)) return setNotice(`${file.name}: not an .srt or .vtt file.`);
    if (file.size > 20 * 1024 * 1024) return setNotice(`${file.name}: subtitle file over 20 MB — that's not a subtitle file.`);
    const parsed = parseSubtitles(await file.text(), file.name);
    if (parsed.cues.length === 0) return setNotice(`${file.name}: no captions could be read.${parsed.warnings.length ? ` ${parsed.warnings.slice(0, 3).join(" ")}` : ""}`);
    const r = engine.importCaptionCues(parsed.cues, { name: file.name.replace(/\.(srt|vtt)$/i, "") });
    apply(r);
    if (r.ok) {
      setCaptionTrackId(r.trackId);
      applyPendingCaptionPreset(r.trackId);
      const notes = [`Imported ${r.clips.length} captions from ${file.name} (${parsed.format.toUpperCase()}).`];
      if (r.adjusted) notes.push(`${r.adjusted} overlapping/too-short cue timing(s) adjusted to fit a track.`);
      if (parsed.warnings.length) notes.push(`Skipped: ${parsed.warnings.length} block(s) — ${parsed.warnings.slice(0, 2).join(" ")}`);
      setNotice(notes.join(" "));
    }
  };
  const exportSubtitles = (trackId: string, format: "srt" | "vtt" | "vtt-words") => {
    const tl = engine.timeline;
    const cues = captionCuesOf(tl, trackId);
    const text = format === "srt" ? toSrt(cues) : toVtt(cues, { language: tl.tracks[trackId].caption?.language, wordTimings: format === "vtt-words" });
    const url = URL.createObjectURL(new Blob([text], { type: format === "srt" ? "application/x-subrip" : "text/vtt" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tl.tracks[trackId].name.replace(/[^\w.-]+/g, "_")}.${format === "srt" ? "srt" : "vtt"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setNotice(`Exported ${cues.length} captions as ${format === "srt" ? "SRT" : format === "vtt" ? "WebVTT" : "WebVTT with word timings"}.`);
    (window as unknown as Record<string, unknown>).__lastSubtitleExport = text; // dev verification hook
  };
  const addTransitionAt = (fromClipId: string | null, toClipId: string | null) => {
    const r = engine.addTransition({ fromClipId, toClipId, type: fromClipId && toClipId ? "cross-dissolve" : "fade" });
    apply(r);
    if (r.ok) selectTransition(r.transition.id);
  };
  const addShape = (choice: string) => {
    const { width, height } = engine.timeline.composition;
    const lib = GRAPHICS_LIBRARY.find((g) => g.id === choice);
    const graphic = lib ? { svg: svgSpecFromMarkup(lib.markup, Math.min(width, height) * 0.25) } : { shape: shapePreset(choice as ShapePreset, width, height) };
    const r = engine.addGraphicLayer({ graphic, atFrame: frame, durationFrames: 5 * FPS, name: lib?.label });
    apply(r);
    if (r.ok) setNotice(`Added ${lib?.label ?? choice} at ${formatTimecode(frame, FPS)}.`);
  };
  const addText = (preset: TextPreset) => {
    const { width, height } = engine.timeline.composition;
    const short = Math.min(width, height);
    const left = preset.style.textAlign === "left";
    let clipId: string | null = null;
    // Text + its motion presets are ONE undo step.
    const r = engine.transact((tl) => {
      const added = addTextLayerOp(tl, {
        text: preset.text,
        atFrame: frame,
        durationFrames: (preset.motion ? 4 : 3) * FPS,
        name: preset.label,
        // Size relative to the composition, so a preset reads the same on 1920x1080, 1080x1920 and 1080x1080.
        style: { ...preset.style, fontSize: Math.round(short * preset.size), maxWidth: Math.round(width * 0.8) },
        visual: left ? { transform: { x: Math.round(width * 0.08), y: Math.round(height * 0.8), anchorX: 0, anchorY: 0.5 } } : undefined,
      });
      clipId = added.clip.id;
      let next = added.timeline;
      for (const slot of ["in", "loop", "out"] as const) {
        const id = preset.motion?.[slot];
        if (id) next = applyMotionPreset(next, added.clip.id, slot, id);
      }
      return next;
    });
    apply(r);
    if (r.ok && clipId) {
      const id: string = clipId;
      engine.select(id);
      if (preset.motion) setMotionPicks((m) => ({ ...m, [id]: { ...preset.motion } }));
      else setEditingTextId(id);
      bump();
    }
  };
  const addSticker = (id: string) => {
    const st = STICKERS.find((x) => x.id === id);
    if (!st) return;
    const { width, height } = engine.timeline.composition;
    const r = engine.addGraphicLayer({ graphic: { svg: svgSpecFromMarkup(st.markup, Math.min(width, height) * 0.3) }, atFrame: frame, durationFrames: 4 * FPS, name: st.label });
    apply(r);
  };
  const addEmoji = (emoji: string) => {
    const { width, height } = engine.timeline.composition;
    const r = engine.addTextLayer({ text: emoji, atFrame: frame, durationFrames: 3 * FPS, name: "Emoji", style: { fontSize: Math.round(Math.min(width, height) * 0.16), fontWeight: 400 } });
    apply(r);
  };
  const importStock = async (file: File, item: StockItem) => {
    await addMediaFiles([file]);
    if (item.attribution) toast("info", <span>Credit required: <i>{item.attribution}</i> Add it to your description or end card.</span>, 15000);
  };
  const applyMotion = (clipId: string, slot: MotionSlot, presetId: string | null) => {
    const r = engine.transact((tl) => applyMotionPreset(tl, clipId, slot, presetId));
    apply(r);
    if (r.ok) setMotionPicks((m) => ({ ...m, [clipId]: { ...m[clipId], [slot]: presetId ?? undefined } }));
  };
  /** Applies a caption template to the caption track being edited — or remembers it until captions exist. */
  const pickCaptionTemplate = (presetId: string) => {
    const target = captionTargetTrack();
    if (target) {
      apply(engine.applyCaptionPreset(target, presetId));
      return;
    }
    pendingCaptionPresetRef.current = presetId;
    setPendingCaptionPreset(presetId);
    setNotice("Template chosen — it's applied as soon as captions are generated or imported.");
  };
  const captionTargetTrack = () => {
    const tl = engine.timeline;
    const sel = selectedClip?.content.kind === "caption" ? selectedClip.trackId : null;
    return sel ?? (captionTrackId && tl.tracks[captionTrackId]?.kind === "caption" ? captionTrackId : (tl.trackIds.find((t) => tl.tracks[t].kind === "caption") ?? null));
  };
  /** A freshly created caption track takes the template picked earlier. */
  const applyPendingCaptionPreset = (trackId: string) => {
    const pending = pendingCaptionPresetRef.current;
    if (!pending) return;
    pendingCaptionPresetRef.current = null;
    setPendingCaptionPreset(null);
    apply(engine.applyCaptionPreset(trackId, pending));
  };
  const addLogo = async () => {
    const logo = brand.logo;
    if (!logo || !provider) return;
    const file = new File([logo.blob], logo.name, { type: logo.type });
    const id = `brand-logo-${Date.now().toString(36)}`;
    try {
      const info = await provider.addImage(id, file);
      await registry.setFile(id, "image", file, { width: info.width, height: info.height });
      const { width: cw, height: ch } = engine.timeline.composition;
      const sc = (brand.logoSize * cw) / info.width;
      const pos = logoPosition(brand.logoCorner, info.width * sc, info.height * sc, cw, ch);
      const dur = Math.max(5 * FPS, timelineDurationFrames(engine.timeline));
      const t = engine.addTrack("image", "Logo");
      if (!t.ok) throw t.error;
      engine.reorderTrack(t.track.id, 0);
      const r = engine.insertClip(t.track.id, { kind: "image", source: { sourceId: id, label: logo.name }, durationFrames: dur }, 0, { fit: "none", transform: { x: pos.x, y: pos.y, scaleX: sc, scaleY: sc }, opacity: brand.logoOpacity });
      apply(r);
      if (r.ok) {
        engine.select(r.clip.id);
        setNotice("Logo added across the whole video — drag it on the canvas to adjust.");
      }
    } catch (e) {
      provider.remove(id);
      registry.remove(id);
      toast("error", `Couldn't add the logo: ${(e as Error).message}`);
    }
  };
  /** Recolors the selection with a brand color: text color, shape fill, or the caption track's text color. */
  const applyBrandColor = (color: string) => {
    if (!selectedClip) return;
    const c = selectedClip.content;
    if (c.kind === "text") apply(engine.updateAuthoredContent(selectedClip.id, { textStyle: { color } }));
    else if (c.kind === "graphic" && c.shape) apply(engine.updateAuthoredContent(selectedClip.id, { shape: { fill: true, fillColor: color } }));
    else if (c.kind === "caption") apply(engine.setCaptionTrackSettings(selectedClip.trackId, { style: { color } }));
  };
  const addBrandText = (kind: "heading" | "body") => {
    const primary = brand.colors[0] ?? "#7c3aed";
    addText(
      kind === "heading"
        ? { id: "brand-heading", label: "Brand title", text: brand.name, size: 0.075, style: { fontFamily: brand.headingFont, fontWeight: 800, color: "#ffffff", background: true, backgroundColor: primary, backgroundOpacity: 1, padding: 24, borderRadius: 14 } }
        : { id: "brand-body", label: "Brand text", text: "Your message here", size: 0.04, style: { fontFamily: brand.bodyFont, fontWeight: 500, color: "#ffffff", shadow: true } },
    );
  };
  const revealAsset = (assetId: string) => {
    const clip = Object.values(engine.timeline.clips).find((c) => (c.content as { source?: { sourceId: string } }).source?.sourceId === assetId);
    if (!clip) return setNotice("That file isn't on the timeline any more.");
    setSelection([clip.id]);
    seek(clip.timelineStart);
  };
  const setComposition = (patch: Partial<CompositionSettings>) => apply(engine.setCompositionSettings(patch));

  const selectedClip = selectedIds.length === 1 ? timeline.clips[selectedIds[0]] : undefined;
  const overrides = sliderDraft ? { [sliderDraft.clipId]: sliderDraft.visual } : undefined;
  const zones = safeZones(safeZonePreset, timeline.composition.width, timeline.composition.height);
  const selectedLayer = selectedClip ? resolveClipLayer(timeline, selectedClip.id, frame, { getSourceInfo: (id) => provider.getSourceInfo(id), measurer }) : null;
  const activeMaskId = activeMask && selectedClip && activeMask.clipId === selectedClip.id && selectedClip.masks?.some((m) => m.id === activeMask.maskId) ? activeMask.maskId : null;
  const locked = selectedClip ? (timeline.tracks[selectedClip.trackId]?.locked ?? false) : false;
  const keyframeControl = (clip: Clip) => (path: string) => {
    const track = clip.animation?.tracks[path];
    const key = track?.keyframes.find((k) => k.frame === frame - clip.timelineStart);
    return {
      state: (!track ? "static" : key ? "key" : "animated") as "static" | "key" | "animated",
      onToggle: () => apply(!track ? engine.setPropertyAnimated(clip.id, path, true, frame) : key ? engine.removeKeyframe(clip.id, path, key.id) : engine.addKeyframe(clip.id, path, frame)),
    };
  };

  /**
   * BACKGROUND REMOVAL (MASK_COMPOSITING_ARCHITECTURE.md §7): the existing matting engine runs on the layer's own media
   * (video: every frame of the clip), its alpha becomes a matte source, and the layer's matte points at it —
   * ONE undo step, fully non-destructive (remove/invert/combine with masks any time).
   */
  const removeBackground = async (clip: Clip) => {
    bgAbortRef.current?.abort();
    const ac = new AbortController();
    bgAbortRef.current = ac;
    setBgRemoval({ clipId: clip.id, busy: { done: 0, total: 1 }, error: null, report: null });
    // Time-left estimate from the frames done so far, timed from the first finished frame (so the model download/load doesn't skew it).
    let timing: { at: number; done: number } | null = null;
    try {
      const out = await generateClipMatte(provider, clip, {
        fps: FPS,
        signal: ac.signal,
        onProgress: (pr) => {
          let etaSec: number | undefined;
          if (pr.phase === "frames" && pr.done > 0) {
            timing ??= { at: performance.now(), done: pr.done };
            const n = pr.done - timing.done;
            if (n >= 3) etaSec = (((performance.now() - timing.at) / 1000) * (pr.total - pr.done)) / n;
          }
          setBgRemoval((s) => (s.clipId === clip.id ? { ...s, busy: { done: pr.done, total: pr.total, modelFraction: pr.modelFraction, etaSec } } : s));
        },
      });
      const sourceId = matteSourceIdFor(clip);
      const label = `Background removal (${clip.content.source?.label ?? clip.id})`;
      // The matte exists only here: it goes into the project (still: PNG; video: its matte-track chunks) before the layer points at it.
      if (out.kind === "still") {
        provider.addStill(sourceId, out.image);
        await registry.setGenerated(sourceId, "still", label, "background-removal", [{ frame: 0, bytes: await encodePng(out.image), width: out.image.width, height: out.image.height }]);
      } else {
        const chunks = out.chunks.map((c) => c.bytes);
        provider.addMatteTrack(sourceId, chunks);
        await registry.setGenerated(sourceId, "matte-track", label, "background-removal", out.chunks.map((c) => ({ frame: c.firstFrame, bytes: c.bytes, width: out.width, height: out.height })));
      }
      const current = engine.timeline.clips[clip.id];
      if (current) apply(engine.setClipVisualsAtFrame({ [clip.id]: { matte: { sourceId, invert: false, decontaminate: true } } }, frame));
      setBgRemoval({ clipId: clip.id, busy: null, error: null, report: out.report });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      setBgRemoval({ clipId: clip.id, busy: null, error: aborted ? null : (e as Error).message, report: null });
    } finally {
      if (bgAbortRef.current === ac) bgAbortRef.current = null;
    }
  };
  // Dev-only test handle: the same actions the UI buttons run (persistence tests build projects through them).
  if (import.meta.env.DEV && typeof window !== "undefined") Object.assign(((window as unknown as Record<string, Record<string, unknown>>).__compositionActions ??= {}), { apply, addMediaFiles, removeBackground, generateCaptions });

  // --- the inspector: what the selection offers ---
  const isVisual = !!selectedClip && selectedClip.content.kind !== "audio";
  const isAudible = !!selectedClip && !!audioStore && isAudibleKind(selectedClip.content.kind) && isTrimmableContent(selectedClip.content);
  const tabs: InspectorTab[] = selectedClip
    ? [
        { id: "edit", label: isVisual ? "Edit" : "Audio" },
        ...(isVisual && isAudible ? [{ id: "audio", label: "Audio" }] : []),
        ...(isVisual ? [{ id: "effects", label: "Effects" }, { id: "cutout", label: "Cutout" }] : []),
        { id: "motion", label: "Motion" },
      ]
    : [];
  const tab = tabs.some((t) => t.id === inspectorTab) ? inspectorTab : "edit";

  const audioPanel = (clip: Clip) =>
    audioStore &&
    isTrimmableContent(clip.content) && (
      <AudioPanel
        key={`audio-${clip.id}`}
        clip={clip}
        frame={frame}
        fps={FPS}
        locked={timeline.tracks[clip.trackId]?.locked ?? false}
        status={audioStore.status(clip.content.source.sourceId)}
        peakDb={(() => {
          const c = clip.content;
          const src = isTrimmableContent(c) ? audioStore.pcm(c.source.sourceId) : undefined;
          return src ? clipPeakDb(clip, src, FPS) : null;
        })()}
        volumeAtPlayhead={valueAt(clip, "audio.volume", frame - clip.timelineStart, timeline.composition)}
        gainAtPlayhead={valueAt(clip, "audio.gainDb", frame - clip.timelineStart, timeline.composition)}
        onChange={(patch) => apply(engine.setClipAudio(clip.id, patch, frame))}
        onNormalize={(target) => {
          const c = clip.content;
          const src = isTrimmableContent(c) ? audioStore.pcm(c.source.sourceId) : undefined;
          if (src) apply(engine.normalizeClipAudio(clip.id, clipPeakDb(clip, src, FPS), target));
        }}
        keyframes={keyframeControl(clip)}
      />
    );

  const transitionsPanel = (
    <TransitionsPanel
      timeline={timeline}
      transition={selectedTransition}
      clip={selectedTransition ? null : isVisual ? (selectedClip ?? null) : null}
      locked={timeline.tracks[selectedTransition?.trackId ?? selectedClip?.trackId ?? ""]?.locked ?? false}
      onAdd={addTransitionAt}
      onSelect={selectTransition}
      onUpdate={(patch) => selectedTransition && apply(engine.updateTransition(selectedTransition.id, patch))}
      onRemove={() => {
        if (!selectedTransition) return;
        apply(engine.removeTransition(selectedTransition.id));
        setSelectedTransitionId(null);
      }}
      onPreview={(start, end) => {
        setFrame(Math.max(0, start - FPS / 2));
        setPlayRange({ start, end: Math.min(duration, end + FPS / 2) });
        setPlaying(true);
      }}
    />
  );

  const inspector = (() => {
    if (selectedTransition) return <div className={FLAT_PANELS}>{transitionsPanel}</div>;
    if (selectedIds.length > 1) {
      return (
        <div className={FLAT_PANELS}>
          <MultiSelectionPanel
            layers={selectedIds.map((id) => resolveClipLayer(timeline, id, frame, { getSourceInfo: (sid) => provider.getSourceInfo(sid), measurer })).filter((l): l is ResolvedLayer => l !== null)}
            lockedClipIds={new Set(selectedIds.filter((id) => timeline.tracks[timeline.clips[id]?.trackId]?.locked))}
            composition={timeline.composition}
            safeZones={zones}
            onCommit={commitVisuals}
            onDuplicate={() => apply(engine.duplicateClipsAsLayers(selectedIds, { x: 24, y: 24 }))}
            onDelete={() => apply(engine.deleteClips(selectedIds))}
          />
        </div>
      );
    }
    if (!selectedClip) {
      return (
        <div className="flex flex-col gap-6 px-4 py-4">
          <CanvasSettings composition={timeline.composition} onChange={setComposition} brandColors={brand.colors} />
          <div className="rounded-xl bg-(--color-bg-subtle) p-3 text-caption text-(--color-text-muted)">
            <p className="mb-2 font-medium text-(--color-text)">Tips</p>
            <ul className="space-y-1.5">
              <li>Click a layer on the canvas to edit it. Shift-click or drag a marquee to select several.</li>
              <li>Drag handles to scale, the knob to rotate. Drag from the rulers to add guides.</li>
              <li>
                Press <Kbd>?</Kbd> for every keyboard shortcut.
              </li>
            </ul>
          </div>
        </div>
      );
    }
    const clip = selectedClip;
    return (
      <div className="flex flex-col">
        <div className="sticky top-0 z-10 bg-(--color-surface) px-3 pt-1 pb-2">
          <Tabs tabs={tabs} active={tab} onChange={setInspectorTab} />
        </div>
        <div className={FLAT_PANELS}>
          {tab === "edit" &&
            (isVisual ? (
              <PropertiesPanel
                key={clip.id}
                clip={clip}
                layerBox={selectedLayer?.box ?? null}
                safeZones={zones}
                composition={timeline.composition}
                locked={locked}
                draft={sliderDraft?.clipId === clip.id ? sliderDraft.visual : null}
                onDraft={(visual) => setSliderDraft(visual ? { clipId: clip.id, visual } : null)}
                onCommit={(patch) => {
                  setSliderDraft(null);
                  commitVisuals({ [clip.id]: patch });
                }}
                textLayout={selectedLayer?.content.type === "text" ? selectedLayer.content.layout : null}
                visualAtPlayhead={selectedLayer?.visual ?? null}
                keyframes={keyframeControl(clip)}
                text={
                  clip.content.kind === "text"
                    ? {
                        canPasteStyle: styleClipboard !== null,
                        onDraft: (patch) => setContentDraft(patch ? { clipId: clip.id, patch: { textStyle: patch } } : null),
                        onCommit: (patch) => {
                          setContentDraft(null);
                          apply(engine.updateAuthoredContent(clip.id, { textStyle: patch }));
                        },
                        onEditText: () => setEditingTextId(clip.id),
                        onCopyStyle: () => {
                          const c = clip.content;
                          if (c.kind === "text") setStyleClipboard(normalizeTextStyle(c.textStyle));
                          setNotice("Text style copied.");
                        },
                        onPasteStyle: () => styleClipboard && apply(engine.updateAuthoredContent(clip.id, { textStyle: styleClipboard })),
                      }
                    : undefined
                }
                graphic={
                  clip.content.kind === "graphic" && (clip.content.shape || clip.content.svg)
                    ? {
                        onDraft: (patch) => setContentDraft(patch ? { clipId: clip.id, patch } : null),
                        onCommit: (patch) => {
                          setContentDraft(null);
                          apply(engine.updateAuthoredContent(clip.id, patch));
                        },
                      }
                    : undefined
                }
              />
            ) : (
              audioPanel(clip)
            ))}
          {tab === "audio" && audioPanel(clip)}
          {tab === "effects" && (
            <EffectsPanel
              clip={clip}
              frame={frame}
              composition={timeline.composition}
              locked={locked}
              onAdd={(type) => apply(engine.addEffect(clip.id, type))}
              onRemove={(id) => apply(engine.removeEffect(clip.id, id))}
              onMove={(id, i) => apply(engine.moveEffect(clip.id, id, i))}
              onToggle={(id, on) => apply(engine.setEffectEnabled(clip.id, id, on))}
              onDraft={(id, params) => setEffectDraft(params ? { clipId: clip.id, effectId: id, params } : null)}
              onCommit={(id, params) => {
                setEffectDraft(null);
                apply(engine.updateEffectParams(clip.id, id, params, frame));
              }}
              keyframes={keyframeControl(clip)}
            />
          )}
          {tab === "cutout" && (
            <MasksPanel
              clip={
                maskDraft?.clipId === clip.id
                  ? (() => {
                      try {
                        return updateMask(timeline, maskDraft.clipId, maskDraft.maskId, maskDraft.patch, frame).clips[clip.id];
                      } catch {
                        return clip;
                      }
                    })()
                  : clip
              }
              frame={frame}
              composition={timeline.composition}
              locked={locked}
              activeMaskId={activeMaskId}
              drawing={maskDrawing?.clipId === clip.id ? maskDrawing.type : null}
              onActiveMask={(id) => setActiveMask(id ? { clipId: clip.id, maskId: id } : null)}
              onDraw={(type) => setMaskDrawing(type ? { clipId: clip.id, type } : null)}
              onAdd={(type) => {
                const r = engine.addMask(clip.id, type);
                apply(r);
                if (r.ok) setActiveMask({ clipId: clip.id, maskId: r.mask.id });
              }}
              onRemove={(id) => apply(engine.removeMask(clip.id, id))}
              onMove={(id, i) => apply(engine.moveMask(clip.id, id, i))}
              onDuplicate={(id) => {
                const r = engine.duplicateMask(clip.id, id);
                apply(r);
                if (r.ok) setActiveMask({ clipId: clip.id, maskId: r.mask.id });
              }}
              onDraft={(id, patch) => setMaskDraft(patch ? { clipId: clip.id, maskId: id, patch } : null)}
              onCommit={(id, patch) => {
                setMaskDraft(null);
                apply(engine.updateMask(clip.id, id, patch, frame));
              }}
              keyframes={keyframeControl(clip)}
              matte={clip.visual?.matte}
              matteStatus={!clip.visual?.matte ? "none" : provider.getSourceInfo(clip.visual.matte.sourceId) ? "ready" : "missing"}
              canRemoveBackground={canRemoveBackground(clip)}
              bgRemoval={bgRemoval.clipId === clip.id ? bgRemoval : { busy: null, error: null, report: null }}
              onRemoveBackground={() => void removeBackground(clip)}
              onCancelRemoveBackground={() => bgAbortRef.current?.abort()}
              onMattePatch={(matte) => commitVisuals({ [clip.id]: { matte } })}
            />
          )}
          {tab === "motion" && isVisual && (
            <MotionPresetPicker active={activeMotionSlots(timeline, clip.id)} lastPicked={motionPicks[clip.id] ?? {}} locked={locked} onPick={(slot, id) => applyMotion(clip.id, slot, id)} />
          )}
          {tab === "motion" && (
            <KeyframesPanel
              clip={clip}
              frame={frame}
              fps={FPS}
              locked={locked}
              onSeek={seek}
              onMove={(path, id, f) => apply(engine.moveKeyframe(clip.id, path, id, f))}
              onUpdate={(path, id, patch) => apply(engine.updateKeyframe(clip.id, path, id, patch))}
              onRemove={(path, id) => apply(engine.removeKeyframe(clip.id, path, id))}
            />
          )}
        </div>
      </div>
    );
  })();

  const drawer = (() => {
    const def = RAIL.find((r) => r.id === panel);
    if (!def) return null;
    let body: React.ReactNode = null;
    switch (def.id) {
      case "stock":
        body = <StockDrawer onImport={importStock} />;
        break;
      case "brand":
        body = (
          <BrandDrawer
            kit={brand}
            onChange={updateBrand}
            onAddLogo={() => void addLogo()}
            onApplyColor={applyBrandColor}
            onAddBrandText={addBrandText}
            canApplyColor={!!selectedClip && (selectedClip.content.kind === "text" || selectedClip.content.kind === "caption" || (selectedClip.content.kind === "graphic" && !!selectedClip.content.shape))}
          />
        );
        break;
      case "media":
        body = <MediaDrawer assets={registry.all()} onFiles={(f) => void addMediaFiles(f)} onPick={pickMedia} onReveal={revealAsset} />;
        break;
      case "text":
        body = <TextDrawer onAdd={addText} />;
        break;
      case "elements":
        body = <ElementsDrawer onAdd={addShape} onSticker={addSticker} onEmoji={addEmoji} />;
        break;
      case "captions": {
        const target = captionTargetTrack();
        body = (
          <>
          <CaptionTemplates activePresetId={target ? (timeline.tracks[target].caption?.presetId ?? null) : null} hasCaptions={!!target} pendingId={pendingCaptionPreset} onPick={pickCaptionTemplate} />
          <CaptionsPanel
            timeline={timeline}
            frame={frame}
            activeTrackId={selectedClip?.content.kind === "caption" ? selectedClip.trackId : captionTrackId}
            selectedClipId={selectedClip?.id ?? null}
            hasAudioSelection={!!selectedClip && isAudibleKind(selectedClip.content.kind)}
            generating={captionProgress}
            onActiveTrack={setCaptionTrackId}
            onGenerate={(o) => void generateCaptions(o)}
            onImport={(f) => void importSubtitleFile(f)}
            onExport={exportSubtitles}
            onPreset={(id, preset) => apply(engine.applyCaptionPreset(id, preset))}
            onStyle={(id, style) => apply(engine.setCaptionTrackSettings(id, { style }))}
            onTrackSettings={(id, patch) => apply(engine.setCaptionTrackSettings(id, patch))}
            onText={(id, text) => apply(text.trim() ? engine.updateCaptionText(id, text) : engine.deleteClips([id]))}
            onSpeaker={(id, sp) => apply(engine.setCaptionSpeaker(id, sp))}
            onTiming={(id, s0, e0) => apply(engine.setCaptionTiming(id, s0, e0))}
            onSelect={(id) => {
              setSelection([id]);
              setPlaying(false);
              const c = engine.timeline.clips[id];
              if (c) setFrame(c.timelineStart);
            }}
            onDelete={(id) => apply(engine.deleteClips([id]))}
            onSplit={(id) => apply(engine.splitClip(id, frame))}
            onMerge={(id) => apply(engine.mergeCaptionWithNext(id))}
          />
          </>
        );
        break;
      }
      case "audio":
        body = (
          <div className="flex flex-col gap-4 px-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed border-(--color-border-strong) px-4 py-5 transition-colors hover:border-primary-400 hover:bg-(--color-bg-subtle)">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/15 text-primary-500">
                <Music className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-body-sm font-semibold">Add music or voiceover</span>
                <span className="block text-caption text-(--color-text-muted)">MP3, WAV, M4A, OGG or FLAC — starts at the playhead</span>
              </span>
              <input
                type="file"
                multiple
                accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) void addMediaFiles(files);
                }}
              />
            </label>
            {selectedClip && isAudible ? (
              <div className={`rounded-xl border border-(--color-border) ${FLAT_PANELS}`}>{audioPanel(selectedClip)}</div>
            ) : (
              <p className="rounded-xl bg-(--color-bg-subtle) px-3 py-3 text-caption text-(--color-text-muted)">Select a video or audio clip on the timeline to set its volume, fades and gain, or to normalize it.</p>
            )}
            <div>
              <h3 className="mb-2 px-1 text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">Export the mix</h3>
              {audioStore && <AudioExportBox store={audioStore} timeline={timeline} />}
            </div>
          </div>
        );
        break;
      case "transitions":
        body =
          selectedTransition || isVisual ? (
            transitionsPanel
          ) : (
            <div className="mx-2 rounded-xl bg-(--color-bg-subtle) px-4 py-6 text-center text-caption text-(--color-text-muted)">
              <ArrowLeftRight className="mx-auto mb-2 h-6 w-6 text-(--color-text-faint)" />
              Select a clip to fade it in or out, or click <b>＋</b> where two clips meet on the timeline to add a cross-dissolve, slide, push, wipe or zoom.
            </div>
          );
        break;
      case "ai":
        body = aiSession && (
          <AIPanel
            session={aiSession}
            timeline={timeline}
            clip={selectedClip && (selectedClip.content as { source?: unknown }).source && selectedClip.content.kind !== "caption" ? selectedClip : null}
            frame={frame}
            onApply={(edit) => {
              const r = engine.transact(edit);
              apply(r);
              return r.ok ? null : r.error.message;
            }}
            onSeek={seek}
            sourceSize={(c) => {
              const id = (c.content as { source?: { sourceId: string } }).source?.sourceId;
              return id ? (provider.getSourceInfo(id) ?? null) : null;
            }}
            pictureToComp={(clipId, f) => {
              const layer = resolveClipLayer(engine.timeline, clipId, f, { getSourceInfo: (id) => provider.getSourceInfo(id), measurer });
              return layer ? (nx, ny) => applyToPoint(layer.matrix, { x: nx * layer.width, y: ny * layer.height }) : null;
            }}
            layers={timeline.trackIds.flatMap((tid) => timeline.tracks[tid].clipIds.map((cid) => ({ id: cid, label: `${timeline.tracks[tid].name}` })))}
          />
        );
        break;
      case "layers":
        body = <LayersPanel engine={engine} frame={frame} selectedIds={selectedIds} onSelect={setSelection} apply={apply} />;
        break;
    }
    return (
      <Drawer title={def.title} subtitle={def.subtitle} onClose={() => setPanel(null)}>
        {body}
      </Drawer>
    );
  })();

  const aspectNow = ASPECTS.find((a) => a.width === timeline.composition.width && a.height === timeline.composition.height);
  const iconBtn = "rounded-lg p-2 text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) hover:text-(--color-text) disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden bg-(--color-bg) text-(--color-text)"
      onDragEnter={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault(); // required, or the browser opens the file instead of dropping it here
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        const files = filesFromDataTransfer(e.dataTransfer);
        setDragDepth(0);
        if (files.length === 0) return;
        e.preventDefault();
        const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
        for (const f of subs) void importSubtitleFile(f);
        const media = files.filter((f) => !subs.includes(f));
        if (media.length) void addMediaFiles(media);
      }}
      data-testid="studio"
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-primary-400 bg-primary-500/10 backdrop-blur-sm" data-testid="drop-overlay">
          <ImagePlus className="h-8 w-8 text-primary-400" />
          <span className="text-h3 font-semibold">Drop to add to your project</span>
          <span className="text-body-sm text-(--color-text-muted)">Video joins the main track · images and audio land at the playhead · .srt/.vtt become captions</span>
        </div>
      )}

      {/* ---------------- top bar ---------------- */}
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--color-surface) px-3">
        <a href="/" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-linear-to-br from-primary-500 to-accent-500 text-white shadow-sm" aria-label="Clipbench home" title="Clipbench home">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 6.5C4 5.12 5.12 4 6.5 4h9C16.88 4 18 5.12 18 6.5v11c0 1.38-1.12 2.5-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-11Z" fill="currentColor" opacity="0.9" />
            <path d="m20 9 3-1.6v9.2L20 15" fill="currentColor" />
          </svg>
        </a>
        <span className="h-6 w-px bg-(--color-border)" aria-hidden="true" />
        {persistence ? <ProjectFileBar p={persistence} registry={registry} compact hideRecovery={showStart} onActions={onFileActions} /> : <span className="text-body-sm font-semibold">Untitled project</span>}

        <div className="relative mx-auto hidden md:block">
          <button
            type="button"
            onClick={() => setCanvasMenu((o) => !o)}
            aria-expanded={canvasMenu}
            className="flex items-center gap-2 rounded-lg border border-(--color-border) px-2.5 py-1.5 text-caption font-medium hover:bg-(--color-bg-subtle)"
            data-testid="canvas-size-button"
          >
            <AspectGlyph width={timeline.composition.width} height={timeline.composition.height} size={16} />
            {aspectNow ? `${aspectNow.label} · ${aspectNow.id === "4k" ? "4K" : aspectNow.ratio}` : `${timeline.composition.width}×${timeline.composition.height}`}
          </button>
          {canvasMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCanvasMenu(false)} aria-hidden="true" />
              <div className="absolute top-full left-1/2 z-50 mt-2 w-80 -translate-x-1/2 rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-4 shadow-lg animate-fade-in">
                <CanvasSettings composition={timeline.composition} onChange={setComposition} brandColors={brand.colors} />
              </div>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-0.5 md:ml-0">
          <button type="button" disabled={!engine.canUndo} onClick={() => (engine.undo(), player?.update(engine.timeline), bump())} className={iconBtn} aria-label="Undo" title="Undo (⌘Z)">
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" disabled={!engine.canRedo} onClick={() => (engine.redo(), player?.update(engine.timeline), bump())} className={iconBtn} aria-label="Redo" title="Redo (⇧⌘Z)">
            <Redo2 className="h-4 w-4" />
          </button>
          <span className="mx-1 h-6 w-px bg-(--color-border)" aria-hidden="true" />
          <button type="button" onClick={() => setShortcutsOpen(true)} className={iconBtn} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            <HelpCircle className="h-4 w-4" />
          </button>
          <button type="button" onClick={toggleTheme} className={iconBtn} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title="Toggle theme">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="ml-2 flex items-center gap-1.5 rounded-lg bg-linear-to-r from-primary-500 to-primary-600 px-4 py-2 text-body-sm font-semibold text-white shadow-[0_6px_20px_-6px_color-mix(in_oklch,var(--color-primary-500)_70%,transparent)] transition-transform hover:-translate-y-px hover:from-primary-400 hover:to-primary-500"
            data-testid="export-button"
            title="Export (⌘E)"
          >
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </header>

      {/* ---------------- workspace ---------------- */}
      <div className="flex min-h-0 flex-1">
        <nav className="studio-scroll flex w-[76px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-(--color-border) bg-(--color-surface) px-2 py-3" aria-label="Editor tools">
          {RAIL.map((r) => (
            <RailButton
              key={r.id}
              icon={r.icon}
              label={r.label}
              active={panel === r.id}
              onClick={() => setPanel((p) => (p === r.id ? null : r.id))}
              badge={r.id === "captions" && !!captionProgress}
            />
          ))}
        </nav>
        {drawer}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* canvas + transport */}
            <main className="relative flex min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_50%_40%,var(--color-bg-subtle),var(--color-bg)_75%)] p-3">
              <CompositionPreview
                className="min-h-0 flex-1 shadow-sm"
                timeline={timeline}
                frame={frame}
                playing={playing}
                provider={provider}
                measurer={measurer}
                selectedClipIds={selectedIds}
                onSelectionChange={setSelection}
                onCommitVisuals={commitVisuals}
                onDuplicate={(ids) => apply(engine.duplicateClipsAsLayers(ids, { x: 24, y: 24 }))}
                onDelete={(ids) => apply(engine.deleteClips(ids))}
                editingTextClipId={editingTextId}
                onEditingTextClipIdChange={setEditingTextId}
                onCommitText={(clipId, text) => {
                  const c = engine.timeline.clips[clipId]?.content;
                  if (c?.kind === "caption") {
                    // Manual caption correction on the canvas: empty removes the caption, otherwise word timings are kept/re-spread.
                    if (text.trim() === "") apply(engine.deleteClips([clipId]));
                    else if (text !== c.text) apply(engine.updateCaptionText(clipId, text));
                    return;
                  }
                  if (!c || c.kind !== "text") return;
                  // Empty text on commit removes the layer (undoable) — an invisible, unselectable empty text layer is never what the user meant.
                  if (text.trim() === "") apply(engine.deleteClips([clipId]));
                  else if (text !== c.text) apply(engine.updateAuthoredContent(clipId, { text }));
                }}
                onCommitEdits={(edits) => apply(engine.editClips(edits, frame))}
                contentDrafts={contentDraft ? { [contentDraft.clipId]: contentDraft.patch } : undefined}
                draftTimeline={(() => {
                  try {
                    if (effectDraft) return updateEffectParams(timeline, effectDraft.clipId, effectDraft.effectId, effectDraft.params, frame);
                    if (maskDraft) return updateMask(timeline, maskDraft.clipId, maskDraft.maskId, maskDraft.patch, frame);
                  } catch {
                    /* an invalid draft renders the committed state */
                  }
                  return null;
                })()}
                maskEditing={
                  selectedClip && selectedClip.content.kind !== "audio" && (selectedClip.masks?.length || maskDrawing?.clipId === selectedClip.id)
                    ? {
                        clipId: selectedClip.id,
                        activeMaskId,
                        drawing: maskDrawing?.clipId === selectedClip.id ? maskDrawing.type : null,
                        locked,
                        onSelectMask: (maskId) => setActiveMask({ clipId: selectedClip.id, maskId }),
                        onDraft: (maskId, patch) => setMaskDraft(patch ? { clipId: selectedClip.id, maskId, patch } : null),
                        onCommit: (maskId, patch) => {
                          setMaskDraft(null);
                          apply(engine.updateMask(selectedClip.id, maskId, patch, frame));
                        },
                        onCreatePath: (type, layerPoints) => {
                          setMaskDrawing(null);
                          const r = engine.addMask(selectedClip.id, type, { layerPoints });
                          apply(r);
                          if (r.ok) setActiveMask({ clipId: selectedClip.id, maskId: r.mask.id });
                        },
                        onCancelDraw: () => setMaskDrawing(null),
                      }
                    : null
                }
                onAddGuide={(axis, position) => apply(engine.addGuide(axis, position))}
                onMoveGuide={(id, position) => apply(engine.moveGuide(id, position))}
                onRemoveGuide={(id) => apply(engine.removeGuide(id))}
                visualOverrides={overrides}
                safeZonePreset={safeZonePreset}
                onSafeZonePresetChange={setSafeZonePreset}
              />
              <Transport frame={frame} duration={duration} playing={playing} onPlay={() => setPlaying((p) => !p)} onSeek={seek} />
              <ToastStack toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
            </main>

            {/* inspector */}
            <aside className="studio-scroll hidden w-[320px] shrink-0 overflow-y-auto border-l border-(--color-border) bg-(--color-surface) lg:block" aria-label="Inspector" data-testid="inspector">
              {/* A single clip's panels carry their own titles; the shell names everything else. */}
              {!selectedClip || selectedTransition ? (
                <h2 className="px-4 pt-4 pb-2 text-body font-semibold tracking-tight">{selectedTransition ? "Transition" : selectedIds.length > 1 ? `${selectedIds.length} layers` : "Canvas"}</h2>
              ) : (
                <div className="h-3" aria-hidden="true" />
              )}
              {inspector}
            </aside>
          </div>

          {/* timeline */}
          <section className="relative shrink-0 border-t border-(--color-border) bg-(--color-surface)" style={{ height: timelineH }} aria-label="Timeline area">
            <div onPointerDown={resizeTimeline} className="group absolute inset-x-0 -top-1.5 z-10 flex h-3 cursor-row-resize items-center justify-center" role="separator" aria-orientation="horizontal" aria-label="Resize timeline" title="Drag to resize the timeline">
              <span className="h-1 w-10 rounded-full bg-(--color-border-strong) opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="studio-scroll h-full overflow-auto [&>section]:rounded-none [&>section]:border-0">
              <TimelinePanel
                timeline={timeline}
                frame={frame}
                selectedClipIds={selectedIds}
                onSeek={seek}
                onSelectionChange={setSelection}
                onMoveClip={(id, start) => apply(engine.moveClip(id, start))}
                onTrimClip={(id, edge, f) => apply(engine.trimClip(id, edge, f))}
                onDelete={(ids) => apply(engine.deleteClips(ids))}
                onMoveKeyframes={(id, from, to) => apply(engine.moveKeyframesAtFrame(id, from, to))}
                selectedTransitionId={selectedTransition?.id ?? null}
                onSelectTransition={selectTransition}
                onAddTransition={addTransitionAt}
                onResizeTransition={(id, d) => apply(engine.updateTransition(id, { duration: d }))}
                onDeleteTransition={(id) => {
                  apply(engine.removeTransition(id));
                  setSelectedTransitionId(null);
                }}
                onSplit={(id, f) => apply(engine.splitClip(id, f))}
                audio={audioStore ? { state: (id) => audioStore.status(id).state, peaks: (id) => audioStore.peaks(id) } : undefined}
                onToggleTrackMute={(id) => apply(engine.setTrackMuted(id, !engine.timeline.tracks[id].muted))}
                onToggleTrackSolo={(id) => apply(engine.setTrackSolo(id, !engine.timeline.tracks[id].solo))}
              />
              {timeline.trackIds.length === 0 && (
                <button type="button" onClick={() => setPanel("media")} className="mx-auto mt-6 flex items-center gap-2 rounded-xl border border-dashed border-(--color-border-strong) px-4 py-3 text-body-sm text-(--color-text-muted) hover:border-primary-400 hover:text-(--color-text)">
                  <ImagePlus className="h-4 w-4" /> Add media to start your timeline
                </button>
              )}
            </div>
          </section>
        </div>

      </div>

      {/* ---------------- overlays ---------------- */}
      {showStart && (
        <StartScreen
          recent={recent}
          recoverable={persistence?.recoverable ?? []}
          onBlank={(width, height) => {
            // A fresh engine rather than an edit: the new project starts clean (nothing to save, nothing to undo).
            adoptEngine(new TimelineEngine(FPS, { width, height, background: "#000000" }));
            setShowStart(false);
            setPanel("media");
          }}
          onFiles={(files) => {
            matchCanvasRef.current = true;
            setShowStart(false);
            void addMediaFiles(files);
          }}
          onOpenProject={() => fileActionsRef.current?.open()}
          onOpenRecent={(m) => fileActionsRef.current?.openRecent(m)}
          onRecover={(r) => fileActionsRef.current?.recover(r)}
          onDemo={() => void loadDemo()}
          onClose={() => setShowStart(false)}
        />
      )}
      {booting && (
        <div className="absolute inset-0 z-50 flex items-center justify-center gap-2 bg-(--color-bg)/80 text-body-sm backdrop-blur-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> {booting}
        </div>
      )}
      {!smallScreenOk && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-(--color-bg) p-8 text-center md:hidden">
          <Monitor className="h-10 w-10 text-primary-400" />
          <h2 className="text-h3 font-semibold">Clipbench Studio is built for bigger screens</h2>
          <p className="max-w-sm text-body-sm text-(--color-text-muted)">Open it on a laptop or desktop for the full timeline editor. On this device, our single-purpose tools work great.</p>
          <a href="/tools" className="rounded-lg bg-primary-500 px-4 py-2 text-body-sm font-semibold text-white">
            Browse quick tools
          </a>
          <button type="button" onClick={() => setSmallScreenOk(true)} className="text-caption text-(--color-text-muted) underline">
            Continue anyway
          </button>
        </div>
      )}

      <Modal open={exportOpen} title="Export" onClose={() => setExportOpen(false)} wide keepMounted testId="export-dialog">
        <div className="flex flex-col gap-5">
          {renderDeps && (
            <div className="[&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0">
              <VideoExportPanel
                key={exportPanelKey}
                timeline={timeline}
                deps={renderDeps}
                initial={exportSettingsRef.current}
                onSettingsChange={(st) => {
                  exportSettingsRef.current = st;
                  persistence?.manager.markEdited();
                }}
              />
            </div>
          )}
          <div className="flex flex-col gap-2 border-t border-(--color-border) pt-4">
            <h3 className="text-caption font-semibold tracking-wide text-(--color-text-muted) uppercase">More exports</h3>
            {audioStore && <AudioExportBox store={audioStore} timeline={timeline} />}
            <FinalRenderBox renderer={finalRenderer} timeline={timeline} frame={frame} />
          </div>
        </div>
      </Modal>

      <Modal open={shortcutsOpen} title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)}>
        <ul className="flex flex-col divide-y divide-(--color-border)">
          {SHORTCUTS.map(([k, what]) => (
            <li key={k} className="flex items-center justify-between gap-4 py-2 text-body-sm">
              <span className="text-(--color-text-muted)">{what}</span>
              <Kbd>{k}</Kbd>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function Transport({ frame, duration, playing, onPlay, onSeek }: { frame: number; duration: number; playing: boolean; onPlay: () => void; onSeek: (f: number) => void }) {
  const btn = "rounded-lg p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--color-bg-subtle) hover:text-(--color-text)";
  return (
    <div className="mt-3 flex items-center gap-3 px-1" data-testid="transport">
      <span className="w-52 font-mono text-caption whitespace-nowrap tabular-nums text-(--color-text)" data-testid="timecode">
        {formatTimecode(frame, FPS)} <span className="text-(--color-text-faint)">/ {formatTimecode(duration, FPS)}</span>
      </span>
      <div className="mx-auto flex items-center gap-1">
        <button type="button" onClick={() => onSeek(0)} className={btn} aria-label="Go to start" title="Go to start">
          <SkipBack className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => onSeek(Math.max(0, frame - 1))} className={`${btn} font-mono text-[11px]`} aria-label="Previous frame" title="Previous frame (←)">
          −1f
        </button>
        <button type="button" onClick={onPlay} className="mx-1 grid h-10 w-10 place-items-center rounded-full bg-(--color-text) text-(--color-bg) shadow-md transition-transform hover:scale-105" aria-label={playing ? "Pause" : "Play"} title="Play/pause (Space)">
          {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
        </button>
        <button type="button" onClick={() => onSeek(Math.min(duration - 1, frame + 1))} className={`${btn} font-mono text-[11px]`} aria-label="Next frame" title="Next frame (→)">
          +1f
        </button>
        <button type="button" onClick={() => onSeek(duration - 1)} className={btn} aria-label="Go to end" title="Go to end">
          <SkipForward className="h-4 w-4" />
        </button>
      </div>
      <input type="range" min={0} max={duration - 1} step={1} value={frame} onChange={(e) => onSeek(Number(e.target.value))} className="w-52 accent-primary-500" aria-label="Playhead" />
    </div>
  );
}
