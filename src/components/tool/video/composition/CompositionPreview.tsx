import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Magnet, Maximize, Minimize, Minus, MousePointer2, Plus, Ruler, Scan } from "lucide-react";
import type { Guide, TimelineModel } from "../../../../lib/timeline/model";
import type { ClipVisual, ClipVisualPatch } from "../../../../lib/timeline/visual";
import { applyVisualPatch, type TextStyle } from "../../../../lib/timeline/visual";
import { editClips, type AuthoredContentPatch, type ClipEdit } from "../../../../lib/timeline/operations";
import { textResize } from "../../../../lib/text/text-transform";
import { graphicResize, type GraphicSpec } from "../../../../lib/graphics/graphic-transform";
import { sharedSvgRasterizer } from "../../../../lib/composition/svg-raster";
import TextEditOverlay from "./TextEditOverlay";
import {
  buildSnapTargets,
  boxToComp,
  centerAtZoom,
  constrainViewport,
  cropFromHandle,
  drawOverlay,
  fitToScreen,
  handleCursor,
  hitGuide,
  hitRuler,
  hitSelectionHandle,
  hitTest,
  isCornerHandle,
  moveAnchorTo,
  normalizeAngle,
  pan,
  presentPreview,
  previewProfile,
  PreviewRenderer,
  PREVIEW_QUALITY_LABELS,
  resizeFromHandle,
  rotateFromPointer,
  RULER_SIZE,
  safeZones,
  screenToComposition,
  selectionLayout,
  snapAngle,
  snapPoint,
  snapRect,
  snapValue,
  unionBounds,
  rectFromPoints,
  resolveClipLayer,
  marqueeHits,
  stepZoom,
  translateVisual,
  visibleBounds,
  zoomAt,
  ANCHOR_PRESETS,
  MAX_ZOOM,
  MIN_ZOOM,
  type BoxSize,
  type FrameProvider,
  type HandleId,
  type Point,
  type Rect,
  type PreviewQuality,
  type PreviewRenderResult,
  type ResolvedFrame,
  type ResolvedLayer,
  type SafeZonePreset,
  type SnapLine,
  type SnapTargets,
  type TextMeasurer,
  type TransformMode,
  type ViewportState,
} from "../../../../lib/composition";

/**
 * COMPOSITION PREVIEW — displays the current timeline state and is the
 * on-canvas transform tool.
 *
 * Rendering: PreviewRenderer draws the composition at preview resolution;
 * presentPreview() puts it on screen through the viewport; drawOverlay()
 * adds rulers, guides, safe zones, snap indicators and the selection's
 * handles in screen space (never into a render).
 *
 * Every gesture renders live through a transient visual override and
 * commits ONE undoable edit on release — a drag, a held arrow key, or a
 * scrub is one undo step, not hundreds. Transforms only ever change numbers
 * in ClipVisual; the source is re-drawn from scratch each frame, so nothing
 * is ever rasterized or resampled twice (see transform-tools.ts).
 *
 * Selection: click selects; Shift-click toggles a layer in/out of the
 * selection; drag on empty canvas draws a marquee (Shift adds). (⌘/Ctrl is
 * deliberately NOT a selection modifier — it suspends snapping mid-drag.) Dragging any
 * selected layer moves the whole selection as one undo step. Handles appear
 * when exactly one layer is selected; a multi-selection shows its group box.
 *
 * Mouse (transform mode): drag layer = move (Shift locks axis); corner
 * handles = scale keeping aspect (Shift = free); edge handles = one axis
 * (Shift = keep aspect); Alt = scale about the anchor; knob or just outside a
 * corner = rotate (Shift = 15° steps); drag the anchor crosshair to move the
 * pivot without moving the layer (snaps to corners/edges/center).
 * Crop mode (C): handles crop in place. Rulers: drag out a guide; drag a guide
 * to move it, back onto a ruler to delete it. Hold ⌘/Ctrl to suspend
 * snapping. Pan: middle-drag or Space-drag (or wheel); zoom with
 * ⌘/Ctrl+wheel or pinch.
 *
 * Keyboard (canvas focused): arrows move 1px (Shift 10px); Alt+↑/↓ scale
 * ±1% (Shift 10%); [ / ] rotate ∓1° (Shift 15°); H / V flip; C crop mode;
 * Esc exits crop mode, then deselects; ⌘D duplicate; Delete removes; ⌘A
 * selects all; F fit, 1 = 100%, +/− zoom. Every key edit applies to the whole
 * selection.
 */

