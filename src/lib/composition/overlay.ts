import type { ViewportState } from "../matting/pipeline/refine/viewport";
import type { Guide } from "../timeline/model";
import type { Point, Rect } from "./matrix";
import { unionBounds } from "./multi-select";
import type { ResolvedLayer } from "./resolve";
import type { SafeZone } from "./safe-zones";
import type { SnapLine } from "./snap";
import { boxToComp, fullBoxRect, HANDLE_IDS, handleBoxPoint, visibleBoxRect, type HandleId } from "./transform-tools";
import { compositionToScreen, screenToComposition, type Size } from "./viewport";

/**
 * SCREEN-SPACE EDITING CHROME — rulers, guides, safe zones, snap indicators,
 * selection/transform/crop handles. Drawn on the preview's screen canvas
 * after the composition raster, in CSS px x DPR, so it stays crisp at any
 * zoom and can never leak into a render. Handle LAYOUT is exported
 * separately so pointer hit-testing uses exactly the geometry that's drawn.
 */

export const RULER_SIZE = 20;
const HANDLE_SIZE = 8;
const HANDLE_HIT = 9;
const KNOB_OFFSET = 26;
const ROTATE_ZONE = 22;
const GUIDE_HIT = 4;

const COLORS = {
  guide: "#06b6d4",
  snap: "#ec4899",
  safe: "rgba(250, 204, 21, 0.9)",
  rulerBg: "rgba(24,24,27,0.88)",
  rulerTick: "rgba(255,255,255,0.45)",
  rulerText: "rgba(255,255,255,0.75)",
};

export type TransformMode = "transform" | "crop";

export interface SelectionLayout {
  mode: TransformMode;
  /** Screen-space handle positions on the visible (transform) or crop rect. */
  handles: Record<HandleId, Point>;
  /** Screen-space outline of the edited rect (TL, TR, BR, BL). */
  quad: Point[];
  /** Crop mode: outline of the full uncropped box. */
  fullQuad?: Point[];
  anchor: Point;
  /** Rotation knob (transform mode only). */
  knob?: Point;
  /** Knob is drawn on a stem from this point. */
  knobBase?: Point;
}

function toScreen(p: Point, vp: ViewportState): Point {
  return compositionToScreen(p, vp);
}

export function selectionLayout(layer: ResolvedLayer, viewport: ViewportState, mode: TransformMode): SelectionLayout {
  const v = layer.visual;
  const box = layer.box;
  // Transform handles sit on the visible region; crop handles ALSO sit on the visible (crop) rect but edit against the full box.
  const rect = visibleBoxRect(v, box);
  const handles = {} as Record<HandleId, Point>;
  for (const h of HANDLE_IDS) handles[h] = toScreen(boxToComp(v, box, handleBoxPoint(rect, h)), viewport);
  const quad = [handles.nw, handles.ne, handles.se, handles.sw];
  const anchor = toScreen({ x: v.transform.x, y: v.transform.y }, viewport);
  const out: SelectionLayout = { mode, handles, quad, anchor };
  if (mode === "crop") {
    const full = fullBoxRect(box);
    out.fullQuad = (["nw", "ne", "se", "sw"] as const).map((h) => toScreen(boxToComp(v, box, handleBoxPoint(full, h)), viewport));
  } else {
    const center = { x: (handles.nw.x + handles.se.x) / 2, y: (handles.nw.y + handles.se.y) / 2 };
    const n = handles.n;
    let dx = n.x - center.x;
    let dy = n.y - center.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      const r = (v.transform.rotation * Math.PI) / 180;
      dx = Math.sin(r);
      dy = -Math.cos(r);
    } else {
      dx /= len;
      dy /= len;
    }
    out.knobBase = n;
    out.knob = { x: n.x + dx * KNOB_OFFSET, y: n.y + dy * KNOB_OFFSET };
  }
  return out;
}

export type HandleHit =
  | { type: "knob" }
  | { type: "handle"; handle: HandleId }
  | { type: "anchor" }
  | { type: "rotate-zone" }
  | null;

