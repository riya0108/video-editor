import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, Lock, Volume2, VolumeX, FileAudio, Pause, Play, Redo2, SkipBack, SkipForward, Undo2, Download, Loader2, ImagePlus, Type } from "lucide-react";
import CompositionPreview from "./CompositionPreview";
import { TimelineEngine, type EditResult } from "../../../../lib/timeline/engine";
import { formatTimecode, secondsToFrames } from "../../../../lib/timeline/time-model";
import { timelineDurationFrames, type CompositionSettings, type TimelineModel } from "../../../../lib/timeline/model";
import { deserializeTimeline, serializeTimeline } from "../../../../lib/timeline/serialize";
import { isTrimmableContent } from "../../../../lib/timeline/clip";
import { clipTimelineEnd, type Clip } from "../../../../lib/timeline/clip";
import { defaultClipVisual, type ClipVisual, type ClipVisualPatch } from "../../../../lib/timeline/visual";
import { normalizeTextStyle, type TextStyle } from "../../../../lib/timeline/text-style";
import TextPanel, { type TextPanelProps } from "./TextPanel";
import GraphicsPanel from "./GraphicsPanel";
import { normalizeShapeSpec, normalizeSvgSpec, shapePreset, type ShapePreset } from "../../../../lib/timeline/shape-style";
import { GRAPHICS_LIBRARY } from "../../../../lib/graphics/library";
import { svgSpecFromMarkup } from "../../../../lib/graphics/svg";
import type { AuthoredContentPatch } from "../../../../lib/timeline/operations";
import TimelinePanel from "./TimelinePanel";
import { classifyImport, describeDecodeFailure, dragHasFiles, filesFromDataTransfer } from "../../../../lib/composition/media-import";
import { createCanvasTextMeasurer, FinalRenderer, MediaFrameProvider, FinalRenderError, resolveClipLayer, safeZones, type BoxSize, type ResolvedLayer, type TextLayout, type SafeZone, type SafeZonePreset } from "../../../../lib/composition";
import TransformPanel, { type KeyframeControl } from "./TransformPanel";
import KeyframesPanel from "./KeyframesPanel";
import EffectsPanel from "./EffectsPanel";
import TransitionsPanel from "./TransitionsPanel";
import { transitionWindow } from "../../../../lib/transitions/model";
import { updateEffectParams, updateMask } from "../../../../lib/timeline/operations";
import MasksPanel, { type BackgroundRemovalState } from "./MasksPanel";
import { canRemoveBackground, generateClipMatte, matteSourceIdFor } from "../../../../lib/composition/matte-generation";
import type { MaskPatch } from "../../../../lib/masks/model";
import MultiSelectionPanel from "./MultiSelectionPanel";
import AudioPanel from "./AudioPanel";
import CaptionsPanel, { type GenerateOptions } from "./CaptionsPanel";
import { parseSubtitles, toSrt, toVtt } from "../../../../lib/captions/subtitle-io";
import { segmentWords, SEGMENT_PROFILES, toMono16k } from "../../../../lib/captions/segmenter";
import { captionCuesOf } from "../../../../lib/timeline/operations";
import type { CaptionProgress } from "../../../../lib/captions/auto-caption";
import { AudioSourceStore } from "../../../../lib/audio/source-store";
import { AudioPlaybackEngine } from "../../../../lib/audio/playback";
import { clipPeakDb, encodeWav16, mixTimeline } from "../../../../lib/audio/engine-core";
import { AUDIO_ROLES, guessAudioRole, isAudibleKind } from "../../../../lib/audio/model";
import { valueAt } from "../../../../lib/animation/properties";

/**
 * COMPOSITION PLAYGROUND — internal page that drives the composition &
 * preview engine with a real multi-track timeline (video, transparent image,
 * matted overlay, vector shape, text) so every feature can be exercised and
 * verified end-to-end. The editing UI here is intentionally plain; the
 * engine (src/lib/composition) and CompositionPreview are the deliverables.
 */

const FPS = 30;
const STORAGE_KEY = "clipbench.compositionPlayground.project";
const DEMO_VIDEO_URL = "/videos/hero-phone-demo.mp4";

const COMPOSITION_PRESETS: { label: string; width: number; height: number }[] = [
  { label: "1920×1080 (16:9)", width: 1920, height: 1080 },
  { label: "1080×1920 (9:16)", width: 1080, height: 1920 },
  { label: "1080×1080 (1:1)", width: 1080, height: 1080 },
  { label: "3840×2160 (4K)", width: 3840, height: 2160 },
];

const BACKGROUNDS: { label: string; value: string }[] = [
  { label: "Black", value: "#000000" },
  { label: "White", value: "#ffffff" },
  { label: "Slate", value: "#1e293b" },
  { label: "Transparent", value: "transparent" },
];


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