export interface CompositionPreviewProps {
  timeline: TimelineModel;
  frame: number;
  playing: boolean;
  provider: FrameProvider & { onFrameReady?: (cb: () => void) => () => void };
  measurer: TextMeasurer;
  /** Current selection (TimelineEngine's Selection, as ids). Handles appear when exactly one layer is selected; several show a group box. */
  selectedClipIds: readonly string[];
  onSelectionChange: (clipIds: string[]) => void;
  /** Called once per finished gesture with every changed clip — one undo step, never per pointermove. */
  onCommitVisuals: (patches: Record<string, ClipVisualPatch>) => void;
  /** ⌘D. */
  onDuplicate?: (clipIds: string[]) => void;
  /** Delete / Backspace. */
  onDelete?: (clipIds: string[]) => void;
  /** TEXT EDIT MODE (controlled): the text clip being edited inline, or null. Entered by double-click / Enter. */
  editingTextClipId?: string | null;
  onEditingTextClipIdChange?: (clipId: string | null) => void;
  /** End of an inline edit session — one undo step. The parent decides what empty text means. */
  onCommitText?: (clipId: string, text: string) => void;
  /** Combined content + visual commits (text-box resize changes both). One undo step. */
  onCommitEdits?: (edits: Record<string, ClipEdit>) => void;
  /** Transient content drafts from the parent (e.g. typography inspector mid-scrub) — rendered, never committed. */
  contentDrafts?: Readonly<Record<string, AuthoredContentPatch>>;
  onAddGuide: (axis: Guide["axis"], position: number) => void;
  onMoveGuide: (guideId: string, position: number) => void;
  onRemoveGuide: (guideId: string) => void;
  /** Extra transient overrides from the parent (e.g. a numeric field mid-scrub). */
  visualOverrides?: Readonly<Record<string, ClipVisual>>;
  /** Shared view options, so a parent panel (alignment-to-safe-zone) can see what's shown. */
  safeZonePreset: SafeZonePreset;
  onSafeZonePresetChange: (preset: SafeZonePreset) => void;
  initialQuality?: PreviewQuality;
  className?: string;
}

type ClipDrag = { clipId: string; start: ClipVisual; box: BoxSize; targets: SnapTargets | null; moved: boolean };
type Drag =
  | { type: "pan"; lastX: number; lastY: number }
  | { type: "move"; members: { clipId: string; start: ClipVisual; box: BoxSize }[]; targets: SnapTargets | null; moved: boolean; startX: number; startY: number }
  | { type: "marquee"; from: Point; additive: boolean; base: string[]; moved: boolean }
  | (ClipDrag & { type: "resize"; handle: HandleId; text?: { text: string; style: TextStyle }; graphic?: GraphicSpec })
  | (ClipDrag & { type: "crop"; handle: HandleId })
  | (ClipDrag & { type: "rotate"; startComp: Point })
  | (ClipDrag & { type: "anchor" })
  | { type: "guide"; guideId: string | null; axis: Guide["axis"]; position: number; targets: SnapTargets | null };

const SNAP_TOLERANCE_PX = 6;
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
)}") 10 10, crosshair`;