/**
 * Screen-space pick against a selection layout: the NEAREST target within the
 * hit radius wins (ties: knob, then corners, edges, anchor). Nearest — not a
 * fixed priority order — matters on thin layers (a single line of text): its
 * corner handles sit within the hit radius of the side handles, and a
 * corners-first order would make the side handles impossible to grab.
 * Outside every target, a ring just beyond the corners is the rotate zone.
 */
export function hitSelectionHandle(layout: SelectionLayout, p: Point): HandleHit {
  const d = (q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  const candidates: { hit: Exclude<HandleHit, null>; dist: number }[] = [];
  if (layout.knob) candidates.push({ hit: { type: "knob" }, dist: d(layout.knob) });
  for (const h of ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const) candidates.push({ hit: { type: "handle", handle: h }, dist: d(layout.handles[h]) });
  if (layout.mode === "transform") candidates.push({ hit: { type: "anchor" }, dist: d(layout.anchor) });
  let best: (typeof candidates)[number] | null = null;
  for (const c of candidates) if (c.dist <= HANDLE_HIT && (!best || c.dist < best.dist - 1e-9)) best = c;
  if (best) return best.hit;
  if (layout.mode === "transform") {
    for (const h of ["nw", "ne", "se", "sw"] as const) {
      const dist = d(layout.handles[h]);
      if (dist > HANDLE_HIT && dist <= ROTATE_ZONE && !pointInQuad(p, layout.quad)) return { type: "rotate-zone" };
    }
  }
  return null;
}

function pointInQuad(p: Point, q: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if (q[i].y > p.y !== q[j].y > p.y && p.x < ((q[j].x - q[i].x) * (p.y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
  }
  return inside;
}

/** Guide under a screen point (within a few px), or null. */
export function hitGuide(guides: readonly Guide[], viewport: ViewportState, p: Point): Guide | null {
  let best: { g: Guide; dist: number } | null = null;
  for (const g of guides) {
    const s = toScreen(g.axis === "x" ? { x: g.position, y: 0 } : { x: 0, y: g.position }, viewport);
    const dist = g.axis === "x" ? Math.abs(s.x - p.x) : Math.abs(s.y - p.y);
    if (dist <= GUIDE_HIT && (!best || dist < best.dist)) best = { g, dist };
  }
  return best?.g ?? null;
}

/** Which ruler (if any) a screen point is on. The top ruler makes horizontal guides (axis "y"); the left ruler vertical ones (axis "x"). */
export function hitRuler(p: Point): "top" | "left" | null {
  if (p.y < RULER_SIZE && p.x >= RULER_SIZE) return "top";
  if (p.x < RULER_SIZE && p.y >= RULER_SIZE) return "left";
  return null;
}

export interface OverlayOptions {
  viewport: ViewportState;
  view: Size;
  composition: Size;
  devicePixelRatio: number;
  accent: string;
  hover?: ResolvedLayer | null;
  selection?: { layer: ResolvedLayer; mode: TransformMode; locked: boolean } | null;
  /** Two or more selected layers: each gets an outline, plus a dashed group box around their union. No handles. */
  multiSelection?: readonly ResolvedLayer[] | null;
  /** Marquee being dragged, composition px. */
  marquee?: Rect | null;
  guides: readonly Guide[];
  showGuides: boolean;
  highlightGuideId?: string | null;
  safeZones: readonly SafeZone[];
  snapLines: readonly SnapLine[];
  rulers: boolean;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayOptions): void {
  const dpr = o.devicePixelRatio;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setLineDash([]);

  const comp0 = toScreen({ x: 0, y: 0 }, o.viewport);
  const comp1 = toScreen({ x: o.composition.width, y: o.composition.height }, o.viewport);

  // Safe zones
  o.safeZones.forEach((z, i) => {
    const a = toScreen({ x: z.rect.x, y: z.rect.y }, o.viewport);
    const b = toScreen({ x: z.rect.x + z.rect.width, y: z.rect.y + z.rect.height }, o.viewport);
    ctx.strokeStyle = COLORS.safe;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx.setLineDash([]);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = COLORS.safe;
    // Nested zones are only a few px apart: alternate label corners so they never overprint.
    if (i % 2 === 0) {
      ctx.textBaseline = "bottom";
      ctx.fillText(z.label, a.x + 4, b.y - 3);
    } else {
      ctx.textBaseline = "top";
      ctx.fillText(z.label, a.x + 4, a.y + 3);
    }
  });

  // Guides
  if (o.showGuides) {
    for (const g of o.guides) {
      ctx.strokeStyle = COLORS.guide;
      ctx.lineWidth = g.id === o.highlightGuideId ? 2 : 1;
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(toScreen({ x: g.position, y: 0 }, o.viewport).x) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, o.view.height);
      } else {
        const y = Math.round(toScreen({ x: 0, y: g.position }, o.viewport).y) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(o.view.width, y);
      }
      ctx.stroke();
    }
  }

  // Snap indicators
  ctx.strokeStyle = COLORS.snap;
  ctx.lineWidth = 1;
  for (const l of o.snapLines) {
    ctx.setLineDash(l.source === "layer" ? [4, 3] : []);
    ctx.beginPath();
    if (l.axis === "x") {
      const x = Math.round(toScreen({ x: l.position, y: 0 }, o.viewport).x) + 0.5;
      ctx.moveTo(x, Math.min(comp0.y, 0));
      ctx.lineTo(x, Math.max(comp1.y, o.view.height));
    } else {
      const y = Math.round(toScreen({ x: 0, y: l.position }, o.viewport).y) + 0.5;
      ctx.moveTo(Math.min(comp0.x, 0), y);
      ctx.lineTo(Math.max(comp1.x, o.view.width), y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Multi-selection: member outlines + group box.
  if (o.multiSelection && o.multiSelection.length > 1) {
    for (const l of o.multiSelection) strokeQuad(ctx, selectionLayout(l, o.viewport, "transform").quad, o.accent, 1.5, []);
    const u = unionBounds(o.multiSelection.map((l) => l.bounds));
    if (u) {
      const a = toScreen({ x: u.x, y: u.y }, o.viewport);
      const b = toScreen({ x: u.x + u.width, y: u.y + u.height }, o.viewport);
      strokeQuad(ctx, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], o.accent, 1, [5, 4]);
    }
  }

  // Marquee
  if (o.marquee) {
    const a = toScreen({ x: o.marquee.x, y: o.marquee.y }, o.viewport);
    const b = toScreen({ x: o.marquee.x + o.marquee.width, y: o.marquee.y + o.marquee.height }, o.viewport);
    ctx.fillStyle = "rgba(99,102,241,0.12)";
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    strokeQuad(ctx, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], o.accent, 1, []);
  }

  // Hover outline
  const multiIds = new Set((o.multiSelection ?? []).map((l) => l.clipId));
  if (o.hover && o.hover.clipId !== o.selection?.layer.clipId && !multiIds.has(o.hover.clipId)) {
    const lay = selectionLayout(o.hover, o.viewport, "transform");
    strokeQuad(ctx, lay.quad, o.accent, 1, [4, 3]);
  }

  // Selection
  if (o.selection) {
    const lay = selectionLayout(o.selection.layer, o.viewport, o.selection.mode);
    if (lay.fullQuad) strokeQuad(ctx, lay.fullQuad, "rgba(255,255,255,0.7)", 1, [3, 3]);
    strokeQuad(ctx, lay.quad, o.accent, 1.5, []);
    if (!o.selection.locked) {
      if (lay.knob && lay.knobBase) {
        ctx.strokeStyle = o.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lay.knobBase.x, lay.knobBase.y);
        ctx.lineTo(lay.knob.x, lay.knob.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(lay.knob.x, lay.knob.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
      for (const h of HANDLE_IDS) {
        const p = lay.handles[h];
        if (lay.mode === "crop") drawCropHandle(ctx, lay, h, o.accent);
        else {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = o.accent;
          ctx.lineWidth = 1.5;
          ctx.fillRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
          ctx.strokeRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        }
      }
      if (lay.mode === "transform") {
        // Anchor: crosshair in a circle.
        const a = lay.anchor;
        ctx.strokeStyle = o.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
        ctx.moveTo(a.x - 9, a.y);
        ctx.lineTo(a.x + 9, a.y);
        ctx.moveTo(a.x, a.y - 9);
        ctx.lineTo(a.x, a.y + 9);
        ctx.stroke();
      }
    }
  }

  if (o.rulers) drawRulers(ctx, o);
  ctx.restore();
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: Point[], color: string, width: number, dash: number[]) {
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (const p of q.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Crop handles: thick L-shapes at corners and bars at edges, following the layer's rotation. */
function drawCropHandle(ctx: CanvasRenderingContext2D, lay: SelectionLayout, h: HandleId, color: string) {
  const p = lay.handles[h];
  const neighbours: Record<HandleId, HandleId[]> = { nw: ["ne", "sw"], ne: ["nw", "se"], se: ["sw", "ne"], sw: ["se", "nw"], n: ["ne", "nw"], s: ["se", "sw"], e: ["ne", "se"], w: ["nw", "sw"] };
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = "square";
  ctx.beginPath();
  for (const nb of neighbours[h]) {
    const q = lay.handles[nb];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const k = Math.min(12, len / 3) / len;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k);
  }
  ctx.stroke();
  ctx.lineCap = "butt";
}

function rulerStep(zoom: number): number {
  // Smallest 1/2/5 x 10^k composition-px step that is >= 60 screen px apart.
  const raw = 60 / zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function drawRulers(ctx: CanvasRenderingContext2D, o: OverlayOptions) {
  const { view, viewport: vp } = o;
  ctx.fillStyle = COLORS.rulerBg;
  ctx.fillRect(0, 0, view.width, RULER_SIZE);
  ctx.fillRect(0, RULER_SIZE, RULER_SIZE, view.height - RULER_SIZE);
  const step = rulerStep(vp.zoom);
  const minor = step / 5;
  ctx.strokeStyle = COLORS.rulerTick;
  ctx.fillStyle = COLORS.rulerText;
  ctx.lineWidth = 1;
  ctx.font = "9px system-ui, sans-serif";
  ctx.textBaseline = "top";

  const startX = Math.floor(screenToComposition({ x: RULER_SIZE, y: 0 }, vp).x / minor) * minor;
  const endX = screenToComposition({ x: view.width, y: 0 }, vp).x;
  ctx.beginPath();
  for (let c = startX; c <= endX; c += minor) {
    const x = Math.round(toScreen({ x: c, y: 0 }, vp).x) + 0.5;
    if (x < RULER_SIZE) continue;
    const major = Math.abs(c / step - Math.round(c / step)) < 1e-6;
    ctx.moveTo(x, RULER_SIZE);
    ctx.lineTo(x, major ? 4 : RULER_SIZE - 5);
    if (major) ctx.fillText(String(Math.round(c)), x + 2, 2);
  }
  const startY = Math.floor(screenToComposition({ x: 0, y: RULER_SIZE }, vp).y / minor) * minor;
  const endY = screenToComposition({ x: 0, y: view.height }, vp).y;
  for (let c = startY; c <= endY; c += minor) {
    const y = Math.round(toScreen({ x: 0, y: c }, vp).y) + 0.5;
    if (y < RULER_SIZE) continue;
    const major = Math.abs(c / step - Math.round(c / step)) < 1e-6;
    ctx.moveTo(RULER_SIZE, y);
    ctx.lineTo(major ? 4 : RULER_SIZE - 5, y);
    if (major) {
      ctx.save();
      ctx.translate(2, y + 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(String(Math.round(c)), 0, -9);
      ctx.restore();
    }
  }
  ctx.stroke();
  ctx.fillStyle = COLORS.rulerBg;
  ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
}