export default function CompositionPlaygroundPanel() {
  const provider = useMemo(() => (typeof window === "undefined" ? null : new MediaFrameProvider()), []);
  const measurer = useMemo(() => (typeof window === "undefined" ? null : createCanvasTextMeasurer()), []);
  const finalRenderer = useMemo(() => (provider && measurer ? new FinalRenderer(provider, measurer) : null), [provider, measurer]);
  // AUDIO (Phase 11): decoded sources + waveform peaks, and the Web Audio player whose clock drives playback.
  const audioStore = useMemo(() => (typeof window === "undefined" ? null : new AudioSourceStore()), []);
  const player = useMemo(() => (audioStore ? new AudioPlaybackEngine((id) => audioStore.buffer(id)) : null), [audioStore]);
  const engineRef = useRef<TimelineEngine | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [dragDepth, setDragDepth] = useState(0);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sliderDraft, setSliderDraft] = useState<{ clipId: string; visual: ClipVisual } | null>(null);
  const [safeZonePreset, setSafeZonePreset] = useState<SafeZonePreset>("off");
  const [notice, setNotice] = useState<string | null>(null);
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

  // --- build the demo project once ---
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    (async () => {
      try {
        const { durationSec } = await provider.addVideo("demo-video", DEMO_VIDEO_URL, FPS);
        // The video's own soundtrack (decoded in the background; a video without one is simply silent).
        void audioStore?.add("demo-video", DEMO_VIDEO_URL, "Demo video", { video: true });
        provider.addStill("logo", makeLogoAsset());
        provider.addStill("matte", makeMatteAsset());
        if (cancelled) return;
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
        engineRef.current = engine;
        bump();
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => () => provider?.dispose(), [provider]);
  useEffect(() => () => player?.dispose(), [player]);
  // Waveforms / decode status arriving re-render the timeline and inspector.
  useEffect(() => audioStore?.onChange(() => bump()), [audioStore]);

  const engine = engineRef.current;
  const timeline = engine?.timeline ?? null;
  const duration = timeline ? Math.max(1, timelineDurationFrames(timeline)) : 1;

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
      setEditError(r.ok ? null : r.error.message);
      // Edits while playing (volume, mute, trim, move...) are heard immediately: re-schedule from the current position.
      if (r.ok) player?.update(r.timeline);
      bump();
    },
    [player],
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

  // Debug handle for in-browser verification (dev only).
  useEffect(() => {
    if (import.meta.env.DEV && engine) (window as unknown as Record<string, unknown>).__composition = { engine, provider, finalRenderer, measurer, audioStore, player };
  }, [engine, provider, finalRenderer, measurer, audioStore, player]);

  // --- keyboard: undo/redo/play ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!engine || (e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
        player?.update(engine.timeline);
        bump();
      } else if (e.key === "k" || (e.key === " " && !(e.target as HTMLElement)?.closest("[role=application]"))) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

  /**
   * Adds picked/dropped files as layers: each on its own new track at the
   * FRONT, starting at the PLAYHEAD (so it's visible right away — adding at
   * 0:00 made a short clip invisible whenever the playhead was past its end),
   * selected, with a confirmation. Every rejection or decode failure is
   * reported by file name with a concrete fix; one bad file doesn't stop the rest.
   */
  const addMediaFiles = async (files: File[]) => {
    if (!engine || !provider) return;
    const errors: string[] = [];
    const added: string[] = [];
    const relinked: string[] = [];
    const at = frame;
    for (const file of files) {
      const c = classifyImport(file);
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
              else if (st.warning) errors.push(st.warning);
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
          r = engine.insertClip(t.track.id, { kind: "audio", source: { sourceId: id, label: file.name, sourceDurationFrames: n }, sourceInFrame: 0, sourceOutFrame: n }, at);
          if (r.ok) engine.setClipAudio(r.clip.id, { role });
        } else if (c.kind === "svg") {
          URL.revokeObjectURL(url);
          const { width, height } = engine.timeline.composition;
          const svg = svgSpecFromMarkup(await file.text(), Math.min(width, height) * 0.5);
          r = engine.addGraphicLayer({ graphic: { svg }, atFrame: at, durationFrames: 5 * FPS, name: file.name });
        } else if (c.kind === "video") {
          const { durationSec } = await provider.addVideo(id, url, FPS);
          void audioStore?.add(id, url, file.name, { video: true });
          const n = Math.max(1, secondsToFrames(durationSec, FPS, "floor"));
          const t = engine.addTrack("overlay", file.name);
          if (!t.ok) throw t.error;
          engine.reorderTrack(t.track.id, 0);
          r = engine.insertClip(t.track.id, { kind: "overlay", source: { sourceId: id, label: file.name, sourceDurationFrames: n }, sourceInFrame: 0, sourceOutFrame: n }, at, { transform: { scaleX: 0.5, scaleY: 0.5 } });
        } else {
          await provider.addImage(id, file);
          URL.revokeObjectURL(url); // images are decoded to a bitmap; the URL isn't needed
          const t = engine.addTrack("image", file.name);
          if (!t.ok) throw t.error;
          engine.reorderTrack(t.track.id, 0);
          r = engine.insertClip(t.track.id, { kind: "image", source: { sourceId: id, label: file.name }, durationFrames: 5 * FPS }, at, { transform: { scaleX: 0.5, scaleY: 0.5 } });
        }
        if (!r.ok) throw r.error;
        engine.select(r.clip.id);
        added.push(file.name);
      } catch (e) {
        URL.revokeObjectURL(url);
        provider.remove(id);
        audioStore?.remove(id);
        errors.push(describeDecodeFailure(file, c.kind, e));
      }
    }
    setImportErrors(errors);
    if (added.length > 0 || relinked.length > 0) {
      setNotice(
        [added.length ? `Added ${added.join(", ")} at ${formatTimecode(at, FPS)}.` : "", relinked.length ? `Relinked missing audio: ${relinked.join(", ")}.` : ""].filter(Boolean).join(" "),
      );
    }
    bump();
  };

  if (loadError) return <p className="rounded-lg border border-danger-500/40 bg-danger-500/10 p-4 text-body-sm">Could not load the demo project: {loadError}</p>;
  if (!engine || !timeline || !provider || !measurer || !finalRenderer) {
    return (
      <div className="flex h-96 items-center justify-center gap-2 text-body-sm text-(--color-text-muted)">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading demo media…
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
        setNotice(`Generated ${r.clips.length} captions (${words.length} words) from ${(endSec - startSec).toFixed(1)} s of audio.`);
      }
    } catch (e) {
      setNotice(`Captioning failed: ${(e as Error).message}`);
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
  const selectedClip = selectedIds.length === 1 ? timeline.clips[selectedIds[0]] : undefined;
  const overrides = sliderDraft ? { [sliderDraft.clipId]: sliderDraft.visual } : undefined;
  const zones = safeZones(safeZonePreset, timeline.composition.width, timeline.composition.height);
  const selectedLayer = selectedClip ? resolveClipLayer(timeline, selectedClip.id, frame, { getSourceInfo: (id) => provider.getSourceInfo(id), measurer }) : null;
  const activeMaskId = activeMask && selectedClip && activeMask.clipId === selectedClip.id && selectedClip.masks?.some((m) => m.id === activeMask.maskId) ? activeMask.maskId : null;

  /**
   * BACKGROUND REMOVAL (MASK_COMPOSITING_ARCHITECTURE.md §7): the existing matting engine runs on the layer's own media
   * (video: sampled frames across the clip), its alpha becomes a matte source, and the layer's matte points at it —
   * ONE undo step, fully non-destructive (remove/invert/combine with masks any time).
   */
  const removeBackground = async (clip: Clip) => {
    bgAbortRef.current?.abort();
    const ac = new AbortController();
    bgAbortRef.current = ac;
    setBgRemoval({ clipId: clip.id, busy: { done: 0, total: 1 }, error: null, report: null });
    try {
      const out = await generateClipMatte(provider, clip, {
        fps: FPS,
        signal: ac.signal,
        onProgress: (pr) => setBgRemoval((s) => (s.clipId === clip.id ? { ...s, busy: { done: pr.done, total: pr.total, modelFraction: pr.modelFraction } } : s)),
      });
      const sourceId = matteSourceIdFor(clip);
      if (out.kind === "still") provider.addStill(sourceId, out.image);
      else provider.addFrameSequence(sourceId, out.frames);
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

  return (
    <div
      className="relative flex flex-col gap-4"
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
        if (files.length === 0) return;
        e.preventDefault();
        setDragDepth(0);
        void addMediaFiles(files);
      }}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10 text-body font-semibold text-primary-700 dark:text-primary-200" data-testid="drop-overlay">
          Drop images or videos to add them at the playhead
        </div>
      )}
      <ProjectBar
        composition={timeline.composition}
        canUndo={engine.canUndo}
        canRedo={engine.canRedo}
        onUndo={() => (engine.undo(), player?.update(engine.timeline), bump())}
        onRedo={() => (engine.redo(), player?.update(engine.timeline), bump())}
        onChange={(patch) => apply(engine.setCompositionSettings(patch))}
        onAddShape={(choice) => {
          const { width, height } = engine.timeline.composition;
          const lib = GRAPHICS_LIBRARY.find((g) => g.id === choice);
          const graphic = lib ? { svg: svgSpecFromMarkup(lib.markup, Math.min(width, height) * 0.25) } : { shape: shapePreset(choice as ShapePreset, width, height) };
          const r = engine.addGraphicLayer({ graphic, atFrame: frame, durationFrames: 5 * FPS, name: lib?.label });
          apply(r);
          if (r.ok) setNotice(`Added ${lib?.label ?? choice} at ${formatTimecode(frame, FPS)} — selected and on top.`);
        }}
        onAddText={() => {
          const { width, height } = engine.timeline.composition;
          const r = engine.addTextLayer({
            text: "Type something...",
            atFrame: frame,
            durationFrames: 3 * FPS,
            // Size relative to the composition, so "Add text" reads the same on 1920x1080, 1080x1920 and 1080x1080.
            style: { fontSize: Math.round(Math.min(width, height) * 0.07), maxWidth: Math.round(width * 0.8) },
          });
          apply(r);
          if (r.ok) setEditingTextId(r.clip.id);
        }}
        onSave={() => {
          try {
            // engine.timeline, not the rendered `timeline` snapshot: save must capture the engine's present state even if a render is pending.
            const current = engine.timeline;
            localStorage.setItem(STORAGE_KEY, serializeTimeline(current));
            setNotice(`Saved ${Object.keys(current.clips).length} clips at ${new Date().toLocaleTimeString()}.`);
          } catch (e) {
            setNotice(`Save failed: ${(e as Error).message}`);
          }
        }}
        onLoad={() => {
          try {
            const json = localStorage.getItem(STORAGE_KEY);
            if (!json) return setNotice("Nothing saved yet.");
            const loaded = deserializeTimeline(json);
            // Media isn't embedded in a project — list any source this session can't resolve (e.g. an upload from an earlier session).
            const missing = new Set<string>();
            for (const c of Object.values(loaded.clips)) {
              const id = isTrimmableContent(c.content) ? c.content.source.sourceId : c.content.source?.sourceId;
              // Audio sources live in the audio store (decoded PCM), pictures in the frame provider.
              const present = c.content.kind === "audio" ? audioStore?.status(id ?? "").state === "ready" : !!(id && provider.getSourceInfo(id));
              if (id && !present) missing.add(c.content.source?.label ?? id);
              if (c.visual?.matte && !provider.getSourceInfo(c.visual.matte.sourceId)) missing.add(c.visual.matte.sourceId);
            }
            engine.loadTimeline(loaded);
            setFrame((f) => Math.min(f, Math.max(0, timelineDurationFrames(loaded) - 1)));
            setNotice(missing.size ? `Loaded. Missing media (re-add to relink): ${[...missing].join(", ")}` : "Loaded.");
            bump();
          } catch (e) {
            setNotice(`Load failed: ${(e as Error).message}`);
          }
        }}
        onAddMedia={addMediaFiles}
      />
      {notice && <p className="rounded-md bg-(--color-bg-subtle) px-3 py-2 text-caption" role="status">{notice}</p>}
      {editError && <p className="rounded-md bg-warning-500/10 px-3 py-2 text-caption text-warning-700 dark:text-warning-300">Edit rejected: {editError}</p>}
      {importErrors.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-caption" data-testid="import-errors">
          <ul className="flex-1 list-disc space-y-0.5 pl-4">
            {importErrors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setImportErrors([])} className="rounded px-1.5 hover:bg-danger-500/10" aria-label="Dismiss upload errors">
            ✕
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-2">
          <CompositionPreview
            className="h-[min(62vh,640px)]"
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
                    locked: timeline.tracks[selectedClip.trackId]?.locked ?? false,
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
          <Transport frame={frame} duration={duration} playing={playing} onPlay={() => setPlaying((p) => !p)} onSeek={(f) => (setPlaying(false), setFrame(f))} />
          <TimelinePanel
            timeline={timeline}
            frame={frame}
            selectedClipIds={selectedIds}
            onSeek={(f) => (setPlaying(false), setFrame(f))}
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
          <FinalRenderBox renderer={finalRenderer} timeline={timeline} frame={frame} />
          {audioStore && <AudioExportBox store={audioStore} timeline={timeline} />}
        </div>

        <div className="flex flex-col gap-4">
          <LayersPanel engine={engine} frame={frame} selectedIds={selectedIds} onSelect={setSelection} apply={apply} />
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
          {selectedClip && audioStore && isAudibleKind(selectedClip.content.kind) && isTrimmableContent(selectedClip.content) && (
            <AudioPanel
              key={`audio-${selectedClip.id}`}
              clip={selectedClip}
              frame={frame}
              fps={FPS}
              locked={timeline.tracks[selectedClip.trackId]?.locked ?? false}
              status={audioStore.status(selectedClip.content.source.sourceId)}
              peakDb={(() => {
                const src = audioStore.pcm(selectedClip.content.source.sourceId);
                return src ? clipPeakDb(selectedClip, src, FPS) : null;
              })()}
              volumeAtPlayhead={valueAt(selectedClip, "audio.volume", frame - selectedClip.timelineStart, timeline.composition)}
              gainAtPlayhead={valueAt(selectedClip, "audio.gainDb", frame - selectedClip.timelineStart, timeline.composition)}
              onChange={(patch) => apply(engine.setClipAudio(selectedClip.id, patch, frame))}
              onNormalize={(target) => {
                const c = selectedClip.content;
                const src = isTrimmableContent(c) ? audioStore.pcm(c.source.sourceId) : undefined;
                if (src) apply(engine.normalizeClipAudio(selectedClip.id, clipPeakDb(selectedClip, src, FPS), target));
              }}
              keyframes={(path) => {
                const track = selectedClip.animation?.tracks[path];
                const key = track?.keyframes.find((k) => k.frame === frame - selectedClip.timelineStart);
                return {
                  state: !track ? "static" : key ? "key" : "animated",
                  onToggle: () =>
                    apply(!track ? engine.setPropertyAnimated(selectedClip.id, path, true, frame) : key ? engine.removeKeyframe(selectedClip.id, path, key.id) : engine.addKeyframe(selectedClip.id, path, frame)),
                };
              }}
            />
          )}
          {(selectedTransition || (selectedClip && selectedClip.content.kind !== "audio")) && (
            <TransitionsPanel
              timeline={timeline}
              transition={selectedTransition}
              clip={selectedTransition ? null : (selectedClip ?? null)}
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
          )}
          {selectedClip && selectedClip.content.kind !== "audio" && (
            <MasksPanel
              clip={maskDraft?.clipId === selectedClip.id ? (() => {
                try {
                  return updateMask(timeline, maskDraft.clipId, maskDraft.maskId, maskDraft.patch, frame).clips[selectedClip.id];
                } catch {
                  return selectedClip;
                }
              })() : selectedClip}
              frame={frame}
              composition={timeline.composition}
              locked={timeline.tracks[selectedClip.trackId]?.locked ?? false}
              activeMaskId={activeMaskId}
              drawing={maskDrawing?.clipId === selectedClip.id ? maskDrawing.type : null}
              onActiveMask={(id) => setActiveMask(id ? { clipId: selectedClip.id, maskId: id } : null)}
              onDraw={(type) => setMaskDrawing(type ? { clipId: selectedClip.id, type } : null)}
              onAdd={(type) => {
                const r = engine.addMask(selectedClip.id, type);
                apply(r);
                if (r.ok) setActiveMask({ clipId: selectedClip.id, maskId: r.mask.id });
              }}
              onRemove={(id) => apply(engine.removeMask(selectedClip.id, id))}
              onMove={(id, i) => apply(engine.moveMask(selectedClip.id, id, i))}
              onDuplicate={(id) => {
                const r = engine.duplicateMask(selectedClip.id, id);
                apply(r);
                if (r.ok) setActiveMask({ clipId: selectedClip.id, maskId: r.mask.id });
              }}
              onDraft={(id, patch) => setMaskDraft(patch ? { clipId: selectedClip.id, maskId: id, patch } : null)}
              onCommit={(id, patch) => {
                setMaskDraft(null);
                apply(engine.updateMask(selectedClip.id, id, patch, frame));
              }}
              keyframes={(path) => {
                const track = selectedClip.animation?.tracks[path];
                const key = track?.keyframes.find((k) => k.frame === frame - selectedClip.timelineStart);
                return {
                  state: !track ? "static" : key ? "key" : "animated",
                  onToggle: () =>
                    apply(!track ? engine.setPropertyAnimated(selectedClip.id, path, true, frame) : key ? engine.removeKeyframe(selectedClip.id, path, key.id) : engine.addKeyframe(selectedClip.id, path, frame)),
                };
              }}
              matte={selectedClip.visual?.matte}
              matteStatus={!selectedClip.visual?.matte ? "none" : provider.getSourceInfo(selectedClip.visual.matte.sourceId) ? "ready" : "missing"}
              canRemoveBackground={canRemoveBackground(selectedClip)}
              bgRemoval={bgRemoval.clipId === selectedClip.id ? bgRemoval : { busy: null, error: null, report: null }}
              onRemoveBackground={() => void removeBackground(selectedClip)}
              onCancelRemoveBackground={() => bgAbortRef.current?.abort()}
              onMattePatch={(matte) => commitVisuals({ [selectedClip.id]: { matte } })}
            />
          )}
          {selectedClip && selectedClip.content.kind !== "audio" && (
            <EffectsPanel
              clip={selectedClip}
              frame={frame}
              composition={timeline.composition}
              locked={timeline.tracks[selectedClip.trackId]?.locked ?? false}
              onAdd={(type) => apply(engine.addEffect(selectedClip.id, type))}
              onRemove={(id) => apply(engine.removeEffect(selectedClip.id, id))}
              onMove={(id, i) => apply(engine.moveEffect(selectedClip.id, id, i))}
              onToggle={(id, on) => apply(engine.setEffectEnabled(selectedClip.id, id, on))}
              onDraft={(id, params) => setEffectDraft(params ? { clipId: selectedClip.id, effectId: id, params } : null)}
              onCommit={(id, params) => {
                setEffectDraft(null);
                apply(engine.updateEffectParams(selectedClip.id, id, params, frame));
              }}
              keyframes={(path) => {
                const track = selectedClip.animation?.tracks[path];
                const key = track?.keyframes.find((k) => k.frame === frame - selectedClip.timelineStart);
                return {
                  state: !track ? "static" : key ? "key" : "animated",
                  onToggle: () =>
                    apply(!track ? engine.setPropertyAnimated(selectedClip.id, path, true, frame) : key ? engine.removeKeyframe(selectedClip.id, path, key.id) : engine.addKeyframe(selectedClip.id, path, frame)),
                };
              }}
            />
          )}
          {selectedClip && (
            <KeyframesPanel
              clip={selectedClip}
              frame={frame}
              fps={FPS}
              locked={timeline.tracks[selectedClip.trackId]?.locked ?? false}
              onSeek={(f) => (setPlaying(false), setFrame(f))}
              onMove={(path, id, f) => apply(engine.moveKeyframe(selectedClip.id, path, id, f))}
              onUpdate={(path, id, patch) => apply(engine.updateKeyframe(selectedClip.id, path, id, patch))}
              onRemove={(path, id) => apply(engine.removeKeyframe(selectedClip.id, path, id))}
            />
          )}
          {selectedClip && selectedClip.content.kind !== "audio" ? (
            <PropertiesPanel
              key={selectedClip.id}
              clip={selectedClip}
              layerBox={selectedLayer?.box ?? null}
              safeZones={zones}
              composition={timeline.composition}
              locked={timeline.tracks[selectedClip.trackId]?.locked ?? false}
              draft={sliderDraft?.clipId === selectedClip.id ? sliderDraft.visual : null}
              onDraft={(visual) => setSliderDraft(visual ? { clipId: selectedClip.id, visual } : null)}
              onCommit={(patch) => {
                setSliderDraft(null);
                commitVisuals({ [selectedClip.id]: patch });
              }}
              textLayout={selectedLayer?.content.type === "text" ? selectedLayer.content.layout : null}
              visualAtPlayhead={selectedLayer?.visual ?? null}
              keyframes={(path) => {
                const track = selectedClip.animation?.tracks[path];
                const local = frame - selectedClip.timelineStart;
                const key = track?.keyframes.find((k) => k.frame === local);
                return {
                  state: !track ? "static" : key ? "key" : "animated",
                  onToggle: () =>
                    apply(!track ? engine.setPropertyAnimated(selectedClip.id, path, true, frame) : key ? engine.removeKeyframe(selectedClip.id, path, key.id) : engine.addKeyframe(selectedClip.id, path, frame)),
                };
              }}
              text={
                selectedClip.content.kind === "text"
                  ? {
                      canPasteStyle: styleClipboard !== null,
                      onDraft: (patch) => setContentDraft(patch ? { clipId: selectedClip.id, patch: { textStyle: patch } } : null),
                      onCommit: (patch) => {
                        setContentDraft(null);
                        apply(engine.updateAuthoredContent(selectedClip.id, { textStyle: patch }));
                      },
                      onEditText: () => setEditingTextId(selectedClip.id),
                      onCopyStyle: () => {
                        const c = selectedClip.content;
                        if (c.kind === "text") setStyleClipboard(normalizeTextStyle(c.textStyle));
                        setNotice("Text style copied.");
                      },
                      onPasteStyle: () => styleClipboard && apply(engine.updateAuthoredContent(selectedClip.id, { textStyle: styleClipboard })),
                    }
                  : undefined
              }
              graphic={
                selectedClip.content.kind === "graphic" && (selectedClip.content.shape || selectedClip.content.svg)
                  ? {
                      onDraft: (patch) => setContentDraft(patch ? { clipId: selectedClip.id, patch } : null),
                      onCommit: (patch) => {
                        setContentDraft(null);
                        apply(engine.updateAuthoredContent(selectedClip.id, patch));
                      },
                    }
                  : undefined
              }
            />
          ) : selectedIds.length > 1 ? (
            <MultiSelectionPanel
              layers={selectedIds.map((id) => resolveClipLayer(timeline, id, frame, { getSourceInfo: (sid) => provider.getSourceInfo(sid), measurer })).filter((l): l is ResolvedLayer => l !== null)}
              lockedClipIds={new Set(selectedIds.filter((id) => timeline.tracks[timeline.clips[id]?.trackId]?.locked))}
              composition={timeline.composition}
              safeZones={zones}
              onCommit={commitVisuals}
              onDuplicate={() => apply(engine.duplicateClipsAsLayers(selectedIds, { x: 24, y: 24 }))}
              onDelete={() => apply(engine.deleteClips(selectedIds))}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-(--color-border) p-4 text-caption text-(--color-text-muted)">
              Click a layer in the preview (or the list above) to edit it; Shift-click or drag a marquee to select several. On the canvas: drag to move, handles to scale, the knob to rotate, the crosshair to move the anchor; C toggles crop handles; ⌘D duplicates. Drag from the rulers to add guides.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProjectBar({
  composition,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onChange,
  onAddMedia,
  onSave,
  onLoad,
  onAddText,
  onAddShape,
}: {
  composition: CompositionSettings;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onChange: (patch: Partial<CompositionSettings>) => void;
  onAddMedia: (files: File[]) => void;
  onSave: () => void;
  onLoad: () => void;
  onAddText: () => void;
  onAddShape: (choice: string) => void;
}) {
  const presetIndex = COMPOSITION_PRESETS.findIndex((p) => p.width === composition.width && p.height === composition.height);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-body-sm">
      <label className="flex items-center gap-2">
        <span className="text-(--color-text-muted)">Composition</span>
        <select
          value={presetIndex}
          onChange={(e) => {
            const p = COMPOSITION_PRESETS[Number(e.target.value)];
            onChange({ width: p.width, height: p.height });
          }}
          className="rounded border border-(--color-border) bg-(--color-surface) px-2 py-1"
        >
          {presetIndex === -1 && <option value={-1}>{composition.width}×{composition.height}</option>}
          {COMPOSITION_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-(--color-text-muted)">Background</span>
        <select value={composition.background} onChange={(e) => onChange({ background: e.target.value })} className="rounded border border-(--color-border) bg-(--color-surface) px-2 py-1">
          {BACKGROUNDS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <select
        aria-label="Add shape or graphic"
        value=""
        onChange={(e) => {
          if (e.target.value) onAddShape(e.target.value);
          e.target.value = "";
        }}
        className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 font-medium"
      >
        <option value="">＋ Add shape…</option>
        <optgroup label="Shapes">
          <option value="rect">Rectangle</option>
          <option value="rounded-rect">Rounded rectangle</option>
          <option value="circle">Circle</option>
          <option value="ellipse">Ellipse</option>
          <option value="polygon">Polygon</option>
          <option value="line">Line</option>
          <option value="arrow">Arrow</option>
        </optgroup>
        <optgroup label="Graphics (SVG)">
          {GRAPHICS_LIBRARY.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </optgroup>
      </select>
      <button type="button" onClick={onAddText} className="flex items-center gap-1.5 rounded-md border border-(--color-border) px-2 py-1 font-medium hover:bg-(--color-bg-subtle)" title="Add a text layer at the playhead">
        <Type className="h-4 w-4" /> Add text
      </button>
      <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)">
        <ImagePlus className="h-4 w-4" /> Add media <span className="text-(--color-text-faint)">(or drop files)</span>
        <input
          type="file"
          multiple
          // Audio/HEIC are selectable on purpose: picking one shows WHY it can't be added, instead of the file being silently greyed out in the picker.
          accept="image/*,video/*,.mov,.heic,.heif,audio/*"
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onAddMedia(files);
          }}
        />
      </label>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onSave} className="rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)">
          Save
        </button>
        <button type="button" onClick={onLoad} className="mr-2 rounded-md border border-(--color-border) px-2 py-1 hover:bg-(--color-bg-subtle)">
          Load
        </button>
        <button type="button" disabled={!canUndo} onClick={onUndo} className="rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40" aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" disabled={!canRedo} onClick={onRedo} className="rounded p-1.5 hover:bg-(--color-bg-subtle) disabled:opacity-40" aria-label="Redo" title="Redo (⇧⌘Z)">
          <Redo2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Transport({ frame, duration, playing, onPlay, onSeek }: { frame: number; duration: number; playing: boolean; onPlay: () => void; onSeek: (f: number) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2">
      <button type="button" onClick={() => onSeek(Math.max(0, frame - 1))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label="Previous frame">
        <SkipBack className="h-4 w-4" />
      </button>
      <button type="button" onClick={onPlay} className="rounded-full bg-primary-500 p-2 text-white hover:bg-primary-600" aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <button type="button" onClick={() => onSeek(Math.min(duration - 1, frame + 1))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label="Next frame">
        <SkipForward className="h-4 w-4" />
      </button>
      <input type="range" min={0} max={duration - 1} step={1} value={frame} onChange={(e) => onSeek(Number(e.target.value))} className="mx-2 flex-1 accent-primary-500" aria-label="Playhead" />
      <span className="font-mono text-caption tabular-nums text-(--color-text-muted)" data-testid="timecode">
        {formatTimecode(frame, FPS)} · f{frame}
      </span>
    </div>
  );
}

function LayersPanel({ engine, frame, selectedIds, onSelect, apply }: { engine: TimelineEngine; frame: number; selectedIds: string[]; onSelect: (ids: string[]) => void; apply: (r: EditResult) => void }) {
  const tl = engine.timeline;
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">Layers <span className="font-normal text-(--color-text-muted)">(top = front)</span></h2>
      <ul className="divide-y divide-(--color-border)">
        {tl.trackIds.map((trackId, index) => {
          const track = tl.tracks[trackId];
          const clips = track.clipIds.map((id) => tl.clips[id]);
          const active = clips.find((c) => frame >= c.timelineStart && frame < clipTimelineEnd(c)) ?? clips[0];
          const selected = clips.some((c) => selectedIds.includes(c.id));
          return (
            <li key={trackId} className={`flex items-center gap-1 px-2 py-1.5 text-caption ${selected ? "bg-primary-500/10" : ""}`}>
              {track.kind === "audio" ? (
                // Audio has nothing to show or hide — its toggle is mute.
                <button type="button" onClick={() => apply(engine.setTrackMuted(trackId, !track.muted))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label={track.muted ? "Unmute track" : "Mute track"}>
                  {track.muted ? <VolumeX className="h-3.5 w-3.5 text-(--color-text-faint)" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
              ) : (
                <button type="button" onClick={() => apply(engine.setTrackVisible(trackId, !track.visible))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label={track.visible ? "Hide layer" : "Show layer"}>
                  {track.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5 text-(--color-text-faint)" />}
                </button>
              )}
              <button type="button" onClick={() => apply(engine.setTrackLocked(trackId, !track.locked))} className={`rounded p-1 hover:bg-(--color-bg-subtle) ${track.locked ? "" : "text-(--color-text-faint)"}`} aria-label={track.locked ? "Unlock layer" : "Lock layer"}>
                <Lock className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  if (!active) return;
                  // Shift-click toggles, like on the canvas.
                  if (e.shiftKey) onSelect(selectedIds.includes(active.id) ? selectedIds.filter((id) => id !== active.id) : [...selectedIds, active.id]);
                  else onSelect([active.id]);
                }}
                className="min-w-0 flex-1 truncate text-left hover:underline" title={track.name}>
                {track.name} <span className="text-(--color-text-faint)">· {track.kind}</span>
              </button>
              <button type="button" disabled={index === 0} onClick={() => apply(engine.reorderTrack(trackId, index - 1))} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Bring forward">
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button type="button" disabled={index === tl.trackIds.length - 1} onClick={() => apply(engine.reorderTrack(trackId, index + 1))} className="rounded p-1 hover:bg-(--color-bg-subtle) disabled:opacity-30" aria-label="Send backward">
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Text content (text clips only) + the reusable TransformPanel. */
/** Text (TextPanel, text layers only) + the reusable TransformPanel — one control per model field. */
function PropertiesPanel({
  clip,
  layerBox,
  textLayout,
  composition,
  safeZones: zones,
  locked,
  draft,
  onDraft,
  onCommit,
  text,
  graphic,
  visualAtPlayhead,
  keyframes,
}: {
  clip: Clip;
  layerBox: BoxSize | null;
  textLayout: TextLayout | null;
  composition: CompositionSettings;
  safeZones: readonly SafeZone[];
  locked: boolean;
  draft: ClipVisual | null;
  onDraft: (v: ClipVisual | null) => void;
  onCommit: (patch: ClipVisualPatch) => void;
  text?: Omit<TextPanelProps, "text" | "style" | "layout" | "opacity" | "locked" | "onCommitOpacity">;
  graphic?: { onDraft: (patch: AuthoredContentPatch | null) => void; onCommit: (patch: AuthoredContentPatch) => void };
  /** The visual as evaluated at the playhead (animation applied) — what the fields must show. */
  visualAtPlayhead: ClipVisual | null;
  keyframes?: (path: string) => KeyframeControl;
}) {
  // Show what's on screen at the playhead (animated values), not the stored base.
  const stored = visualAtPlayhead ?? clip.visual ?? defaultClipVisual(composition.width, composition.height);
  const c = clip.content;
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)">
      <h2 className="flex items-center justify-between border-b border-(--color-border) px-3 py-2 text-body-sm font-semibold">
        {c.kind === "text" ? "Text" : c.kind === "graphic" && (c.shape || c.svg) ? "Graphic" : "Transform"} <span className="font-normal text-(--color-text-muted)">{c.kind}{locked ? " · locked" : ""}{draft ? " · editing" : ""}</span>
      </h2>
      <div className="flex flex-col gap-3 p-3">
        {c.kind === "text" && text && (
          <>
            <TextPanel {...text} text={c.text ?? ""} style={normalizeTextStyle(c.textStyle)} layout={textLayout} opacity={stored.opacity} locked={locked} onCommitOpacity={(opacity) => onCommit({ opacity })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        {c.kind === "graphic" && graphic && c.shape && (
          <>
            <GraphicsPanel kind="shape" spec={normalizeShapeSpec(c.shape)} locked={locked} onDraft={(p) => graphic.onDraft(p ? { shape: p } : null)} onCommit={(p) => graphic.onCommit({ shape: p })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        {c.kind === "graphic" && graphic && c.svg && (
          <>
            <GraphicsPanel kind="svg" spec={normalizeSvgSpec(c.svg) ?? c.svg} locked={locked} onDraft={(p) => graphic.onDraft(p ? { svg: p } : null)} onCommit={(p) => graphic.onCommit({ svg: p })} />
            <h3 className="border-t border-(--color-border) pt-3 text-body-sm font-semibold">Transform</h3>
          </>
        )}
        <TransformPanel
          visual={stored}
          box={layerBox}
          fitLocked={c.kind === "text" || (c.kind === "graphic" && (!!c.shape || !!c.svg))}
          composition={composition}
          safeZones={zones}
          locked={locked}
          onDraft={onDraft}
          onCommit={onCommit}
          keyframes={keyframes}
        />
      </div>
    </section>
  );
}

function FinalRenderBox({ renderer, timeline, frame }: { renderer: FinalRenderer; timeline: TimelineModel; frame: number }) {
  const [state, setState] = useState<{ status: "idle" | "rendering" | "done" | "error"; url?: string; ms?: number; size?: string; message?: string }>({ status: "idle" });
  useEffect(() => () => void (state.url && URL.revokeObjectURL(state.url)), [state.url]);

  const render = async () => {
    setState({ status: "rendering" });
    const t0 = performance.now();
    try {
      const { canvas } = await renderer.renderFrame(timeline, frame);
      const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
      setState({ status: "done", url: URL.createObjectURL(blob), ms: performance.now() - t0, size: `${canvas.width}×${canvas.height}` });
    } catch (e) {
      setState({ status: "error", message: e instanceof FinalRenderError ? e.message : `Unexpected: ${(e as Error).message}` });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption">
      <button type="button" onClick={render} disabled={state.status === "rendering"} className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
        {state.status === "rendering" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        Render this frame (final quality)
      </button>
      <span className="text-(--color-text-muted)">Separate renderer: full composition resolution, exact source frame, high-quality resampling — independent of the preview setting.</span>
      {state.status === "done" && state.url && (
        <span className="flex items-center gap-2" data-testid="final-render-result">
          <img src={state.url} alt="Final render" className="h-10 rounded border border-(--color-border) bg-checkerboard" />
          <span className="tabular-nums">{state.size} · {state.ms!.toFixed(0)} ms</span>
          <a href={state.url} download={`frame-${frame}.png`} className="underline">Download PNG</a>
        </span>
      )}
      {state.status === "error" && <span className="text-danger-600">{state.message}</span>}
    </div>
  );
}

/**
 * AUDIO EXPORT (AUDIO_ENGINE_ARCHITECTURE.md §8): renders the whole timeline's mix with the offline mixer — the same
 * segments and gain envelopes playback schedules — to a 16-bit stereo WAV. Refuses (with the list) when an audio clip's
 * source is missing or failed to decode, rather than exporting a mix with silent holes; warns when the mix clips.
 */
function AudioExportBox({ store, timeline }: { store: AudioSourceStore; timeline: TimelineModel }) {
  const [state, setState] = useState<{ status: "idle" | "rendering" | "done" | "error"; url?: string; message?: string; info?: string }>({ status: "idle" });
  useEffect(() => () => void (state.url && URL.revokeObjectURL(state.url)), [state.url]);
  const run = async () => {
    setState({ status: "rendering" });
    await new Promise((r) => setTimeout(r, 0));
    const problems = Object.values(timeline.clips)
      .filter((c) => c.content.kind === "audio" && isTrimmableContent(c.content))
      .map((c) => ({ c, st: store.status((c.content as { source: { sourceId: string } }).source.sourceId) }))
      .filter((x) => x.st.state !== "ready");
    if (problems.length > 0) {
      const names = problems.map((p) => `${(p.c.content as { source: { label?: string; sourceId: string } }).source.label ?? p.c.id} (${p.st.state})`);
      return setState({ status: "error", message: `Can't export: ${problems.length} audio clip(s) have no playable audio — ${names.join(", ")}. Re-add or remove them first.` });
    }
    const t0 = performance.now();
    const durationSec = Math.max(1, timelineDurationFrames(timeline)) / timeline.frameRate;
    const mix = mixTimeline(timeline, (id) => store.pcm(id), { sampleRate: store.sampleRate, startSec: 0, endSec: durationSec });
    const wav = encodeWav16(mix.channels, mix.sampleRate);
    const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
    const peakDb = mix.peak > 0 ? 20 * Math.log10(mix.peak) : -Infinity;
    setState({
      status: "done",
      url,
      info: `${durationSec.toFixed(2)} s · ${(mix.sampleRate / 1000).toFixed(1)} kHz stereo · peak ${Number.isFinite(peakDb) ? peakDb.toFixed(1) : "−∞"} dBFS · ${(performance.now() - t0).toFixed(0)} ms${mix.clippedSamples ? ` · ⚠ ${mix.clippedSamples} samples clipped — lower some volumes` : ""}`,
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) px-3 py-2 text-caption">
      <button type="button" onClick={run} disabled={state.status === "rendering"} className="flex items-center gap-1.5 rounded-md bg-(--color-text) px-3 py-1.5 font-medium text-(--color-bg) disabled:opacity-50">
        {state.status === "rendering" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileAudio className="h-3.5 w-3.5" />}
        Export audio mix (WAV)
      </button>
      <span className="text-(--color-text-muted)">Every audible track mixed with volume, gain, fades, automation, mute/solo — the same mix playback plays.</span>
      {state.status === "done" && state.url && (
        <span className="flex items-center gap-2" data-testid="audio-export-result">
          <audio src={state.url} controls className="h-8" />
          <span className="tabular-nums">{state.info}</span>
          <a href={state.url} download="mix.wav" className="underline">Download WAV</a>
        </span>
      )}
      {state.status === "error" && <span className="text-danger-600" role="alert">{state.message}</span>}
    </div>
  );
}
