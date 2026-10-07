import type { ClipAnimation, KeyframeTrack } from "../animation/keyframes";

/**
 * MASK MODEL (MASK_COMPOSITING_ARCHITECTURE.md §2). Pure data on the clip:
 * `clip.masks` is an ordered list (index = order; each mask combines into the
 * result of the ones above it through its `mode`).
 *
 * COORDINATES: a mask lives in its LAYER's normalized content space (0..1 of
 * the layer's own width/height, y down), so it follows the layer's
 * transform, crop and resize automatically — move/scale/rotate the layer and
 * the mask stays glued to the same part of the picture. The mask's own
 * transform is its box: center (x, y), size (width, height), rotation.
 * Polygon/freeform points are normalized inside that box (0..1), so moving,
 * scaling or rotating a drawn shape is the same five numbers as a rectangle.
 *
 * Feather and expansion are in LAYER pixels (content space: source pixels for
 * media, composition pixels for text/shapes) — they scale with the layer, the
 * way After Effects' mask feather does, and are identical in preview and
 * final renders (the renderer multiplies them by the layer's on-screen scale).
 *
 * Keyframes live in the clip's existing `animation` at `masks.<id>.<param>` —
 * the Phase 8 engine, not a new one (see MASK_PARAMS).
 */

export type MaskShape = "rectangle" | "ellipse" | "polygon" | "freeform";

/** How a mask combines with the masks above it (After Effects / Resolve semantics). */
export type MaskMode = "add" | "subtract" | "intersect" | "difference";

export interface MaskPoint {
  x: number;
  y: number;
}

export interface Mask {
  id: string;
  type: MaskShape;
  mode: MaskMode;
  enabled: boolean;
  /** Keep everything OUTSIDE the shape instead of inside. */
  inverted: boolean;
  /** Box center, normalized layer content space. */
  x: number;
  y: number;
  /** Box size, fraction of the layer's content width/height. */
  width: number;
  height: number;
  /** Degrees, clockwise, about the box center (in layer space, so it composes with the layer's own rotation). */
  rotation: number;
  /** Rectangle only: corner radius as a fraction of the shorter box side (0..0.5). */
  roundness: number;
  /** polygon/freeform only: vertices normalized inside the box (0..1). Closed implicitly. */
  points?: MaskPoint[];
  /** Soft edge width, layer pixels, centered on the (expanded) edge. 0 = crisp antialiased edge. */
  feather: number;
  /** Grows (> 0) or shrinks (< 0) the shape by this many layer pixels, with round corners. */
  expansion: number;
  /** 0..1 — strength of this mask's contribution. */
  opacity: number;
  name?: string;
}

export const MASK_SHAPES: readonly MaskShape[] = ["rectangle", "ellipse", "polygon", "freeform"];
export const MASK_MODES: readonly MaskMode[] = ["add", "subtract", "intersect", "difference"];

export const MASK_LIMITS = {
  /** Generous: a mask box may extend well past the layer (e.g. a soft vignette). */
  position: { min: -10, max: 11 },
  size: { min: 0.001, max: 20 },
  feather: { min: 0, max: 2000 },
  expansion: { min: -2000, max: 2000 },
  /** Freeform strokes are simplified before storing; this bounds hand-edited files. */
  maxPoints: 4096,
} as const;

/** The animatable numeric params (keyframe paths masks.<id>.<param>). Points are edited, not keyframed per vertex (see architecture §9). */
export const MASK_PARAMS = ["x", "y", "width", "height", "rotation", "feather", "expansion", "opacity", "roundness"] as const;
export type MaskParam = (typeof MASK_PARAMS)[number];

export const MASK_PARAM_LABELS: Record<MaskParam, string> = {
  x: "Mask X",
  y: "Mask Y",
  width: "Mask width",
  height: "Mask height",
  rotation: "Mask rotation",
  feather: "Feather",
  expansion: "Expansion",
  opacity: "Mask opacity",
  roundness: "Roundness",
};

export const MASK_PATH_PREFIX = "masks.";

export function maskParamPath(maskId: string, param: MaskParam): string {
  return `${MASK_PATH_PREFIX}${maskId}.${param}`;
}

export function isMaskParam(p: string): p is MaskParam {
  return (MASK_PARAMS as readonly string[]).includes(p);
}

/** "masks.<id>.<param>" -> { maskId, param } (ids never contain dots). */
export function parseMaskPath(path: string): { maskId: string; param: MaskParam } | null {
  if (!path.startsWith(MASK_PATH_PREFIX)) return null;
  const rest = path.slice(MASK_PATH_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const param = rest.slice(dot + 1);
  return isMaskParam(param) ? { maskId: rest.slice(0, dot), param } : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Clamps one param to its valid range (non-finite -> null: a caller bug, rejected by ops). */
export function clampMaskParam(param: MaskParam, value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  switch (param) {
    case "x":
    case "y":
      return clamp(value, MASK_LIMITS.position.min, MASK_LIMITS.position.max);
    case "width":
    case "height":
      return clamp(value, MASK_LIMITS.size.min, MASK_LIMITS.size.max);
    case "feather":
      return clamp(value, MASK_LIMITS.feather.min, MASK_LIMITS.feather.max);
    case "expansion":
      return clamp(value, MASK_LIMITS.expansion.min, MASK_LIMITS.expansion.max);
    case "opacity":
      return clamp(value, 0, 1);
    case "roundness":
      return clamp(value, 0, 0.5);
    case "rotation":
      return value; // not wrapped: animating 0 -> 720 spins twice, like layer rotation
  }
}

export interface MaskPatch {
  type?: MaskShape;
  mode?: MaskMode;
  enabled?: boolean;
  inverted?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  roundness?: number;
  points?: MaskPoint[];
  feather?: number;
  expansion?: number;
  opacity?: number;
  name?: string | null;
}

export class InvalidMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMaskError";
  }
}