function readCssColor(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function sameVisual(a: ClipVisual, b: ClipVisual): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function CompositionPreview({
  timeline,
  frame,
  playing,
  provider,
  measurer,
  selectedClipIds,
  onSelectionChange,
  onCommitVisuals,
  onDuplicate,
  onDelete,
  editingTextClipId = null,
  onEditingTextClipIdChange,
  onCommitText,
  onCommitEdits,
  contentDrafts,
  onAddGuide,
  onMoveGuide,
  onRemoveGuide,
  visualOverrides,
  safeZonePreset,
  onSafeZonePresetChange,
  initialQuality = "auto",
  className = "",
}: CompositionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useMemo(() => new PreviewRenderer(provider, measurer), [provider, measurer]);

  const comp = timeline.composition;
  const [view, setView] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<ViewportState>({ zoom: 0.25, panX: 0, panY: 0 });
  const [fitMode, setFitMode] = useState(true);
  const [quality, setQuality] = useState<PreviewQuality>(initialQuality);
  const [fullscreen, setFullscreen] = useState(false);
  const [mode, setMode] = useState<TransformMode>("transform");
  const [snapping, setSnapping] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [draft, setDraft] = useState<Record<string, ClipVisual> | null>(null);
  const [guideDraft, setGuideDraft] = useState<{ guideId: string | null; axis: Guide["axis"]; position: number } | null>(null);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** Live text/graphic resize (content size + position), rendered through a draft timeline until release. */
  const [textDraft, setTextDraft] = useState<Record<string, ClipEdit> | null>(null);
  const [cursor, setCursor] = useState("default");
  const [stats, setStats] = useState<PreviewRenderResult | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const dragRef = useRef<Drag | null>(null);
  const keyDraftRef = useRef<{ starts: Record<string, ClipVisual>; visuals: Record<string, ClipVisual> } | null>(null);
  const resolvedRef = useRef<ResolvedFrame | null>(null);
  const dirtyRef = useRef(true);
  const colorsRef = useRef({ pasteboard: "#e4e4e7", accent: "#6366f1" });

  const zones = useMemo(() => safeZones(safeZonePreset, comp.width, comp.height), [safeZonePreset, comp.width, comp.height]);
  const guides = useMemo(() => {
    let list: Guide[] = timeline.guides;
    if (guideDraft?.guideId) list = list.map((g) => (g.id === guideDraft.guideId ? { ...g, position: guideDraft.position } : g));
    if (guideDraft && !guideDraft.guideId) list = [...list, { id: "__new__", axis: guideDraft.axis, position: guideDraft.position }];
    return list;
  }, [timeline.guides, guideDraft]);

  // --- view size + sticky fit ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setView({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    colorsRef.current = { pasteboard: readCssColor(el, "--color-bg-subtle", "#e4e4e7"), accent: readCssColor(el, "--color-primary-500", "#6366f1") };
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Padding clears the rulers so a fitted composition is never under them.
    if (fitMode && view.width > 0 && view.height > 0) setViewport(fitToScreen(comp, view, RULER_SIZE + 16));
  }, [fitMode, view, comp.width, comp.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyViewport = useCallback(
    (next: ViewportState) => {
      setFitMode(false);
      setViewport(constrainViewport(next, comp, view));
    },
    [comp, view],
  );

  // --- fullscreen ---
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current?.parentElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const host = containerRef.current?.parentElement;
    if (!host) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void host.requestFullscreen().then(() => setFitMode(true));
  }, []);

  // --- render loop ---
  /**
   * What the canvas renders: the committed timeline with any uncommitted
   * content drafts applied through the SAME pure edit op that a commit will
   * use (so the preview can't show something the commit wouldn't produce).
   * An invalid draft just renders the committed state.
   */
  const renderTimeline = useMemo(() => {
    const edits: Record<string, ClipEdit> = {};
    for (const [id, c] of Object.entries(contentDrafts ?? {})) edits[id] = { content: c };
    for (const [id, e] of Object.entries(textDraft ?? {})) edits[id] = { ...edits[id], ...e, content: { ...edits[id]?.content, ...e.content } };
    if (Object.keys(edits).length === 0) return timeline;
    try {
      return editClips(timeline, edits);
    } catch {
      return timeline;
    }
  }, [timeline, contentDrafts, textDraft]);
  const resolveCtx = useMemo(() => ({ getSourceInfo: (id: string) => provider.getSourceInfo(id), measurer }), [provider, measurer]);
  const editingLayerFor = useCallback(
    (text: string) => {
      if (!editingTextClipId || !renderTimeline.clips[editingTextClipId]) return null;
      try {
        const tl = editClips(renderTimeline, { [editingTextClipId]: { content: { text } } });
        // Resolve as if fully visible (the canvas copy is hidden while editing).
        return resolveClipLayer(tl, editingTextClipId, frame, resolveCtx);
      } catch {
        return null;
      }
    },
    [editingTextClipId, renderTimeline, frame, resolveCtx],
  );
  const overrides = useMemo(() => {
    const o: Record<string, ClipVisual> = { ...visualOverrides, ...draft };
    // While editing, hide the canvas copy — the DOM editor shows the live text (no double image).
    if (editingTextClipId) {
      const layer = resolveClipLayer(renderTimeline, editingTextClipId, frame, resolveCtx);
      if (layer) o[editingTextClipId] = { ...(o[editingTextClipId] ?? layer.visual), opacity: 0 };
    }
    return o;
  }, [visualOverrides, draft, editingTextClipId, renderTimeline, frame, resolveCtx]);
  const latest = useRef({ timeline: renderTimeline, frame, playing, quality, viewport, view, selectedClipIds, hoverId, overrides, mode, guides, showGuides, zones, snapLines, guideDraft, marquee, editing: editingTextClipId });
  latest.current = { timeline: renderTimeline, frame, playing, quality, viewport, view, selectedClipIds, hoverId, overrides, mode, guides, showGuides, zones, snapLines, guideDraft, marquee, editing: editingTextClipId };
  useEffect(() => {
    dirtyRef.current = true;
  });
  useEffect(() => provider.onFrameReady?.(() => (dirtyRef.current = true)), [provider]);
  // An SVG raster finishing at a new size (after zoom/resize) must trigger a redraw.
  useEffect(() => sharedSvgRasterizer().onReady(() => (dirtyRef.current = true)), []);
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    const onFonts = () => {
      measurer.invalidate?.();
      dirtyRef.current = true;
    };
    document.fonts.addEventListener("loadingdone", onFonts);
    return () => document.fonts.removeEventListener("loadingdone", onFonts);
  }, [measurer]);

  useEffect(() => {
    let raf = 0;
    let statsTick = 0;
    let statsKey = "";
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = latest.current;
      const canvas = canvasRef.current;
      if (!canvas || s.view.width === 0 || (!dirtyRef.current && !s.playing)) return;
      dirtyRef.current = false;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(s.view.width * dpr);
      const bh = Math.round(s.view.height * dpr);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const result = renderer.render(s.timeline, s.frame, previewProfile(s.quality, s.viewport.zoom, dpr, s.playing), s.overrides);
      resolvedRef.current = result.resolved;
      const byId = (id: string | null) => (id ? result.resolved.layers.find((l) => l.clipId === id) ?? null : null);
      const composition = { width: result.resolved.width, height: result.resolved.height };
      presentPreview(ctx, renderer.output, {
        viewport: s.viewport,
        composition,
        view: s.view,
        devicePixelRatio: dpr,
        checkerboard: s.timeline.composition.background === "transparent",
        pasteboard: colorsRef.current.pasteboard,
      });
      const selLayers = s.selectedClipIds.map(byId).filter((l): l is ResolvedLayer => l !== null);
      const sel = selLayers.length === 1 ? selLayers[0] : null;
      drawOverlay(ctx, {
        viewport: s.viewport,
        view: s.view,
        composition,
        devicePixelRatio: dpr,
        accent: colorsRef.current.accent,
        hover: byId(s.hoverId),
        selection: sel && !s.editing ? { layer: sel, mode: s.mode, locked: !!s.timeline.tracks[sel.trackId]?.locked } : null,
        multiSelection: selLayers.length > 1 ? selLayers : null,
        marquee: s.marquee,
        guides: s.guides,
        showGuides: s.showGuides || !!s.guideDraft,
        highlightGuideId: s.guideDraft?.guideId ?? (s.guideDraft ? "__new__" : null),
        safeZones: s.zones,
        snapLines: s.snapLines,
        rulers: true,
      });
      const key = `${result.width}x${result.height}:${result.stats.skipped.length}`;
      if (key !== statsKey || ++statsTick % 30 === 0) {
        statsKey = key;
        setStats(result);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);

  // --- helpers ---
  const screenPoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const toComp = (p: Point) => screenToComposition(p, viewport);
  /** The single selected on-screen layer (handles only exist for exactly one). */
  const selectedLayer = (): ResolvedLayer | null =>
    selectedClipIds.length === 1 ? resolvedRef.current?.layers.find((l) => l.clipId === selectedClipIds[0]) ?? null : null;
  /** Every selected layer that's on screen at this frame. */
  const selectedLayers = (): ResolvedLayer[] => (resolvedRef.current?.layers ?? []).filter((l) => selectedClipIds.includes(l.clipId));
  const isLocked = (layer: ResolvedLayer) => !!timeline.tracks[layer.trackId]?.locked;
  const threshold = () => SNAP_TOLERANCE_PX / viewport.zoom;
  const snapOn = (e: { metaKey: boolean; ctrlKey: boolean }) => snapping && !e.metaKey && !e.ctrlKey;

  /** Snap targets for a gesture on `exclude`: canvas, visible guides, shown safe zones, every other on-screen layer. */
  const targetsFor = (exclude: string | readonly string[] | null): SnapTargets =>
    buildSnapTargets({
      composition: comp,
      guides: showGuides ? timeline.guides : [],
      safeRects: zones.map((z) => z.rect),
      layerBounds: (resolvedRef.current?.layers ?? []).filter((l) => !(Array.isArray(exclude) ? exclude.includes(l.clipId) : l.clipId === exclude)).map((l) => l.bounds),
    });

  /** Commits every changed member of a gesture as ONE edit (one undo step). Unchanged members — and a gesture that changed nothing — commit nothing. */
  const commitDrafts = (starts: Readonly<Record<string, ClipVisual>>, ends: Readonly<Record<string, ClipVisual>> | null) => {
    const patches: Record<string, ClipVisualPatch> = {};
    for (const [id, start] of Object.entries(starts)) {
      const end = ends?.[id];
      if (end && !sameVisual(start, end)) patches[id] = { transform: end.transform, crop: end.crop };
    }
    if (Object.keys(patches).length > 0) onCommitVisuals(patches);
  };

  // --- pointer ---
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    containerRef.current?.focus({ preventScroll: true });
    const sp = screenPoint(e);
    const cp = toComp(sp);
    const target = e.currentTarget;
    const capture = () => {
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort; the gesture works without it while the pointer stays over the canvas */
      }
    };

    if (e.button === 1 || spaceHeld) {
      dragRef.current = { type: "pan", lastX: e.clientX, lastY: e.clientY };
      return capture();
    }
    if (e.button !== 0) return;

    // 1. Rulers -> new guide.
    const ruler = hitRuler(sp);
    if (ruler) {
      const axis = ruler === "top" ? "y" : "x";
      dragRef.current = { type: "guide", guideId: null, axis, position: axis === "x" ? cp.x : cp.y, targets: null };
      setGuideDraft({ guideId: null, axis, position: axis === "x" ? cp.x : cp.y });
      return capture();
    }

    // 2. Selected layer's handles.
    const sel = selectedLayer();
    if (sel && !isLocked(sel)) {
      const hit = hitSelectionHandle(selectionLayout(sel, viewport, mode), sp);
      if (hit) {
        const base: ClipDrag = { clipId: sel.clipId, start: sel.visual, box: sel.box, targets: targetsFor(sel.clipId), moved: false };
        const clipContent = timeline.clips[sel.clipId]?.content;
        const text = sel.content.type === "text" && clipContent?.kind === "text" ? { text: clipContent.text ?? "", style: sel.content.style } : undefined;
        // Shapes/SVG resize their OWN size (strokes, radii, arrowheads keep their authored size; SVG re-rasterizes sharp) — see lib/graphics/graphic-transform.ts.
        const graphic: GraphicSpec | undefined = sel.content.type === "shape" ? { kind: "shape", shape: sel.content.shape } : sel.content.type === "svg" ? { kind: "svg", svg: sel.content.svg } : undefined;
        if (hit.type === "handle") dragRef.current = mode === "crop" ? { ...base, type: "crop", handle: hit.handle } : { ...base, type: "resize", handle: hit.handle, text, graphic };
        else if (hit.type === "anchor") dragRef.current = { ...base, type: "anchor" };
        else dragRef.current = { ...base, type: "rotate", startComp: cp };
        return capture();
      }
    }

    // 3. Guides.
    if (showGuides) {
      const g = hitGuide(timeline.guides, viewport, sp);
      if (g) {
        dragRef.current = { type: "guide", guideId: g.id, axis: g.axis, position: g.position, targets: null };
        setGuideDraft({ guideId: g.id, axis: g.axis, position: g.position });
        return capture();
      }
    }

    // 4. Layers.
    const hit = resolvedRef.current ? hitTest(resolvedRef.current, cp) : null;
    // Shift only: ⌘/Ctrl is reserved for "suspend snapping" during a drag — if it also toggled selection, pressing ⌘ to place a layer precisely would DESELECT it instead of moving it.
    const toggle = e.shiftKey;
    if (hit && toggle) {
      const next = selectedClipIds.includes(hit.clipId) ? selectedClipIds.filter((id) => id !== hit.clipId) : [...selectedClipIds, hit.clipId];
      setMode("transform");
      onSelectionChange(next);
      return;
    }
    if (hit) {
      // Pressing on a member of the current selection keeps it (so the group can be dragged); anything else selects just this layer.
      const group = selectedClipIds.includes(hit.clipId) ? selectedClipIds : [hit.clipId];
      if (!selectedClipIds.includes(hit.clipId)) {
        setMode("transform");
        onSelectionChange([hit.clipId]);
      }
      const members = (resolvedRef.current?.layers ?? [])
        .filter((l) => group.includes(l.clipId) && !isLocked(l))
        .map((l) => ({ clipId: l.clipId, start: l.visual, box: l.box }));
      if (members.length > 0) {
        dragRef.current = { type: "move", members, targets: targetsFor(group), moved: false, startX: e.clientX, startY: e.clientY };
        return capture();
      }
      return;
    }

    // 5. Empty space -> marquee selection (Shift/⌘ adds to the current selection).
    dragRef.current = { type: "marquee", from: cp, additive: toggle, base: toggle ? [...selectedClipIds] : [], moved: false };
    if (!toggle) onSelectionChange([]);
    capture();
  };

  const updateHoverCursor = (sp: Point) => {
    if (spaceHeld) return setCursor("grab");
    if (hitRuler(sp)) return setCursor(hitRuler(sp) === "top" ? "row-resize" : "col-resize");
    const sel = selectedLayer();
    if (sel && !isLocked(sel)) {
      const hit = hitSelectionHandle(selectionLayout(sel, viewport, mode), sp);
      if (hit?.type === "handle") return setCursor(handleCursor(sel.visual, sel.box, hit.handle));
      if (hit?.type === "knob" || hit?.type === "rotate-zone") return setCursor(ROTATE_CURSOR);
      if (hit?.type === "anchor") return setCursor("crosshair");
    }
    const g = showGuides ? hitGuide(timeline.guides, viewport, sp) : null;
    if (g) return setCursor(g.axis === "x" ? "col-resize" : "row-resize");
    const layer = resolvedRef.current ? hitTest(resolvedRef.current, toComp(sp)) : null;
    if (layer?.clipId !== hoverId) setHoverId(layer?.clipId ?? null);
    setCursor(layer ? (isLocked(layer) ? "not-allowed" : "move") : "default");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const sp = screenPoint(e);
    const d = dragRef.current;
    if (!d) return updateHoverCursor(sp);
    const cp = toComp(sp);
    const snap = snapOn(e);
    const t = threshold();

    switch (d.type) {
      case "pan":
        applyViewport(pan(viewport, e.clientX - d.lastX, e.clientY - d.lastY));
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        return;

      case "guide": {
        let position = d.axis === "x" ? cp.x : cp.y;
        if (snap) {
          d.targets ??= targetsFor(null);
          const s = snapValue(d.axis, position, d.targets, t);
          position = s.value;
          setSnapLines(s.lines);
        } else setSnapLines([]);
        d.position = Math.round(position * 100) / 100;
        setGuideDraft({ guideId: d.guideId, axis: d.axis, position: d.position });
        return;
      }

      case "move": {
        let dx = (e.clientX - d.startX) / viewport.zoom;
        let dy = (e.clientY - d.startY) / viewport.zoom;
        if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 3) return; // a click, not a drag
        d.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let lines: SnapLine[] = [];
        if (snap && d.targets) {
          // The group snaps as one rect: the union of every member's visible bounds after the raw move.
          const union = unionBounds(d.members.map((m) => visibleBounds(translateVisual(m.start, dx, dy), m.box)));
          if (union) {
            const s = snapRect(union, d.targets, t);
            // An axis locked by Shift must stay locked — don't let snapping pull it.
            const lockX = e.shiftKey && dx === 0;
            const lockY = e.shiftKey && dy === 0;
            dx += lockX ? 0 : s.dx;
            dy += lockY ? 0 : s.dy;
            lines = s.lines.filter((l) => (l.axis === "x" ? !lockX : !lockY));
          }
        }
        setSnapLines(lines);
        const next: Record<string, ClipVisual> = {};
        for (const m of d.members) next[m.clipId] = translateVisual(m.start, dx, dy);
        setDraft(next);
        return;
      }

      case "marquee": {
        const r = rectFromPoints(d.from, cp);
        if (!d.moved && r.width * viewport.zoom < 3 && r.height * viewport.zoom < 3) return;
        d.moved = true;
        setMarquee(r);
        const hits = resolvedRef.current ? marqueeHits(resolvedRef.current, r) : [];
        onSelectionChange([...new Set([...d.base, ...hits])]);
        return;
      }

      case "resize":
      case "crop": {
        d.moved = true;
        let p = cp;
        let lines: SnapLine[] = [];
        // Point snapping is only meaningful when the handle moves along composition axes.
        const axisAligned = Math.abs(normalizeAngle(d.start.transform.rotation)) % 90 < 1e-6;
        if (snap && d.targets && axisAligned) ({ point: p, lines } = snapPoint(cp, d.targets, t));
        setSnapLines(lines);
        if (d.type === "resize" && d.text) {
          // Text: handles change LAYOUT (box width/height, or typography on corners) — never stretch glyphs. See lib/text/text-transform.ts.
          const r = textResize({ text: d.text.text, style: d.text.style, visual: d.start, box: d.box, handle: d.handle, pointer: p, fromAnchor: e.altKey, measurer });
          setTextDraft({ [d.clipId]: r.edit });
          return;
        }
        if (d.type === "resize" && d.graphic) {
          const r = graphicResize({ graphic: d.graphic, visual: d.start, box: d.box, handle: d.handle, pointer: p, freeAspect: e.shiftKey, fromAnchor: e.altKey });
          setTextDraft({ [d.clipId]: r.edit });
          return;
        }
        const next =
          d.type === "crop"
            ? cropFromHandle(d.start, d.box, d.handle, p)
            : resizeFromHandle(d.start, d.box, d.handle, p, { keepAspect: isCornerHandle(d.handle) !== e.shiftKey, fromAnchor: e.altKey });
        setDraft({ [d.clipId]: next });
        return;
      }

      case "rotate": {
        d.moved = true;
        let next = rotateFromPointer(d.start, d.startComp, cp, e.shiftKey ? 15 : undefined);
        if (snap && !e.shiftKey) next = applyVisualPatch(next, { transform: { rotation: normalizeAngle(snapAngle(next.transform.rotation, 90, 3)) } });
        setDraft({ [d.clipId]: next });
        return;
      }

      case "anchor": {
        d.moved = true;
        let p = cp;
        if (snap) {
          // Snap to the 9 canonical box points (corners, edge midpoints, center).
          for (const [ax, ay] of ANCHOR_PRESETS) {
            const q = boxToComp(d.start, d.box, { x: ax * d.box.width, y: ay * d.box.height });
            if (Math.hypot(q.x - cp.x, q.y - cp.y) <= t * 1.5) {
              p = q;
              break;
            }
          }
        }
        setDraft({ [d.clipId]: moveAnchorTo(d.start, d.box, p) });
        return;
      }
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setSnapLines([]);
    if (!d || d.type === "pan") return;
    if (d.type === "guide") {
      setGuideDraft(null);
      const sp = screenPoint(e);
      const outside = sp.x < 0 || sp.y < 0 || sp.x > view.width || sp.y > view.height;
      const dropOnRuler = hitRuler(sp) !== null || (d.axis === "y" ? sp.y < RULER_SIZE : sp.x < RULER_SIZE);
      if (d.guideId === null) {
        if (!dropOnRuler && !outside) onAddGuide(d.axis, d.position);
      } else if (dropOnRuler || outside) onRemoveGuide(d.guideId);
      else onMoveGuide(d.guideId, d.position);
      return;
    }
    if (d.type === "marquee") {
      setMarquee(null);
      return;
    }
    if (d.type === "move") {
      if (d.moved) commitDrafts(Object.fromEntries(d.members.map((m) => [m.clipId, m.start])), draft);
    } else if (d.type === "resize" && (d.text || d.graphic)) {
      if (d.moved && textDraft?.[d.clipId]) onCommitEdits?.({ [d.clipId]: textDraft[d.clipId] });
      setTextDraft(null);
    } else if (d.moved) commitDrafts({ [d.clipId]: d.start }, draft);
    setDraft(null);
  };

  // Native, non-passive wheel listener — React's synthetic wheel handler can't preventDefault page scroll.
  const wheelState = useRef({ viewport, applyViewport });
  wheelState.current = { viewport, applyViewport };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { viewport: vp, applyViewport: apply } = wheelState.current;
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) apply(zoomAt(vp, anchor, vp.zoom * Math.exp(-e.deltaY * 0.01), MIN_ZOOM, MAX_ZOOM));
      else apply(pan(vp, -e.deltaX, -e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- keyboard ---
  const center = () => ({ x: view.width / 2, y: view.height / 2 });
  const zoomTo = (z: number) => applyViewport(centerAtZoom(comp, view, z));

  /**
   * Keyboard edits apply to every selected, unlocked, on-screen layer. They
   * accumulate into one draft while keys are held/repeated, then commit as
   * ONE undo step on key release.
   */
  const keyEdit = (fn: (v: ClipVisual) => ClipVisual) => {
    const layers = selectedLayers().filter((l) => !isLocked(l));
    if (layers.length === 0) return;
    let k = keyDraftRef.current;
    if (!k) k = keyDraftRef.current = { starts: {}, visuals: {} };
    for (const l of layers) {
      k.starts[l.clipId] ??= l.visual;
      k.visuals[l.clipId] = fn(k.visuals[l.clipId] ?? l.visual);
    }
    setDraft({ ...k.visuals });
  };
  const flushKeyDraft = () => {
    const k = keyDraftRef.current;
    keyDraftRef.current = null;
    if (!k) return;
    commitDrafts(k.starts, k.visuals);
    setDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingTextClipId) return; // the text editor owns the keyboard
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && selectedClipIds.length === 1 && timeline.clips[selectedClipIds[0]]?.content.kind === "text") {
      const layer = selectedLayer();
      if (layer && !isLocked(layer)) {
        e.preventDefault();
        onEditingTextClipIdChange?.(layer.clipId);
      }
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === " ") {
      setSpaceHeld(true);
      setCursor("grab");
    } else if (e.key.startsWith("Arrow") && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const f = 1 + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 0.1 : 0.01);
      keyEdit((v) => applyVisualPatch(v, { transform: { scaleX: Math.max(0.01, v.transform.scaleX * f), scaleY: Math.max(0.01, v.transform.scaleY * f) } }));
    } else if (e.key.startsWith("Arrow")) {
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      keyEdit((v) => translateVisual(v, dx, dy));
    } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
      const delta = (e.code === "BracketLeft" ? -1 : 1) * (e.shiftKey ? 15 : 1);
      keyEdit((v) => applyVisualPatch(v, { transform: { rotation: normalizeAngle(v.transform.rotation + delta) } }));
    } else if ((e.key === "h" || e.key === "H") && !e.metaKey && !e.ctrlKey) {
      keyEdit((v) => applyVisualPatch(v, { transform: { flipX: !v.transform.flipX } }));
      flushKeyDraft();
    } else if ((e.key === "v" || e.key === "V") && !e.metaKey && !e.ctrlKey) {
      keyEdit((v) => applyVisualPatch(v, { transform: { flipY: !v.transform.flipY } }));
      flushKeyDraft();
    } else if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey) {
      setMode((m) => (m === "crop" ? "transform" : "crop"));
    } else if (e.key === "Escape") {
      if (mode === "crop") setMode("transform");
      else onSelectionChange([]);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
      if (selectedClipIds.length > 0) onDuplicate?.([...selectedClipIds]);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      onSelectionChange((resolvedRef.current?.layers ?? []).filter((l) => !isLocked(l)).map((l) => l.clipId));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedClipIds.length > 0) onDelete?.([...selectedClipIds]);
    } else if (e.key === "f" || e.key === "F") setFitMode(true);
    else if (e.key === "1") zoomTo(1);
    else if (e.key === "+" || e.key === "=") applyViewport(stepZoom(viewport, 1, center()));
    else if (e.key === "-") applyViewport(stepZoom(viewport, -1, center()));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " ") {
      setSpaceHeld(false);
      setCursor("default");
    }
    // Commit once the last held edit key is released (Alt/Shift releases don't end the burst).
    if (e.key.startsWith("Arrow") || e.code === "BracketLeft" || e.code === "BracketRight") flushKeyDraft();
  };

  const zoomPct = Math.round(viewport.zoom * 100);
  const toggleBtn = (active: boolean) => `rounded p-1 ${active ? "bg-primary-500/15 text-primary-600 dark:text-primary-300" : "hover:bg-(--color-bg-subtle)"}`;

  return (
    <div className={`relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-(--color-border) bg-(--color-bg-subtle) ${fullscreen ? "h-screen w-screen rounded-none border-0" : ""} ${className}`}>
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label="Composition preview canvas"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown [ ] H V C Escape F 1 + -"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => !dragRef.current && setHoverId(null)}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => {
          // Double-click a text layer -> TEXT EDIT MODE (object mode otherwise).
          const hit = resolvedRef.current ? hitTest(resolvedRef.current, toComp(screenPoint(e))) : null;
          if (hit && timeline.clips[hit.clipId]?.content.kind === "text" && !isLocked(hit)) {
            onSelectionChange([hit.clipId]);
            setMode("transform");
            onEditingTextClipIdChange?.(hit.clipId);
          }
        }}
        onKeyUp={onKeyUp}
        onBlur={() => {
          setSpaceHeld(false);
          flushKeyDraft();
        }}
        style={{ cursor: dragRef.current?.type === "pan" ? "grabbing" : cursor }}
        className="relative min-h-0 flex-1 touch-none outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60"
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {editingTextClipId && timeline.clips[editingTextClipId]?.content.kind === "text" && (
          <TextEditOverlay
            key={editingTextClipId}
            layoutFor={editingLayerFor}
            initialText={(timeline.clips[editingTextClipId].content as { text?: string }).text ?? ""}
            viewport={viewport}
            accent={colorsRef.current.accent}
            onCommit={(text) => {
              const id = editingTextClipId;
              onEditingTextClipIdChange?.(null);
              onCommitText?.(id, text);
              containerRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-caption">
        <button type="button" onClick={() => setMode("transform")} className={toggleBtn(mode === "transform")} aria-pressed={mode === "transform"} aria-label="Transform tool" title="Transform (move/scale/rotate)">
          <MousePointer2 className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setMode("crop")} className={toggleBtn(mode === "crop")} aria-pressed={mode === "crop"} aria-label="Crop tool" title="Crop (C)">
          <Crop className="h-4 w-4" />
        </button>
        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <button type="button" onClick={() => setSnapping((s) => !s)} className={toggleBtn(snapping)} aria-pressed={snapping} aria-label="Snapping" title="Snapping (hold ⌘/Ctrl to suspend)">
          <Magnet className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setShowGuides((s) => !s)} className={toggleBtn(showGuides)} aria-pressed={showGuides} aria-label="Show guides" title="Show guides (drag from the rulers to add)">
          <Ruler className="h-4 w-4" />
        </button>
        <select
          aria-label="Safe zones"
          value={safeZonePreset}
          onChange={(e) => onSafeZonePresetChange(e.target.value as SafeZonePreset)}
          className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5"
        >
          <option value="off">Safe zones: off</option>
          <option value="broadcast">Broadcast (action/title)</option>
          <option value="social">Social (vertical UI)</option>
        </select>

        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <button type="button" onClick={() => applyViewport(stepZoom(viewport, -1, center()))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label="Zoom out" title="Zoom out (-)">
          <Minus className="h-4 w-4" />
        </button>
        <select
          aria-label="Zoom level"
          value={fitMode ? "fit" : String(viewport.zoom)}
          onChange={(e) => (e.target.value === "fit" ? setFitMode(true) : zoomTo(Number(e.target.value)))}
          className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5 tabular-nums"
        >
          <option value="fit">Fit ({zoomPct}%)</option>
          {!fitMode && ![0.25, 0.5, 1, 2, 4].includes(viewport.zoom) && <option value={String(viewport.zoom)}>{zoomPct}%</option>}
          <option value="0.25">25%</option>
          <option value="0.5">50%</option>
          <option value="1">100%</option>
          <option value="2">200%</option>
          <option value="4">400%</option>
        </select>
        <button type="button" onClick={() => applyViewport(stepZoom(viewport, 1, center()))} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label="Zoom in" title="Zoom in (+)">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setFitMode(true)} className="rounded p-1 hover:bg-(--color-bg-subtle)" aria-label="Fit to screen" title="Fit to screen (F)">
          <Scan className="h-4 w-4" />
        </button>

        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <label className="flex items-center gap-1 text-(--color-text-muted)">
          Preview
          <select
            aria-label="Preview resolution"
            value={quality}
            onChange={(e) => setQuality(e.target.value as PreviewQuality)}
            className="rounded border border-(--color-border) bg-(--color-surface) px-1 py-0.5 text-(--color-text)"
          >
            {(Object.keys(PREVIEW_QUALITY_LABELS) as PreviewQuality[]).map((q) => (
              <option key={q} value={q}>
                {PREVIEW_QUALITY_LABELS[q]}
              </option>
            ))}
          </select>
        </label>
        {stats && (
          <span className="ml-1 tabular-nums text-(--color-text-faint)" data-testid="preview-stats">
            {stats.width}×{stats.height} ({formatScale(stats.scale)}) · {comp.width}×{comp.height} comp · {stats.renderMs.toFixed(1)} ms
            {stats.stats.skipped.length > 0 && ` · ${stats.stats.skipped.length} loading`}
          </span>
        )}

        <button type="button" onClick={toggleFullscreen} className="ml-auto rounded p-1 hover:bg-(--color-bg-subtle)" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen preview"} title="Fullscreen">
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function formatScale(s: number): string {
  if (s >= 0.999) return "full";
  const inv = Math.round(1 / s);
  return Math.abs(1 / inv - s) < 0.01 ? `1/${inv}` : `${Math.round(s * 100)}%`;
}