function validPoints(raw: unknown): MaskPoint[] | null {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > MASK_LIMITS.maxPoints) return null;
  const out: MaskPoint[] = [];
  for (const p of raw) {
    const x = (p as MaskPoint)?.x;
    const y = (p as MaskPoint)?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

/** Applies a patch with validation: numbers clamped to range, non-finite rejected, path shapes need >= 3 points. */
export function applyMaskPatch(base: Mask, patch: MaskPatch): Mask {
  const next: Mask = { ...base };
  if (patch.type !== undefined) {
    if (!MASK_SHAPES.includes(patch.type)) throw new InvalidMaskError(`Unknown mask shape "${String(patch.type)}".`);
    next.type = patch.type;
  }
  if (patch.mode !== undefined) {
    if (!MASK_MODES.includes(patch.mode)) throw new InvalidMaskError(`Unknown mask mode "${String(patch.mode)}".`);
    next.mode = patch.mode;
  }
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.inverted !== undefined) next.inverted = !!patch.inverted;
  for (const p of MASK_PARAMS) {
    const v = patch[p];
    if (v === undefined) continue;
    const c = clampMaskParam(p, v);
    if (c === null) throw new InvalidMaskError(`Mask ${p} must be a finite number, got ${String(v)}.`);
    next[p] = c;
  }
  if (patch.points !== undefined) {
    const pts = validPoints(patch.points);
    if (!pts) throw new InvalidMaskError(`A mask path needs 3-${MASK_LIMITS.maxPoints} finite points.`);
    next.points = pts;
  }
  if (patch.name !== undefined) {
    if (patch.name === null || patch.name === "") delete next.name;
    else next.name = String(patch.name).slice(0, 80);
  }
  if (isPathShape(next.type)) {
    if (!next.points) throw new InvalidMaskError(`A ${next.type} mask needs points.`);
  } else delete next.points;
  return next;
}

export function isPathShape(type: MaskShape): boolean {
  return type === "polygon" || type === "freeform";
}

/**
 * A new mask of `type`, centered on the layer and covering its middle. Path
 * shapes take their points in normalized LAYER space (what a user draws over
 * the layer); they're re-expressed inside their own bounding box here, so the
 * box becomes the shape's transform.
 */
export function createMask(id: string, type: MaskShape, opts: { layerPoints?: MaskPoint[]; mode?: MaskMode } = {}): Mask {
  const base: Mask = { id, type, mode: opts.mode ?? "add", enabled: true, inverted: false, x: 0.5, y: 0.5, width: 0.6, height: 0.6, rotation: 0, roundness: 0, feather: 0, expansion: 0, opacity: 1 };
  if (!isPathShape(type)) return base;
  const pts = opts.layerPoints ? validPoints(opts.layerPoints) : null;
  if (!pts) {
    if (opts.layerPoints) throw new InvalidMaskError(`A ${type} mask needs at least 3 finite points.`);
    // Default path: a pentagon inscribed in the default box.
    const points = Array.from({ length: 5 }, (_, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / 5;
      return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
    });
    return { ...base, points };
  }
  return { ...base, ...boxFromLayerPoints(pts) };
}

/** Bounding box of layer-space points + the points normalized inside it (degenerate axes get a tiny size so nothing divides by 0). */
export function boxFromLayerPoints(pts: readonly MaskPoint[]): { x: number; y: number; width: number; height: number; points: MaskPoint[] } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = Math.max(MASK_LIMITS.size.min, x1 - x0);
  const h = Math.max(MASK_LIMITS.size.min, y1 - y0);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: w, height: h, points: pts.map((p) => ({ x: (p.x - x0) / w, y: (p.y - y0) / h })) };
}

/** Validates one mask from untrusted data (project files); null if unusable. */
export function normalizeMask(raw: unknown): Mask | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.includes(".")) return null;
  if (!MASK_SHAPES.includes(r.type as MaskShape)) return null;
  const base = createMask(r.id, r.type as MaskShape);
  try {
    return applyMaskPatch(base, {
      mode: (r.mode ?? "add") as MaskMode,
      enabled: typeof r.enabled === "boolean" ? r.enabled : true,
      inverted: r.inverted === true,
      ...Object.fromEntries(MASK_PARAMS.filter((p) => r[p] !== undefined).map((p) => [p, r[p]])),
      ...(isPathShape(r.type as MaskShape) ? { points: r.points as MaskPoint[] } : {}),
      ...(typeof r.name === "string" ? { name: r.name } : {}),
    });
  } catch {
    return null;
  }
}

/** The keyframe tracks that animate one mask's params (a view over the clip's animation). */
export function maskKeyframes(animation: ClipAnimation | undefined, maskId: string): Partial<Record<MaskParam, KeyframeTrack>> {
  const out: Partial<Record<MaskParam, KeyframeTrack>> = {};
  for (const [path, track] of Object.entries(animation?.tracks ?? {})) {
    const p = parseMaskPath(path);
    if (p?.maskId === maskId) out[p.param] = track;
  }
  return out;
}

/** Reduces a hand-drawn stroke (layer-normalized points) to the vertices that matter — Ramer–Douglas–Peucker with `tolerance` in the same units. */
export function simplifyStroke(points: readonly MaskPoint[], tolerance: number): MaskPoint[] {
  if (points.length <= 3) return points.map((p) => ({ ...p }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const d = len > 0 ? Math.abs(dy * (p.x - pa.x) - dx * (p.y - pa.y)) / len : Math.hypot(p.x - pa.x, p.y - pa.y);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
  return out.length >= 3 ? out : points.slice(0, 3).map((p) => ({ ...p }));
}
